import { kv } from "./kv";
import type { PredictionContext, RetryApproach, RetryStep, SchedulingSettings } from "./best-time-types";
import type { RecordingAnalysis, SentimentResult } from "./recording-types";
import type { GlobalContextResult } from "./global-context-catalog";
import type { UserLookup, UserProfile } from "./user-types";
import { dynamicGap, localParts, zonedInstant } from "./best-time-policy";
import { predictionContext } from "./best-time-context";
import { estimateRetry, retryApproach, retryLadder, retryOptions, RETRY_POLICY_SOURCE, sellerPropensity, stepFor, type RetryOption } from "./retry-ladder";
import { getAdminStore } from "./sqlite";
import { chatModel, classifySentiment, NO_CONVERSATION, sarvamConfigured, SarvamError, sarvamJson } from "./sarvam";
import { callDay } from "./recordings";
import { stageLabel, type SellerFactors } from "./seller-factors";

// After a call that did not succeed, plan the retry with an LLM (Sarvam sarvam-105b). The rules
// engine first lists the windows that are allowed (calling rules, attempt caps, the dynamic wait,
// any callback the client asked for) and scores them; the LLM then reads the call transcript,
// the seller's business factors and that shortlist, picks the window and the exact time, and
// writes the reason. Its choice is checked against the shortlist; anything else falls back to
// the rules engine's choice.

export const CALL_OUTCOMES = ["no_answer", "answered", "callback", "not_interested"] as const;
export type CallOutcome = typeof CALL_OUTCOMES[number];
const OUTCOME_TEXT: Record<CallOutcome, string> = { no_answer: "The call was not answered", answered: "The seller answered but no meeting was booked", callback: "The seller asked to be called back", not_interested: "The seller said they were not interested" };
const TIMEZONE = "Asia/Kolkata";

export type RetryCandidate = { id: string; start: string; end: string; label: string; strategy: RetryStep["strategy"]; minutes_after_call: number; p_answer: number; p_meeting_if_answered: number; evidence: string; seller_requested: boolean; impact: number };
export type AiRetryPlan = {
  glid: string; outcome: CallOutcome; called_at: string; generated_at: string;
  status: "planned" | "stop" | "no_window";
  this_call: RecordingAnalysis | null;
  factors: SellerFactors | null;
  call_at: string | null; window: { start: string; end: string; label: string; seller_requested: boolean } | null;
  reason: string; factors_used: string[];
  source: "llm" | "rules"; model: string | null; llm_note: string | null;
  minimum_gap_minutes: number | null; gap_reason: string | null;
  rules_choice: { call_at: string; label: string } | null;
  candidates: RetryCandidate[];
  /** Retry 1 as chosen, then retries 2-4 planned from it with retry data. */
  ladder: RetryStep[];
  approach: RetryApproach | null;
};

export type RetryRequest = { lookupId: string | null; glid: string; outcome: CallOutcome; transcript: string; calledAt: string };

export function parseRetryRequest(input: unknown, asOf: string): RetryRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Request body must be an object.");
  const raw = input as Record<string, unknown>;
  const glid = String(raw.glid ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(glid)) throw new Error("Provide one valid GLID.");
  const outcome = CALL_OUTCOMES.find(o => o === raw.outcome);
  if (!outcome) throw new Error(`outcome must be one of ${CALL_OUTCOMES.join(", ")}.`);
  const transcript = typeof raw.transcript === "string" ? raw.transcript.replace(/\r\n/g, "\n").trim() : "";
  if (transcript.length > 8000) throw new Error("The transcript is longer than 8000 characters.");
  const lookupId = typeof raw.lookupId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.lookupId) ? raw.lookupId : null;
  let calledAt = asOf;
  if (typeof raw.calledAt === "string" && raw.calledAt) {
    const t = Date.parse(raw.calledAt);
    if (!Number.isFinite(t) || t > Date.parse(asOf) + 5 * 60_000 || Date.parse(asOf) - t > 2 * 86_400_000) throw new Error("calledAt must be within the last two days.");
    calledAt = new Date(Math.min(t, Date.parse(asOf))).toISOString();
  }
  return { lookupId, glid, outcome, transcript, calledAt };
}

/** The seller's record from the lookup this queue was built from (saved by lookupUsers), so planning needs no second ERP query. */
async function savedLookup(lookupId: string | null, glid: string): Promise<Pick<UserLookup, "users" | "globalContexts"> | null> {
  if (!lookupId) return null;
  try {
    const saved = await kv().get<{ user: UserProfile; globalContext: GlobalContextResult | null }>(`lookup:${lookupId}:${glid}`);
    return saved ? { users: [saved.user], globalContexts: saved.globalContext ? [saved.globalContext] : [] } : null;
  } catch { return null; }
}

/** When there is no transcript, the logged outcome itself is the only evidence about the call. */
export function outcomeOnly(outcome: CallOutcome, glid: string, calledAt: string): RecordingAnalysis {
  const result: SentimentResult = outcome === "no_answer" ? { ...NO_CONVERSATION, summary: "The call was not answered." }
    : outcome === "callback" ? { ...NO_CONVERSATION, sentiment: "busy_callback", summary: "The seller asked to be called back (logged by the caller, no transcript)." }
    : outcome === "not_interested" ? { ...NO_CONVERSATION, sentiment: "not_interested", score: -0.6, summary: "The seller said they were not interested (logged by the caller, no transcript)." }
    : { ...NO_CONVERSATION, sentiment: "neutral", summary: "The seller answered but no meeting was booked (logged by the caller, no transcript)." };
  return { call_id: `outcome-${Date.parse(calledAt)}`, glid, called_at: calledAt, duration_seconds: null, vendor: "Logged outcome", source_kind: "manual", status: "analyzed", status_detail: "No transcript; based on the logged outcome.", result, language: null, transcript_chars: 0, stt_model: null, chat_model: null, analyzed_at: new Date().toISOString() };
}

/** The prediction context as it stands right after the unsuccessful call. */
export function contextAfterCall(base: PredictionContext, calledAt: string, answered: boolean, settings: SchedulingSettings): PredictionContext {
  const calls = [...(base.scheduling_calls ?? []), { at: calledAt, answered }].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const lastAnswer = calls.filter(c => c.answered).at(-1), now = Date.parse(base.as_of);
  const since = Math.max(now - settings.sequenceDays * 86_400_000, lastAnswer ? Date.parse(lastAnswer.at) + 1 : -Infinity);
  const today = localParts(now, base.timezone).date;
  const context: PredictionContext = { ...base, scheduling_calls: calls, prior_calls: base.prior_calls + 1, last_call_at: calledAt, last_unanswered_at: answered ? null : calledAt,
    recent_attempts: calls.filter(c => Date.parse(c.at) >= since).length, attempts_today: calls.filter(c => localParts(c.at, base.timezone).date === today).length };
  context.not_before = new Date(Date.parse(calledAt) + dynamicGap(context, settings).minutes * 60_000).toISOString();
  return context;
}

const hhmm = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: TIMEZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const clock = (iso: string, tz: string) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).toUpperCase();
export function windowLabel(start: string, end: string, tz = TIMEZONE): string {
  return `${new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(new Date(start))}, ${clock(start, tz)} to ${clock(end, tz)}`;
}
/** Misses in a row before the next attempt: after an unanswered call, the streak; after an answered one, treat it as a first retry. */
export function missesAfterCall(context: PredictionContext): number {
  let n = 0;
  const calls = context.scheduling_calls ?? [];
  for (let i = calls.length - 1; i >= 0 && !calls[i].answered; i--) n++;
  return Math.max(1, n);
}

/** Data-scored retry options after the call (intervals and best slots), the shortlist for the LLM, and the rules choice. */
export function retryShortlist(context: PredictionContext, settings: SchedulingSettings, calledAt: string): { candidates: RetryCandidate[]; rules: RetryCandidate | null; ranked: RetryOption[]; misses: number; floor: { minutes: number; reason: string }; stop: string | null } {
  const prev = Date.parse(calledAt), misses = missesAfterCall(context);
  const { ranked, floor, stop } = retryOptions(context, context, prev, misses, settings, prev, settings.horizonDays);
  const best = ranked[0]?.value || 1;
  const toCandidate = (o: RetryOption): RetryCandidate => ({ id: new Date(o.at).toISOString(), start: new Date(o.at).toISOString(), end: new Date(o.end).toISOString(), label: o.strategy === "interval" ? `${o.label} after the call (${windowLabel(new Date(o.at).toISOString(), new Date(o.end).toISOString(), context.timezone)})` : windowLabel(new Date(o.at).toISOString(), new Date(o.end).toISOString(), context.timezone),
    strategy: o.strategy, minutes_after_call: o.minutes, p_answer: Math.round(o.est.p_answer * 100) / 100, p_meeting_if_answered: Math.round(o.est.p_meeting * 100) / 100,
    evidence: `${o.requested ? "the seller asked for this time; " : ""}retries made ${o.est.bucket.replace("_", " ")} after a miss were answered ${Math.round((o.est.base.rate ?? 0) * 100)}% (n=${o.est.base.n})`, seller_requested: o.requested, impact: Math.round((o.value / best) * 100) / 100 });
  // Best by expected meetings, plus the best of each kind and the earliest, so the LLM sees the real trade-off.
  const picked = new Map<number, RetryOption>();
  const firstOf = (kind: RetryStep["strategy"]) => ranked.find(o => o.strategy === kind);
  for (const o of [...ranked.slice(0, 8), firstOf("interval"), firstOf("best_slot"), firstOf("seller_requested"), [...ranked].sort((a, b) => a.at - b.at)[0]]) if (o && picked.size < 12) picked.set(o.at, o);
  return { candidates: [...picked.values()].sort((a, b) => a.at - b.at).map(toCandidate), rules: ranked[0] ? toCandidate(ranked[0]) : null, ranked, misses, floor, stop };
}

const SYSTEM_PROMPT = [
  "You plan when an IndiaMART sales representative should call a seller again after a call that did not succeed.",
  "You get: the outcome of the call just made, its transcript (often Hindi and English mixed) and Sarvam's analysis of it, the seller's business factors",
  "(industry segment, lifecycle stage such as new onboarding, renewal or upsell, last successful meeting, complaints and churn risk, platform activity),",
  "their answer history, the minimum wait, and a shortlist of allowed retry options from the scheduling rules. Each option is either an interval after the call (+15, +30 ... minutes),",
  "the next best slot later, or the seller's requested time, with a data estimate from ERP retry history: answer chance, meeting chance if answered, and impact_score",
  "(expected meetings per attempt relative to the best option, already discounted for delay by business urgency).",
  "Choose exactly one window from the shortlist and a call time inside it. Rules:",
  "1. If any window is marked seller_requested, choose one of those: the seller's own request comes first. Among several requested windows, prefer the one with the strongest evidence.",
  "2. Otherwise weigh what the seller said and the business factors: momentum (new onboarding, renewal deadline, churn risk, positive interest) favours an earlier strong window;",
  "complaints, frustration or a refusal favour giving space; a decision maker who was unavailable favours a time they are likely to be in.",
  "3. Otherwise prefer the highest impact_score: retry data shows short intervals usually reach more sellers and lead to more meetings than waiting a day.",
  "Never choose an option that is not in the shortlist. For an interval option the time is fixed at its from time. In the reason, say why this interval or time beats the alternatives, citing the data numbers given.",
  "4. Cite only facts present in the input. Use the lifecycle stage exactly as given; never call a seller new onboarding, renewal or upsell unless all_stages says so.",
  "The representative's pitch in the transcript is not the seller's interest: judge interest from the seller's own words and Sarvam's analysis.",
  "Reply with one compact JSON object and nothing else:",
  '{"window_id": the id of the chosen window, "time": "HH:MM" 24-hour local time between that window\'s from and until,',
  ' "reason": two or three short plain-English sentences for the representative explaining why this time, citing what the seller said or the outcome and the factors that mattered (no names, phone numbers or company names; no promises about outcomes),',
  ' "factors_used": up to 4 short labels of the factors that decided it}',
].join("\n");

/** Check the LLM's choice against the shortlist. Throws when it cannot be used. */
export function parseRetryChoice(content: string, candidates: RetryCandidate[], tz = TIMEZONE): { window: RetryCandidate; call_at: string; reason: string; factors_used: string[]; clamped: boolean } {
  const start = content.indexOf("{"), end = content.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The LLM returned no JSON.");
  const raw = JSON.parse(content.slice(start, end + 1)) as Record<string, unknown>;
  const window = candidates.find(c => c.id === raw.window_id);
  if (!window) throw new Error("The LLM chose a window outside the allowed shortlist.");
  if (candidates.some(c => c.seller_requested) && !window.seller_requested) throw new Error("The LLM ignored the time the seller asked for.");
  const reason = typeof raw.reason === "string" ? raw.reason.replace(/\s+/g, " ").trim().slice(0, 700) : "";
  if (reason.length < 20) throw new Error("The LLM returned no usable reason.");
  let callAt = Date.parse(window.start), clamped = false;
  // An interval option means exactly that interval after the call; only slots let the LLM pick the minute.
  const m = window.strategy !== "interval" && typeof raw.time === "string" ? /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw.time.trim()) : null;
  if (window.strategy === "interval") clamped = false;
  else if (m) {
    const at = zonedInstant(localParts(window.start, tz).date, Number(m[1]), tz) + Number(m[2]) * 60_000;
    if (at >= Date.parse(window.start) && at < Date.parse(window.end)) callAt = at; else clamped = true;
  } else clamped = true;
  const factors = Array.isArray(raw.factors_used) ? raw.factors_used.filter((f): f is string => typeof f === "string").map(f => f.replace(/_+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 4) : [];
  return { window, call_at: new Date(callAt).toISOString(), reason, factors_used: factors, clamped };
}

function llmInput(req: RetryRequest, context: PredictionContext, thisCall: RecordingAnalysis | null, gap: { minutes: number; reason: string }, candidates: RetryCandidate[], rules: RetryCandidate | null): string {
  const p = sellerPropensity(context), propensity = { tier: p.tier, answered: p.answered, calls: p.calls };
  const f = context.seller_factors, r = thisCall?.result, conv = context.conversation, h = context.seller_history;
  const hours = (h?.slots ?? []).filter(s => s.calls > 0).sort((a, b) => b.answered_calls - a.answered_calls || b.calls - a.calls).slice(0, 5)
    .map(s => ({ hour: `${s.hour % 12 || 12} ${s.hour < 12 ? "AM" : "PM"}`, answered: s.answered_calls, calls: s.calls, meetings: s.linked_meetings }));
  return JSON.stringify({
    now: `${callDay(context.as_of)} ${clock(context.as_of, TIMEZONE)}`, timezone: context.timezone,
    call_just_made: { outcome: req.outcome, description: OUTCOME_TEXT[req.outcome], at: clock(req.calledAt, TIMEZONE), transcript: req.transcript ? req.transcript.slice(0, 6000) : null },
    sarvam_analysis_of_this_call: r ? { sentiment: r.sentiment, score: r.score, summary: r.summary, callback_requested: r.callback.requested, callback_words: r.callback.when_text, callback_resolved: conv?.callback?.label ?? null, key_points: r.key_points ?? [], objections: r.objections, meeting_intent: r.meeting_intent, from_transcript: !!thisCall?.chat_model } : null,
    earlier_calls: conv ? { analysed: conv.analyzed, sentiments: conv.counts, average_score: conv.average_score } : null,
    seller_factors: f ? { industry_segment: f.segment.vertical, products: f.segment.products, customer_type: f.segment.customer_type, service: f.segment.service, plan: f.segment.plan,
      lifecycle_stage: stageLabel(f.stage), all_stages: f.stages.map(stageLabel), days_into_service: f.service_days,
      last_successful_meeting: f.last_successful_meeting ? { days_ago: f.last_successful_meeting.days_ago, purpose: f.last_successful_meeting.purpose, mode: f.last_successful_meeting.mode } : null,
      recent_call_purpose: f.recent_purpose?.purpose ?? null, high_churn_risk: f.risk.high_churn, complaints_last_7_days: f.risk.complaints_7d, open_tickets: f.risk.open_tickets, payment_issue: f.risk.payment_issue,
      buylead_active_days_last_month: f.engagement.buylead_active_days_30, retry_urgency: f.urgency } : null,
    history: { calls: h?.timed_calls ?? context.prior_calls, answered: h?.answered_calls ?? null, best_hours: hours },
    rules: { minimum_wait_minutes: gap.minutes, why_this_wait: gap.reason, attempts_in_current_sequence: context.recent_attempts },
    retry_data: { source: RETRY_POLICY_SOURCE, seller_answer_propensity: propensity },
    rules_engine_choice: rules ? { window_id: rules.id, label: rules.label } : null,
    shortlist: candidates.map(c => ({ id: c.id, option: c.label, strategy: c.strategy, minutes_after_call: c.minutes_after_call, from: hhmm(c.start), until: hhmm(c.end), answer_chance: c.p_answer, meeting_chance_if_answered: c.p_meeting_if_answered, evidence: c.evidence, seller_requested: c.seller_requested, impact_score: c.impact })),
  });
}

function rulesReason(req: RetryRequest, thisCall: RecordingAnalysis | null, step: RetryStep): string {
  const r = thisCall?.result;
  const said = r && thisCall?.chat_model ? ` Sarvam rated the call ${r.sentiment.replace(/_/g, " ")}: ${r.summary.replace(/\.$/, "")}.` : "";
  return `${OUTCOME_TEXT[req.outcome]}.${said} ${step.title}: ${step.reason} ${step.evidence[0]}`.replace(/\s+/g, " ").trim();
}

export async function planRetryAfterCall(req: RetryRequest, asOf = new Date().toISOString(), { useLlm = true } = {}): Promise<AiRetryPlan> {
  let lookup: Pick<UserLookup, "users" | "globalContexts"> | null = await savedLookup(req.lookupId, req.glid);
  if (!lookup?.users.some(u => u.glid === req.glid)) {
    const { lookupUsers } = await import("./user-lookup");
    lookup = await lookupUsers([req.glid]);
  }
  const user = lookup.users.find(u => u.glid === req.glid);
  if (!user) throw new Error("No ERP user record was found for this GLID.");
  const global: GlobalContextResult | undefined = lookup.globalContexts?.find(g => g.glid === req.glid);

  // 1. What happened on the call: Sarvam reads the transcript; without one, the logged outcome stands in.
  let thisCall: RecordingAnalysis | null = outcomeOnly(req.outcome, req.glid, req.calledAt);
  let llmNote: string | null = null;
  if (req.transcript.length >= 15) {
    try {
      if (!sarvamConfigured()) throw new SarvamError("Set SARVAM_API_KEY in .env.");
      const result = await classifySentiment(req.transcript, { calledOn: callDay(req.calledAt) });
      thisCall = { ...thisCall, call_id: `retry-${Date.parse(req.calledAt)}`, vendor: "This call · transcript", status_detail: null, result, transcript_chars: req.transcript.length, chat_model: chatModel() };
    } catch (error) { llmNote = `Transcript analysis failed (${error instanceof Error ? error.message : "Sarvam error"}); the logged outcome was used instead.`; }
  }

  // 2. The rules engine: context after this call, allowed windows over the next week, scored by impact.
  const stored = await getAdminStore().readPredictionSettings();
  const settings: SchedulingSettings = { ...stored, horizonDays: Math.max(stored.horizonDays, 7) };
  const withCall: UserProfile = { ...user, recordingAnalyses: [thisCall, ...(user.recordingAnalyses ?? []).filter(a => a.called_at !== req.calledAt)] };
  let context = contextAfterCall(predictionContext(req.glid, withCall, asOf, settings, global), req.calledAt, req.outcome !== "no_answer", settings);
  // A later time the seller asked for ("after five days", "month end") must stay reachable for the retry: look that far ahead, up to 45 days.
  const asked = context.conversation?.callback;
  if (asked) {
    const reach = Math.ceil((Date.parse(asked.end ?? asked.at) - Date.parse(asOf)) / 86_400_000) + 1;
    if (reach > settings.horizonDays) { settings.horizonDays = Math.min(45, reach); context = contextAfterCall(predictionContext(req.glid, withCall, asOf, settings, global), req.calledAt, req.outcome !== "no_answer", settings); }
  }
  const gap = dynamicGap(context, settings);
  const base = { glid: req.glid, outcome: req.outcome, called_at: req.calledAt, generated_at: new Date().toISOString(), this_call: thisCall, factors: context.seller_factors ?? null, minimum_gap_minutes: gap.minutes, gap_reason: gap.reason };
  if (context.do_not_call) return { ...base, ladder: [], approach: null, status: "stop", call_at: null, window: null, reason: context.conversation?.asked_not_to_call ? "The seller asked not to be called again, so no retry is planned." : "A do-not-call mark blocks any retry.", factors_used: [], source: "rules", model: null, llm_note: llmNote, rules_choice: null, candidates: [] };
  const { candidates, rules, ranked, misses, floor, stop } = retryShortlist(context, settings, req.calledAt);
  const empty = { ladder: [] as RetryStep[], approach: null };
  if (!rules) return { ...base, ...empty, status: "no_window", call_at: null, window: null, reason: `${stop ?? "No retry fits the calling rules."} (minimum wait ${gap.minutes} minutes: ${gap.reason}).`, factors_used: [], source: "rules", model: null, llm_note: llmNote, rules_choice: null, candidates };
  const rulesPlan = { call_at: rules.start, label: rules.label };
  const prev = Date.parse(req.calledAt);

  // The full ladder from the first retry: retry 1 as chosen (by the LLM or the rules), then retries 2-4 by data.
  const ladderFrom = (atIso: string, optionId: string) => {
    const at = Date.parse(atIso), option = ranked.find(o => o.at === at) ?? (() => {
      const host = ranked.find(o => new Date(o.at).toISOString() === optionId) ?? ranked.find(o => o.at <= at && at < o.end)!, est = estimateRetry(context, sellerPropensity(context), misses, prev, at) ?? host.est;
      return { ...host, at, minutes: Math.round((at - prev) / 60_000), est, label: host.strategy === "interval" ? `+${Math.round((at - prev) / 60_000)} min` : host.label };
    })();
    const first = stepFor(context, 1, option, ranked, misses, prev, floor, prev, option.est.p_answer);
    const rest = retryLadder(context, atIso, settings, { steps: 3, initialMisses: misses + 1, horizonDays: settings.horizonDays, firstRetry: 2, priorMiss: 1 - option.est.p_answer, ladderAnchor: req.calledAt });
    const steps = [first, ...rest.steps];
    return { ladder: steps, approach: retryApproach(steps, sellerPropensity(context), context, settings, rest.stop) };
  };

  // 3. The LLM picks the option and minute from the shortlist and explains it; the rules engine is the fallback.
  if (useLlm && sarvamConfigured()) {
    try {
      const choice = parseRetryChoice(await sarvamJson(SYSTEM_PROMPT, llmInput(req, context, thisCall, gap, candidates, rules), { maxTokens: 900, timeoutMs: 45_000 }), candidates);
      return { ...base, ...ladderFrom(choice.call_at, choice.window.id), status: "planned", call_at: choice.call_at, window: { start: choice.window.start, end: choice.window.end, label: choice.window.label, seller_requested: choice.window.seller_requested }, reason: choice.reason, factors_used: choice.factors_used, source: "llm", model: chatModel(), llm_note: choice.clamped ? "The suggested minute fell outside the option's window, so its start is used." : llmNote, rules_choice: rulesPlan, candidates };
    } catch (error) {
      llmNote = `The LLM plan could not be used (${error instanceof Error ? error.message : "error"}); the rules engine chose the time.`;
    }
  } else if (useLlm) llmNote = "Sarvam is not configured; the rules engine chose the time.";
  const plan = ladderFrom(rules.start, rules.id);
  return { ...base, ...plan, status: "planned", call_at: rules.start, window: { start: rules.start, end: rules.end, label: rules.label, seller_requested: rules.seller_requested }, reason: rulesReason(req, thisCall, plan.ladder[0]), factors_used: [], source: "rules", model: null, llm_note: llmNote, rules_choice: rulesPlan, candidates };
}
