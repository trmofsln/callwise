import policy from "../ml/retry/retry-policy.json";
import type { CallWindow, PredictionContext, RetryApproach, RetryStep, SchedulingSettings } from "./best-time-types";
import { candidateWindows, dynamicGap, localParts } from "./best-time-policy";
import { retryDecay, stageLabel } from "./seller-factors";

// Data-driven retry ladder. After each unanswered attempt it compares two kinds of retry:
//  - an interval after the miss (+15, +30 ... +240 minutes), and
//  - the next best calling slot later that day or on a following day,
// and picks the one with the most expected meetings per attempt:
//    P(answer) x P(meeting | answered) x per-day urgency discount.
// P(answer) comes from 415k observed ERP retries (ml/retry/retry-policy.json), by how many misses
// came before, how long the rep waited, the seller's answer-propensity tier and the hour; it is then
// adjusted by this seller's own answer history at that hour. Calling rules, attempt caps, appointments
// and a callback time the seller asked for always apply.

type Stat = { n: number; answered: number; rate: number | null };
type Policy = {
  window: { from: string; to: string }; volumes: { retries: number };
  curve_by_attempt: Record<string, Record<string, Stat>>; curve_pooled: Record<string, Stat>;
  seller_tiers: Record<string, { overall: Stat; by_bucket: Record<string, Stat> }>;
  retry_hour: Record<string, Stat & { factor: number }>;
  meeting_after_contact_by_bucket: Record<string, Stat>;
};
const P = policy as unknown as Policy;
export const RETRY_POLICY_SOURCE = `${P.volumes.retries.toLocaleString("en-IN")} ERP retries after an unanswered call, ${P.window.from} to ${P.window.to}`;
export const RETRY_INTERVALS = [15, 30, 45, 60, 90, 120, 180, 240];
const MINUTE_BUCKETS: [number, number, string][] = [[0, 8, "5m"], [8, 22, "15m"], [22, 37, "30m"], [37, 52, "45m"], [52, 75, "60m"], [75, 105, "90m"], [105, 150, "120m"], [150, 210, "180m"], [210, 300, "240m"], [300, 1440, "later_same_day"]];
/** "after 15 minutes", "later the same day", "the next day". */
const BUCKET_TEXT: Record<string, string> = { "5m": "after 5 minutes", "15m": "after 15 minutes", "30m": "after 30 minutes", "45m": "after 45 minutes", "60m": "after an hour", "90m": "after 1.5 hours", "120m": "after 2 hours", "180m": "after 3 hours", "240m": "after 4 hours", later_same_day: "later the same day", next_day: "the next day", "2_3_days": "2 to 3 days later", "4_7_days": "4 to 7 days later" };
const DAY = 86_400_000;
const pct = (p: number) => `${Math.round(p * 100)}%`;
const num = (n: number) => n.toLocaleString("en-IN");
const ordinal = (n: number) => ["first", "second", "third", "fourth", "fifth"][n - 1] ?? `${n}th`;

export function retryBucket(fromMs: number, atMs: number, tz: string): string | null {
  const days = Math.round((Date.parse(`${localParts(atMs, tz).date}T00:00:00Z`) - Date.parse(`${localParts(fromMs, tz).date}T00:00:00Z`)) / DAY);
  if (days === 0) { const gap = (atMs - fromMs) / 60_000; return MINUTE_BUCKETS.find(([lo, hi]) => gap >= lo && gap < hi)?.[2] ?? null; }
  return days === 1 ? "next_day" : days <= 3 ? "2_3_days" : days <= 7 ? "4_7_days" : null;
}

export type Propensity = { tier: "low" | "mid" | "high" | "unknown"; rate: number | null; calls: number; answered: number };
export function sellerPropensity(context: PredictionContext): Propensity {
  const h = context.seller_history, calls = h?.timed_calls ?? 0, answered = h?.answered_calls ?? 0;
  if (calls < 5) return { tier: "unknown", rate: calls ? answered / calls : null, calls, answered };
  const rate = answered / calls;
  return { tier: rate < 0.25 ? "low" : rate < 0.5 ? "mid" : "high", rate, calls, answered };
}

const kGroup = (k: number) => k >= 4 ? "4+" : String(Math.max(1, k));
/** This seller's own answer rate at an hour relative to their overall rate, shrunk toward 1 with 5 pseudo-calls. */
function sellerHourFactor(context: PredictionContext, prop: Propensity, hour: number): { factor: number; calls: number; answered: number } {
  const slot = context.seller_history?.slots.find(s => s.hour === hour);
  if (!slot || prop.rate === null || prop.rate <= 0 || prop.calls < 5) return { factor: 1, calls: slot?.calls ?? 0, answered: slot?.answered_calls ?? 0 };
  const smoothed = (slot.answered_calls + 5 * prop.rate) / (slot.calls + 5);
  return { factor: Math.max(0.7, Math.min(1.4, smoothed / prop.rate)), calls: slot.calls, answered: slot.answered_calls };
}

export type Estimate = { bucket: string; p_answer: number; p_meeting: number; base: Stat; tier_rate: number; attempt_ratio: number; hour_factor: number; seller_hour: { factor: number; calls: number; answered: number } };
export function estimateRetry(context: PredictionContext, prop: Propensity, misses: number, fromMs: number, atMs: number): Estimate | null {
  const bucket = retryBucket(fromMs, atMs, context.timezone);
  if (!bucket) return null;
  const pooled = P.curve_pooled[bucket], attempt = P.curve_by_attempt[kGroup(misses)]?.[bucket];
  const tier = P.seller_tiers[prop.tier]?.by_bucket[bucket];
  if (!pooled?.rate || !attempt?.rate) return null;
  const tierRate = tier?.rate && tier.n >= 300 ? tier.rate : pooled.rate;
  const attemptRatio = attempt.rate / pooled.rate;
  const hour = localParts(atMs, context.timezone).hour, hourFactor = P.retry_hour[String(hour)]?.factor ?? 1;
  const sellerHour = sellerHourFactor(context, prop, hour);
  const p = Math.max(0.01, Math.min(0.95, tierRate * attemptRatio * hourFactor * sellerHour.factor));
  return { bucket, p_answer: p, p_meeting: P.meeting_after_contact_by_bucket[bucket]?.rate ?? 0.1, base: attempt, tier_rate: tierRate, attempt_ratio: attemptRatio, hour_factor: hourFactor, seller_hour: sellerHour };
}

/** The context as it would be right after a planned attempt at `at` goes unanswered. */
export function projectMiss(context: PredictionContext, at: string, settings: SchedulingSettings): PredictionContext {
  const atMs = Date.parse(at);
  const calls = context.scheduling_calls ? [...context.scheduling_calls, { at, answered: false }] : undefined;
  const lastAnswer = calls?.filter(c => c.answered).at(-1), since = Math.max(atMs - settings.sequenceDays * DAY, lastAnswer ? Date.parse(lastAnswer.at) + 1 : -Infinity);
  const today = localParts(atMs, context.timezone).date;
  return { ...context, as_of: at, prior_calls: context.prior_calls + 1, last_call_at: at, last_unanswered_at: at, scheduling_calls: calls, not_before: null,
    recent_attempts: calls ? calls.filter(c => Date.parse(c.at) >= since).length : context.recent_attempts + 1,
    attempts_today: calls ? calls.filter(c => localParts(c.at, context.timezone).date === today).length : (localParts(context.as_of, context.timezone).date === today ? context.attempts_today : 0) + 1 };
}

/** Unanswered attempts in a row before `at`; as in the retry data, a gap over 7 days starts a new sequence. */
function missesBefore(context: PredictionContext, at: number): number {
  let n = 0, next = at;
  const calls = context.scheduling_calls ?? [];
  for (let i = calls.length - 1; i >= 0 && !calls[i].answered && next - Date.parse(calls[i].at) <= 7 * DAY; i--) { n++; next = Date.parse(calls[i].at); }
  return n;
}

const clock = (ms: number, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(ms)).toUpperCase();
const dayClock = (ms: number, tz: string, anchor: number) => `${localParts(ms, tz).date === localParts(anchor, tz).date ? "" : `${new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(ms))}, `}${clock(ms, tz)}`;
const hourText = (h: number) => `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;

export type RetryOption = { at: number; end: number; strategy: RetryStep["strategy"]; minutes: number; est: Estimate; value: number; label: string; requested: boolean };

/**
 * Every retry option for the attempt after `prev` (state = context right after that attempt missed):
 * each allowed interval and each allowed slot, scored by expected meetings per attempt and ranked.
 * While a time the seller asked for is ahead or under way, only options inside it are kept.
 */
export function retryOptions(context: PredictionContext, state: PredictionContext, prev: number, misses: number, settings: SchedulingSettings, anchor: number, horizonDays = 3): { ranked: RetryOption[]; floor: { minutes: number; reason: string }; stop: string | null } {
  const tz = context.timezone, prop = sellerPropensity(context), decay = retryDecay(context.seller_factors);
  const ladderSettings = { ...settings, horizonDays: Math.max(settings.horizonDays, horizonDays) };
  const floor = dynamicGap(state, settings);
  const windows = candidateWindows(state, ladderSettings).filter(w => Date.parse(w.start) >= prev + floor.minutes * 60_000 - 1);
  if (!windows.length) return { ranked: [], floor, stop: state.do_not_call ? "Calling is blocked for this seller." : `No further retry fits the calling rules and attempt limits within ${ladderSettings.horizonDays} days.` };
  const inside = (t: number) => windows.some(w => Date.parse(w.start) <= t && t + 10 * 60_000 <= Date.parse(w.end));
  const windowEnd = (t: number) => Math.min(t + 3_600_000, Math.max(...windows.filter(w => Date.parse(w.start) <= t && t < Date.parse(w.end)).map(w => Date.parse(w.end))));
  const cb = context.conversation?.callback, cbStart = cb ? Date.parse(cb.at) : NaN, cbEnd = cb ? (cb.end ? Date.parse(cb.end) : cbStart + 3_600_000) : NaN;
  const options: RetryOption[] = [];
  const add = (at: number, end: number, strategy: RetryStep["strategy"], label: string, minutes = Math.round((at - prev) / 60_000)) => {
    const est = estimateRetry(context, prop, misses, prev, at);
    if (!est || options.some(o => o.at === at)) return;
    const days = Math.max(0, Math.round((Date.parse(`${localParts(at, tz).date}T00:00:00Z`) - Date.parse(`${localParts(anchor, tz).date}T00:00:00Z`)) / DAY));
    const requested = Number.isFinite(cbEnd) && at >= cbStart && at < cbEnd;
    options.push({ at, end, strategy: requested && strategy === "best_slot" ? "seller_requested" : strategy, minutes, est, value: est.p_answer * est.p_meeting * decay ** days, label, requested });
  };
  for (const m of RETRY_INTERVALS) {
    const at = Math.ceil((prev + m * 60_000) / 60_000) * 60_000; // whole minutes, like calling windows
    if (m >= floor.minutes && inside(at)) add(at, windowEnd(at), "interval", `+${m} min`, m);
  }
  for (const w of windows) add(Date.parse(w.start), Date.parse(w.end), "best_slot", dayClock(Date.parse(w.start), tz, anchor));
  const within = Number.isFinite(cbEnd) && prev < cbEnd ? options.filter(o => o.requested) : [];
  const pool = within.length ? within : options;
  if (!pool.length) return { ranked: [], floor, stop: "No retry option has data support within the calling rules." };
  return { ranked: [...pool].sort((a, b) => b.value - a.value || a.at - b.at), floor, stop: null };
}

/** Plain label for an option, e.g. "+15 min (7:45 PM)" or "Tue, 6 Oct, 11:00 AM". */
export function optionLabel(o: RetryOption, tz: string, anchor: number): string {
  return o.strategy === "interval" ? `${o.label} (${dayClock(o.at, tz, anchor)})` : o.label;
}

/** A ladder step for a chosen option, with the strongest alternatives it was compared against. */
export function stepFor(context: PredictionContext, i: number, best: RetryOption, ranked: RetryOption[], misses: number, prev: number, floor: { minutes: number; reason: string }, anchor: number, reach: number): RetryStep {
  const tz = context.timezone;
  const alternatives = ranked.filter(o => o !== best && o.at !== best.at).filter((o, idx, list) => idx < 2 || (o.strategy !== best.strategy && !list.slice(0, idx).some(x => x.strategy === o.strategy))).slice(0, 3)
    .map(o => ({ label: optionLabel(o, tz, anchor), p_answer: round(o.est.p_answer), value: round(o.value / Math.max(best.value, 1e-9)) }));
  return describe(i, best, alternatives, misses, prev, floor, sellerPropensity(context), context, anchor, reach);
}

/**
 * Plan up to `steps` retries after an attempt at `anchorAt` (the recommended call, or a call just
 * made). `initialMisses` is how many unanswered attempts in a row precede the first retry;
 * `firstRetry`/`priorMiss` continue a ladder whose earlier retries were chosen elsewhere.
 */
export function retryLadder(context: PredictionContext, anchorAt: string, settings: SchedulingSettings, { steps = 4, initialMisses, horizonDays = 3, firstRetry = 1, priorMiss = 1, ladderAnchor }: { steps?: number; initialMisses?: number; horizonDays?: number; firstRetry?: number; priorMiss?: number; ladderAnchor?: string } = {}): { steps: RetryStep[]; approach: RetryApproach | null; stop: string | null } {
  const anchor = Date.parse(ladderAnchor ?? anchorAt), out: RetryStep[] = [];
  let state = projectMiss(context, anchorAt, settings), prev = Date.parse(anchorAt), misses = (initialMisses ?? missesBefore(context, Date.parse(anchorAt)) + 1), reachMiss = priorMiss, stop: string | null = null;
  for (let i = firstRetry; i < firstRetry + steps; i++) {
    const { ranked, floor, stop: blocked } = retryOptions(context, state, prev, misses, settings, anchor, horizonDays);
    if (!ranked.length) { stop = blocked; break; }
    const best = ranked[0];
    reachMiss *= 1 - best.est.p_answer;
    out.push(stepFor(context, i, best, ranked, misses, prev, floor, anchor, 1 - reachMiss));
    state = projectMiss(state, new Date(best.at).toISOString(), settings);
    prev = best.at; misses++;
  }
  return { steps: out, approach: out.length ? retryApproach(out, sellerPropensity(context), context, { ...settings, horizonDays: Math.max(settings.horizonDays, horizonDays) }, stop) : null, stop };
}
const round = (n: number) => Math.round(n * 1000) / 1000;

function describe(i: number, o: RetryOption, alternatives: RetryStep["alternatives"], misses: number, prev: number, floor: { minutes: number; reason: string }, prop: Propensity, context: PredictionContext, anchor: number, reach: number): RetryStep {
  const tz = context.timezone, e = o.est, hour = localParts(o.at, tz).hour, when = dayClock(o.at, tz, anchor);
  const title = o.strategy === "interval" ? `Interval: +${o.minutes} min` : o.strategy === "seller_requested" ? "Seller's requested time" : `Next best slot`;
  const why = o.strategy === "interval"
    ? `${o.minutes} minutes after the ${ordinal(misses)} miss: ${ordinal(misses)} retries made ${BUCKET_TEXT[e.bucket]} were answered ${pct(e.base.rate!)} in ERP data (n=${num(e.base.n)}).`
    : o.strategy === "seller_requested"
      ? `Inside the time the seller asked for${context.conversation?.callback?.label ? ` (${context.conversation.callback.label})` : ""}; within it, the strongest moment by data.`
      : `${when}: ${alternatives.length && !alternatives.some(a => /^\+/.test(a.label)) ? "no short interval fits the calling rules or daily limit here" : "beats a short interval for this seller"}; retries made ${BUCKET_TEXT[e.bucket]} were answered ${pct(e.base.rate!)} (n=${num(e.base.n)}).`;
  const evidence = [
    `Estimated answer chance ${pct(o.est.p_answer)}: ${prop.tier === "unknown" ? "all sellers" : `${prop.tier}-propensity sellers`} answer ${pct(e.tier_rate)} of retries made ${BUCKET_TEXT[e.bucket]}${e.attempt_ratio < 0.97 || e.attempt_ratio > 1.03 ? `, x${e.attempt_ratio.toFixed(2)} for a ${ordinal(misses)} retry` : ""}${e.hour_factor < 0.97 || e.hour_factor > 1.03 ? `, x${e.hour_factor.toFixed(2)} at ${hourText(hour)}` : ""}${e.seller_hour.factor !== 1 ? `, x${e.seller_hour.factor.toFixed(2)} as this seller answered ${e.seller_hour.answered} of ${e.seller_hour.calls} calls at ${hourText(hour)}` : ""}.`,
    `If answered, ${pct(e.p_meeting)} of such contacts led to a successful meeting within 14 days.`,
    ...(alternatives.length ? [`Compared: ${alternatives.map(a => `${a.label} ${pct(a.p_answer)}`).join(", ")}.`] : []),
    ...(floor.minutes > 15 && !/configured minimum/.test(floor.reason) ? [`Minimum wait ${floor.minutes} min: ${floor.reason}.`] : []),
    `Chance of having reached the seller by this retry: ${pct(reach)}.`,
  ];
  return { retry: i, at: new Date(o.at).toISOString(), window_end: new Date(o.end).toISOString(), strategy: o.strategy, after_minutes: o.minutes, bucket: e.bucket, misses_before: misses,
    p_answer: round(e.p_answer), p_meeting_if_answered: round(e.p_meeting), cumulative_reach: round(reach), title, reason: why, evidence, alternatives };
}

export function retryApproach(steps: RetryStep[], prop: Propensity, context: PredictionContext, settings: SchedulingSettings, stop: string | null): RetryApproach {
  const kinds = new Set(steps.map(s => s.strategy));
  const strategy: RetryApproach["strategy"] = steps[0].strategy === "seller_requested" ? "seller_time_first" : kinds.size === 1 && kinds.has("interval") ? "interval_first" : kinds.size === 1 && kinds.has("best_slot") ? "best_slot_first" : steps[0].strategy === "interval" ? "interval_first" : "mixed";
  const k1 = P.curve_by_attempt["1"], tier = P.seller_tiers[prop.tier]?.by_bucket ?? {};
  const meet = P.meeting_after_contact_by_bucket;
  const intervals = steps.filter(s => s.strategy === "interval").map(s => `+${s.after_minutes} min`);
  const summary = strategy === "seller_time_first" ? "Call at the time the seller asked for, then retry at short intervals while they are likely near the phone."
    : strategy === "interval_first" ? `Retry at short intervals (${[...new Set(intervals)].join(", ")}) while the seller is likely near the phone${kinds.has("best_slot") ? ", then move to the next best slot" : ""}.`
    : strategy === "best_slot_first" ? "Wait for this seller's best slots instead of short intervals." : "Mix short intervals and best slots, step by step, whichever has the better data.";
  const pointers = [
    `Retry timing data: ${RETRY_POLICY_SOURCE}. A first retry was answered ${pct(k1["15m"].rate!)} after 15 minutes (n=${num(k1["15m"].n)}) against ${pct(k1["5m"].rate!)} after an immediate 5-minute redial (n=${num(k1["5m"].n)}), ${pct(k1["60m"].rate!)} after an hour and ${pct(k1.next_day.rate!)} the next day (n=${num(k1.next_day.n)}).`,
    prop.tier === "unknown" ? `This seller has ${prop.calls} timed calls on record, too few for a propensity tier, so all-seller rates are used.`
      : `This seller answered ${prop.answered} of ${prop.calls} calls (${pct(prop.rate!)}), a ${prop.tier}-propensity seller. Such sellers answered ${pct(tier["15m"]?.rate ?? 0)} of retries after 15 minutes against ${pct(tier.next_day?.rate ?? 0)} the next day${prop.tier === "high" ? ", so timing matters less and a strong slot can win" : ", so short intervals matter more"}.`,
    `Meetings: a contact made 15 to 45 minutes after a miss led to a successful meeting ${pct(meet["15m"].rate!)}–${pct(meet["45m"].rate!)} of the time, against ${pct(meet.next_day.rate!)} the next day and ${pct(meet["4_7_days"].rate!)} after 4 to 7 days, so waiting costs meetings, not just answers.`,
    `Answer chances fall with each miss: retries after 15 minutes were answered ${pct(k1["15m"].rate!)}, ${pct(P.curve_by_attempt["2"]["15m"].rate!)}, ${pct(P.curve_by_attempt["3"]["15m"].rate!)} and ${pct(P.curve_by_attempt["4+"]["15m"].rate!)} for the first to fourth retry.`,
  ];
  const f = context.seller_factors;
  if (f) pointers.push(f.urgency.level === "high" ? `Business urgency: ${f.urgency.reasons.join(", ")}; each day of delay is discounted 25%.` : f.urgency.level === "give_space" ? `Give space: ${f.urgency.reasons.join(", ")}; delays are discounted only 3% a day.` : `${stageLabel(f.stage).replace(/^./, c => c.toUpperCase())} seller with no deadline or risk signal: each day of delay is discounted 10%.`);
  if (steps.some(s => s.strategy === "best_slot") && steps.some(s => s.strategy === "interval")) pointers.push(`At most ${settings.maxAttemptsPerDay} attempts a day and only within calling hours, so some retries move to the next best slot.`);
  pointers.push(`Chance of reaching the seller across these ${steps.length} retries: ${pct(steps.at(-1)!.cumulative_reach)}${stop ? `. ${stop}` : ""}.`);
  return { strategy, summary, pointers, source: RETRY_POLICY_SOURCE };
}

/** The window object for a ladder step, for code that expects a CallWindow. */
export function stepWindow(step: RetryStep, timezone: string): CallWindow {
  return { id: step.at, start: step.at, end: step.window_end, timezone, score: null, score_target: null, support: 0, uncertainty: null };
}
