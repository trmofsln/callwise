import type { ExperimentMetrics } from "./experiment-types";
import type { ConversationSignals } from "./recording-types";
import type { SellerFactors } from "./seller-factors";
import type { PredictionPipeline } from "./pipeline-trace";

export type PredictionRoute = "history_aware" | "sparse_history" | "cold_start" | "personal_history" | "generalized" | "fallback";
export type RankingStrategy = "seller_meetings" | "seller_answers" | "generalized_model" | "canonical_model" | "operating_hours";
export type SellerSlot = {
  hour: number; calls: number; answered_calls: number; short_calls: number;
  known_answered_durations: number; linked_meetings: number; converted_calls: number;
  actual_time_calls: number; recorded_time_calls: number; actual_answered_calls: number;
};
export type SellerHistory = {
  slots: SellerSlot[]; timed_calls: number; actual_time_calls: number; recorded_time_calls: number;
  answered_calls: number; linked_meetings: number; unlinked_meetings: number; short_calls: number;
  weekday_slots?: (SellerSlot & { weekday: number })[];
  days?: (Omit<SellerSlot,"hour"> & { weekday: number })[];
};
export type DayPreference = { basis: "explicit" | "meeting_history" | "answer_history" | "none"; weekdays: number[]; reason: string };
export type WindowRanking = {
  source: RankingStrategy; priority_score: number; calls: number; answered_calls: number;
  linked_meetings: number; short_calls: number; short_call_penalty: number;
  time_basis: "actual_start" | "recorded_time_proxy" | "mixed" | "model" | "configured";
  proxy_estimate: number | null; reason: string;
  /** Share of this slot's calls timed by an actual dial start rather than an approximate DSR entry time. */
  actual_time_share?: number;
  /** The client asked, in an analysed call, to be called back inside this window. */
  callback_request?: boolean;
  /** Multiplier from the average sentiment of analysed calls at this hour (0.7–1.3). */
  sentiment_factor?: number;
  evidence_scope?: "weekday_hour" | "pooled_hour" | "model" | "configured";
  preferred_day?: boolean;
};
/** One retry in the ladder: when, which approach (an interval after the miss, the next best slot, or the seller's own time) and the evidence. */
export type RetryStep = {
  retry: number; at: string; window_end: string; strategy: "interval" | "best_slot" | "seller_requested";
  /** Minutes after the previous attempt. */
  after_minutes: number; bucket: string; misses_before: number;
  p_answer: number; p_meeting_if_answered: number; cumulative_reach: number;
  title: string; reason: string; evidence: string[];
  alternatives: { label: string; p_answer: number; value: number }[];
};
export type RetryApproach = { strategy: "interval_first" | "best_slot_first" | "seller_time_first" | "mixed"; summary: string; pointers: string[]; source: string };
export type CallWindow = {
  id: string; start: string; end: string; timezone: string;
  score: number | null; score_target: "meeting_done" | null; support: number;
  uncertainty: { lower: number; upper: number; method: string } | null;
  ranking?: WindowRanking; outside_configured_hours?: boolean;
  /** Built from a callback time the client asked for; honoured even outside configured hours or days. */
  requested_by_client?: boolean;
};
export type SchedulingSettings = {
  enabled: boolean; llmEnabled: boolean; timezone: string;
  businessStartHour: number; businessEndHour: number; businessDays: number[];
  horizonDays: number; cooldownMinutes: number; maxAttemptsPerDay: number;
  maxAttemptsPerSequence: number; sequenceDays: number; minimumHistory: number;
  llmDeadlineMs: number; llmMaxTools: number;
  maxSlotsPerDay: number;
};
export type PredictionContext = {
  context_id: string; glid: string; as_of: string; timezone: string;
  history_status: "verified" | "missing" | "failed"; history_scope: string;
  first_contact_verified: boolean;
  prior_calls: number; recent_attempts: number; attempts_today: number;
  last_call_at: string | null; last_unanswered_at: string | null;
  do_not_call: boolean; appointments: { start: string; end: string }[];
  metadata: Record<string, string>; issues: string[]; proxy_completed_meetings: number;
  seller_history?: SellerHistory;
  scheduling_calls?: { at: string; answered: boolean }[];
  blocked_dates?: string[]; not_before?: string | null;
  preferred_weekdays?: number[];
  /** Signals from Sarvam-analysed call recordings; null when none are analysed. */
  conversation?: ConversationSignals | null;
  /** Industry segment, lifecycle stage, last successful meeting and risk signals (ERP + Global Context). */
  seller_factors?: SellerFactors | null;
};
export type ScoringModel = {
  name: string; kind: "trained_ml" | "history_heuristic" | "operating_rules";
  family: ModelArtifact["family"] | null; version: string; training_attempts: number;
  target: string | null; evaluation: ExperimentMetrics | null; description: string;
};
export type Prediction = {
  glid: string; as_of: string; timezone: string; prediction_route: PredictionRoute;
  model_version: string; primary_target: "meeting_done"; scoring_model: ScoringModel;
  recommended_window: CallWindow | null; ranked_windows: CallWindow[];
  daily_windows: { date: string; timezone: string; windows: CallWindow[] }[];
  ranking_strategy: RankingStrategy;
  ranking_scope: "overall"; day_preference: DayPreference;
  retry_plan: {
    status: "not_needed" | "retry" | "postpone" | "stop" | "insufficient_data";
    after_minutes: number | null; next_call_at: string | null; attempt_number: number;
    maximum_attempts: number; stop_condition: string;
    considered_delays_minutes: number[]; rule_assessment: "unverified_keep_for_pilot";
    anchor_kind: "recommended_window_end" | "recommended_call_start" | null; anchor_at: string | null;
    minimum_gap_minutes: number; earliest_retry_at: string | null;
    next_window: CallWindow | null; reason: string;
    previous_unanswered_at: string | null;
    /** Data-driven retry ladder: up to four retries if each attempt goes unanswered. */
    ladder?: RetryStep[];
    /** Why this retry approach suits this seller, as evidence pointers. */
    approach?: RetryApproach | null;
  };
  confidence: { level: "insufficient" | "moderate" | "high" | "very_high"; calibrated: boolean; reason: string };
  evidence: { prior_calls: number; proxy_completed_meetings: number; canonical_completed_meetings: number | null;
    history_status: PredictionContext["history_status"]; history_scope: string; training_attempts: number;
    label_kind: "canonical" | "proxy" | "unavailable"; data_quality: string[]; assumptions: string[] };
  explanation: string;
  /** Headline plus longer plain-language detail lines for the "Why this time" panel; built only from fetched history. */
  insight: { title: string; details: string[] };
  conversation: ConversationSignals | null;
  seller_factors: SellerFactors | null;
  /** Execution facts recorded by predictBatch for the execution-flow view (not part of the decision). */
  pipeline?: PredictionPipeline;
  selected_tool: string; selected_model_version: string; routing_reason: string;
  validation_status: "passed" | "insufficient_support" | "blocked";
  validation_issues: string[];
  llm_status: { status: "reviewed" | "disabled" | "fallback"; reason: string | null;
    model: string; tool_executions: number; latency_ms: number; input_tokens: number;
    output_tokens: number; cost: number | null };
};
export type ModelArtifact = {
  schema_version: number; model_version: string; route: "history_aware" | "cold_start";
  primary_target: "meeting_done"; label_kind: "canonical" | "proxy"; timezone: string;
  family: "logistic" | "hour_day" | "cohort_hour_day";
  dataset_sha256: string; split_sha256: string; trained_at: string;
  deployment: { approved: boolean; reason: string };
  calibration: { kind: "none" | "platt"; calibrated: boolean; slope?: number; intercept?: number; clip?: number };
  evidence: { training_attempts: number; training_positives: number };
  smoothing: { strength: number; global: { count: number; positive: number };
    bins: Record<string, { count: number; positive: number }>; cohorts?: Record<string,Record<string,Record<string,{count:number;positive:number}>>> };
  feature_schema: { feature_names: string[]; categories?: Record<string, string[]>; timezone?: string; interaction_fields?: string[]; account_age_cap_days?: number };
  logistic: { coefficients: number[]; intercept: number } | null;
};
