import type { Prediction, RankingStrategy } from "@/lib/best-time-types";
import { findContextSegment, parseContextValue, type GlobalContextResult } from "@/lib/global-context-catalog";
import type { Interaction, UserLookup, UserProfile } from "@/lib/user-types";

export type QueueStatus = "now" | "today" | "upcoming" | "blocked";
export type ConfidenceLevel = Prediction["confidence"]["level"];

/** One seller as the call queue sees it: only fields the backend actually returns. */
export type SellerRow = {
  glid: string;
  name: string | null;
  company: string | null;
  city: string | null;
  customerType: string | null;
  reps: string[];
  user: UserProfile | null;
  prediction: Prediction | null;
  context: GlobalContextResult | null;
  status: QueueStatus;
  windowStart: number | null;
  windowEnd: number | null;
  confidence: ConfidenceLevel;
  strategy: RankingStrategy;
  lastCall: Interaction | null;
  lastOutcome: string | null;
  calls: number;
  answeredCalls: number;
  successfulMeetings: number;
  conversion: number | null;
};

const ANSWERED = /^(answered|talked)/i;
const NOW_LEAD_MS = 15 * 60_000;

export function isAnswered(event: Interaction): boolean {
  return ANSWERED.test(event.outcome ?? "") || ANSWERED.test(event.status ?? "");
}

export function outcomeLabel(event: Interaction | null): string | null {
  if (!event) return null;
  const raw = event.outcome || event.status;
  if (!raw) return null;
  return raw === "NotAnswered" ? "Not answered" : raw.charAt(0).toUpperCase() + raw.slice(1);
}

function contextField(context: GlobalContextResult | undefined, keys: string[]): string | null {
  if (!context || context.status !== "success") return null;
  const segment = parseContextValue(findContextSegment(context.data, "kycdetails"));
  const visit = (value: unknown, depth: number): string | null => {
    if (!value || typeof value !== "object" || depth > 4) return null;
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && (typeof child === "string" || typeof child === "number") && String(child).trim()) return String(child).trim();
    }
    for (const child of Object.values(value)) {
      const found = visit(parseContextValue(child), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return visit(segment, 0);
}

export function statusOf(prediction: Prediction | null, now: number): { status: QueueStatus; start: number | null; end: number | null } {
  const window = prediction?.recommended_window;
  if (!window) return { status: "blocked", start: null, end: null };
  const start = Date.parse(window.start), end = Date.parse(window.end);
  if (start - NOW_LEAD_MS <= now && now < end) return { status: "now", start, end };
  const tz = prediction!.timezone;
  const day = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  return { status: day(start) === day(now) && start > now ? "today" : "upcoming", start, end };
}

export function buildRows(result: UserLookup, now: number): SellerRow[] {
  const predictions = new Map((result.predictions ?? []).map(p => [p.glid, p]));
  const contexts = new Map((result.globalContexts ?? []).map(c => [c.glid, c]));
  const users = new Map(result.users.map(u => [u.glid, u]));
  const glids = [...new Set([...result.users.map(u => u.glid), ...result.missingGlids, ...predictions.keys()])];
  return glids.map(glid => {
    const user = users.get(glid) ?? null, prediction = predictions.get(glid) ?? null, context = contexts.get(glid);
    const { status, start, end } = statusOf(prediction, now);
    const calls = user?.activity.calls ?? [];
    const companyRecord = user?.company[0];
    return {
      glid, user, prediction, context: context ?? null, status, windowStart: start, windowEnd: end,
      name: contextField(context, ["customer_name"]) ?? ([contextField(context, ["first_name"]), contextField(context, ["last_name"])].filter(Boolean).join(" ") || null),
      company: contextField(context, ["company_name"]),
      city: contextField(context, ["city"]) ?? (companyRecord?.city ? String(companyRecord.city) : null),
      customerType: user?.customerType ?? null,
      reps: [...new Set((user?.assignments ?? []).flatMap(a => a.employee?.name ? [a.employee.name] : []))],
      confidence: prediction?.confidence.level ?? "insufficient",
      strategy: prediction?.ranking_strategy ?? "operating_hours",
      lastCall: user?.activity.lastCall ?? null,
      lastOutcome: outcomeLabel(user?.activity.lastCall ?? null),
      calls: user?.activity.metrics.callCount ?? 0,
      answeredCalls: calls.filter(isAnswered).length,
      successfulMeetings: user?.activity.metrics.successfulMeetingCount ?? 0,
      conversion: user?.activity.metrics.callToMeetingPercent ?? null,
    };
  });
}

const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { very_high: 0, high: 1, moderate: 2, insufficient: 3 };
const STATUS_RANK: Record<QueueStatus, number> = { now: 0, today: 1, upcoming: 2, blocked: 3 };

export type SortKey = "time" | "confidence" | "history" | "recent" | "conversion";
export const SORTS: { key: SortKey; label: string }[] = [
  { key: "time", label: "Best time to call" },
  { key: "confidence", label: "Confidence" },
  { key: "history", label: "Most call history" },
  { key: "recent", label: "Most recently contacted" },
  { key: "conversion", label: "Call → meeting rate" },
];

export function sortRows(rows: SellerRow[], key: SortKey): SellerRow[] {
  const byTime = (a: SellerRow, b: SellerRow) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.windowStart ?? Infinity) - (b.windowStart ?? Infinity);
  const last = (r: SellerRow) => (r.lastCall?.at ? Date.parse(r.lastCall.at) : -Infinity) || -Infinity;
  const cmp: Record<SortKey, (a: SellerRow, b: SellerRow) => number> = {
    time: (a, b) => byTime(a, b) || CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence],
    confidence: (a, b) => CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence] || byTime(a, b),
    history: (a, b) => b.calls - a.calls || byTime(a, b),
    recent: (a, b) => last(b) - last(a) || byTime(a, b),
    conversion: (a, b) => (b.conversion ?? -1) - (a.conversion ?? -1) || byTime(a, b),
  };
  return [...rows].sort((a, b) => cmp[key](a, b) || a.glid.localeCompare(b.glid));
}

/** The single seller to call next: due now first, then the earliest later-today window, higher confidence breaking ties. */
export function nextBestCall(rows: SellerRow[], loggedToday: Set<string>): SellerRow | null {
  const candidates = rows.filter(r => (r.status === "now" || r.status === "today") && !loggedToday.has(r.glid));
  return sortRows(candidates, "time")[0] ?? null;
}

export function relativeWindow(row: SellerRow, now: number): { label: string; detail: string } {
  const p = row.prediction;
  if (!p?.recommended_window || row.windowStart === null || row.windowEnd === null) {
    const retry = p?.retry_plan.status;
    return { label: "No eligible window", detail: retry === "stop" ? "Retries stopped (do-not-call or caps)" : p ? p.routing_reason.replaceAll("_", " ") : "No prediction returned" };
  }
  const tz = p.timezone;
  const time = (t: number) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(t);
  const day = (t: number) => new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(t);
  if (row.status === "now") return row.windowStart <= now
    ? { label: "Call now", detail: `Window open until ${time(row.windowEnd)}` }
    : { label: `Starts ${time(row.windowStart)}`, detail: `In ${Math.max(1, Math.round((row.windowStart - now) / 60_000))} min · until ${time(row.windowEnd)}` };
  const mins = Math.round((row.windowStart - now) / 60_000);
  const inText = mins < 60 ? `in ${mins} min` : mins < 1440 ? `in ${Math.floor(mins / 60)} h ${mins % 60 ? `${mins % 60} min` : ""}`.trim() : null;
  if (row.status === "today") return { label: `Today ${time(row.windowStart)}`, detail: `${inText} · until ${time(row.windowEnd)}` };
  const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now + 86_400_000) === new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(row.windowStart);
  return { label: `${tomorrow ? "Tomorrow" : day(row.windowStart)} ${time(row.windowStart)}`, detail: `until ${time(row.windowEnd)}` };
}

export function displayName(row: SellerRow): string {
  return row.company || row.name || `GLID ${row.glid}`;
}

/** Answered share of these sellers' historical calls, by local hour (calls with a recorded start only). */
export function answerRateByHour(rows: SellerRow[], timezone = "Asia/Kolkata") {
  const hours = new Map<number, { calls: number; answered: number }>();
  for (const row of rows) for (const call of row.user?.activity.calls ?? []) {
    if (!call.startedAt) continue;
    // ERP timestamps are naive local (IST) wall time; read the hour directly unless an offset is present.
    const naive = /^\d{4}-\d{2}-\d{2}[T ](\d{2}):/.exec(call.startedAt);
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(call.startedAt);
    let hour: number;
    if (naive && !hasOffset) hour = Number(naive[1]);
    else {
      const t = Date.parse(call.startedAt);
      if (Number.isNaN(t)) continue;
      hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hour12: false }).format(t)) % 24;
    }
    const bucket = hours.get(hour) ?? { calls: 0, answered: 0 };
    bucket.calls++; if (isAnswered(call)) bucket.answered++;
    hours.set(hour, bucket);
  }
  return [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([hour, v]) => ({ hour, ...v }));
}
