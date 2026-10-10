import { findContextSegment, parseContextValue, type GlobalContextResult } from "./global-context-catalog";
import type { Interaction, UserProfile } from "./user-types";
import type { ConversationSignals } from "./recording-types";

// Business factors about the seller that shape how urgently to retry an unsuccessful call:
// industry segment, lifecycle stage (new onboarding, renewal, upsell, servicing), the last
// successful meeting, and risk signals. Built from the ERP history and the Global Context API.
// Only derived, non-identifying values are kept (no names, emails or phone numbers), so the
// factors can be shown in the UI and sent to the retry LLM.

export type LifecycleStage = "new_onboarding" | "renewal" | "upsell" | "servicing" | "prospect";
export type RetryUrgency = "high" | "normal" | "give_space";

export type SellerFactors = {
  segment: { vertical: string | null; products: string[]; customer_type: string | null; service: string | null; plan: string | null };
  stage: LifecycleStage;
  /** Every stage that applies, most important first. */
  stages: LifecycleStage[];
  service_days: number | null;
  last_successful_meeting: { at: string; days_ago: number; purpose: string | null; mode: string | null } | null;
  recent_purpose: { purpose: string; at: string } | null;
  risk: { high_churn: boolean; complaints_7d: number; open_tickets: number; payment_issue: string | null };
  engagement: { buylead_active_days_30: number | null };
  urgency: { level: RetryUrgency; reasons: string[] };
};

const DAY = 86_400_000;
const STAGE_LABEL: Record<LifecycleStage, string> = { new_onboarding: "new onboarding", renewal: "renewal", upsell: "upsell", servicing: "servicing", prospect: "prospect" };
export const stageLabel = (stage: LifecycleStage) => STAGE_LABEL[stage];

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s && !/^(none|null|na|n\/a|0)$/i.test(s) ? s.slice(0, 80) : null;
}
function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}
function obj(value: unknown): Record<string, unknown> {
  const parsed = parseContextValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}
function path(source: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), source);
}

/** "0 year 2 months and 14 days" -> 74. */
export function vintageDays(value: unknown): number | null {
  const s = str(value);
  if (!s) return null;
  const pick = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  const years = pick(/(\d+)\s*y/i), months = pick(/(\d+)\s*m/i), days = pick(/(\d+)\s*d/i);
  return /\d/.test(s) ? years * 365 + months * 30 + days : null;
}

function productNames(activity: Record<string, unknown>): string[] {
  const top = parseContextValue(activity.top3mcat_data);
  const first = Array.isArray(top) ? obj(top[0]) : {};
  const list = parseContextValue(first.mcat_list);
  return Array.isArray(list) ? list.map(m => str(obj(m).mcat_name)).filter((m): m is string => !!m).slice(0, 3) : [];
}

function stageOf(purpose: string): LifecycleStage | null {
  if (/welcome/i.test(purpose)) return "new_onboarding";
  if (/renewal/i.test(purpose)) return "renewal";
  if (/upsell/i.test(purpose)) return "upsell";
  if (/servic|engagement|feedback/i.test(purpose)) return "servicing";
  return null;
}

export function sellerFactors(user: UserProfile | undefined, global: GlobalContextResult | undefined, asOf: string, conversation?: ConversationSignals | null): SellerFactors | null {
  if (!user && global?.status !== "success") return null;
  const now = Date.parse(asOf);
  const data = global?.status === "success" ? global.data : null;
  const kyc = obj(findContextSegment(data, "kycdetails")), activity = obj(findContextSegment(data, "activitydetails")), tickets = obj(findContextSegment(data, "ticketsdetails"));

  const interactions: Interaction[] = [...(user?.activity?.calls ?? []), ...(user?.activity?.meetings ?? [])]
    .filter(i => i.at && i.purpose && !/^Purpose \d+$/.test(i.purpose) && Date.parse(i.at) <= now)
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  const within = (i: Interaction, days: number) => now - Date.parse(i.at!) <= days * DAY;
  const recent = interactions.find(i => within(i, 90)) ?? null;

  const serviceDays = vintageDays(kyc.SERVICE_VINTAGE);
  const nach = Array.isArray(parseContextValue(kyc.nach_status)) ? obj((parseContextValue(kyc.nach_status) as unknown[])[0]) : {};
  const nachText = str(nach.DIS_TEXT);
  const paymentIssue = nachText && /stop|fail|issue|bounce/i.test(nachText) ? nachText : null;
  const paid = /paid/i.test(String(kyc.customer_type ?? user?.customerType ?? ""));

  const stages: LifecycleStage[] = [];
  const add = (stage: LifecycleStage | null) => { if (stage && !stages.includes(stage)) stages.push(stage); };
  if ((serviceDays !== null && serviceDays <= 90) || interactions.some(i => within(i, 60) && /welcome/i.test(i.purpose!))) add("new_onboarding");
  if (paymentIssue || str(kyc.renewal_date) || interactions.some(i => within(i, 60) && /renewal/i.test(i.purpose!))) add("renewal");
  if (interactions.some(i => within(i, 60) && /upsell/i.test(i.purpose!))) add("upsell");
  if (recent) add(stageOf(recent.purpose!));
  if (!stages.length) add(paid || user?.activity?.metrics?.successfulMeetingCount ? "servicing" : "prospect");

  const met = user?.activity?.lastSuccessfulMeeting;
  const lastMeeting = met?.at && Date.parse(met.at) <= now ? { at: met.at, days_ago: Math.floor((now - Date.parse(met.at)) / DAY), purpose: met.purpose, mode: met.mode } : null;
  const highChurn = /^(true|yes|1)$/i.test(String(kyc.high_churn ?? ""));
  const complaints = (num(path(tickets, "last_7_days.irate_complaint_count")) ?? 0) + (num(path(tickets, "last_7_days.negative_feedback_count")) ?? 0) + (num(path(tickets, "last_7_days.whatsapp_negative_feedback_count")) ?? 0);
  const wip = parseContextValue(kyc.WIP_TICKET_BUCKET);
  const blDays = num(path(activity, "last_month.bl_active_days")) ?? num(kyc.bl_active_dau_30);

  // Urgency: momentum and deadlines call for a sooner retry; complaints and a negative call call for space.
  const reasons: string[] = [], space: string[] = [];
  if (complaints > 0) space.push(`${complaints} complaint${complaints === 1 ? "" : "s"} or negative feedback in the last 7 days`);
  if (conversation?.recent_negative) space.push("the last conversation was negative");
  if (stages.includes("new_onboarding")) reasons.push(serviceDays !== null && serviceDays <= 90 ? `new onboarding (${serviceDays} days into the service)` : "new onboarding (recent welcome call)");
  if (stages.includes("renewal")) reasons.push(paymentIssue ? `renewal at risk (${paymentIssue.toLowerCase()})` : "renewal in progress");
  if (highChurn) reasons.push("flagged as high churn risk");
  if (stages.includes("upsell") && (conversation?.latest?.score ?? 0) > 0) reasons.push("upsell conversation with a positive client");
  if (conversation?.meeting_intent) reasons.push("the client showed meeting intent");
  const level: RetryUrgency = space.length ? "give_space" : reasons.length ? "high" : "normal";

  return {
    segment: { vertical: str(kyc.vertical_name) ?? user?.assignments?.find(a => a.vertical?.name)?.vertical?.name ?? null, products: productNames(activity), customer_type: str(kyc.customer_type) ?? user?.customerType ?? null, service: str(kyc.highest_service), plan: str(kyc.payment_plan) },
    stage: stages[0], stages, service_days: serviceDays, last_successful_meeting: lastMeeting,
    recent_purpose: recent ? { purpose: recent.purpose!, at: recent.at! } : null,
    risk: { high_churn: highChurn, complaints_7d: complaints, open_tickets: Array.isArray(wip) ? wip.length : 0, payment_issue: paymentIssue },
    engagement: { buylead_active_days_30: blDays },
    urgency: { level, reasons: level === "give_space" ? space : reasons },
  };
}

/** Per-day discount applied when trading slot strength against calling sooner. */
export function retryDecay(factors: SellerFactors | null | undefined): number {
  return factors?.urgency.level === "high" ? 0.75 : factors?.urgency.level === "give_space" ? 0.97 : 0.9;
}

/** One plain sentence for retry reasons and the LLM, e.g. "New onboarding in Business Intelligence; last met 12 days ago". */
export function factorSummary(f: SellerFactors | null | undefined): string {
  if (!f) return "";
  const parts = [`${STAGE_LABEL[f.stage].replace(/^./, c => c.toUpperCase())} seller${f.segment.vertical ? ` in ${f.segment.vertical}` : ""}${f.segment.products.length ? ` (${f.segment.products.join(", ")})` : ""}`];
  if (f.last_successful_meeting) parts.push(`last successful meeting ${f.last_successful_meeting.days_ago === 0 ? "today" : `${f.last_successful_meeting.days_ago} days ago`}`);
  else parts.push("no successful meeting yet");
  return parts.join("; ");
}
