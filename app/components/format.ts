import type { CallWindow, Prediction, RankingStrategy } from "@/lib/best-time-types";

export function when(value: string, timezone: string, withDate = true) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: timezone,
    ...(withDate ? ({ weekday: "short", day: "numeric", month: "short" } as const) : {}),
    hour: "numeric", minute: "2-digit",
  }).format(new Date(value));
}

export function duration(minutes: number) {
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), mins = minutes % 60;
  return [days ? `${days} ${days === 1 ? "day" : "days"}` : "", hours ? `${hours} h` : "", mins ? `${mins} min` : ""].filter(Boolean).join(" ") || "0 min";
}

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export const STRATEGY_LABEL: Record<RankingStrategy, string> = {
  seller_meetings: "Seller's meeting history",
  seller_answers: "Seller's answer history",
  generalized_model: "General timing model",
  canonical_model: "Meeting model",
  operating_hours: "Calling hours",
};

export const STRATEGY_BASIS: Record<RankingStrategy, string> = {
  seller_meetings: "Ranked by this seller's calls that led to meetings, adjusted for very short calls.",
  seller_answers: "Ranked by when this seller has answered before, adjusted for very short calls.",
  generalized_model: "This seller's own history is inconclusive, so a model trained on past ERP calls ranks the hours.",
  canonical_model: "Ranked by a calibrated completed-meeting model.",
  operating_hours: "No usable evidence yet, so the earliest allowed calling hours are offered.",
};

export function confidenceLabel(level: Prediction["confidence"]["level"]) {
  return level === "very_high" ? "Very high confidence" : level === "high" ? "High confidence" : level === "moderate" ? "Moderate confidence" : "Insufficient evidence";
}

export function retrySummary(prediction: Prediction) {
  const retry = prediction.retry_plan;
  if (retry.next_call_at) return when(retry.next_call_at, prediction.timezone);
  if (retry.status === "stop") return "Stop retrying";
  if (retry.status === "insufficient_data") return "Retry timing unavailable";
  if (retry.anchor_at) return "Retry postponed";
  return "No retry needed";
}

/** Raw ranking value used only to compare windows of the same seller. */
export function rawStrength(window: CallWindow): number | null {
  if (window.score !== null) return window.score;
  const r = window.ranking;
  if (!r) return null;
  if (r.source === "generalized_model") return r.proxy_estimate;
  if (r.source === "seller_meetings" || r.source === "seller_answers") return r.priority_score;
  return null;
}

export function percent(value: number) {
  const n = value * 100;
  return n > 0 && n < 0.001 ? "<0.001%" : `${n.toFixed(3)}%`;
}
