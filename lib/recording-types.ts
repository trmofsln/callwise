// Shared, client-safe types for call-recording sentiment analysis (Sarvam AI).

export const SENTIMENTS = [
  "enthusiastic", "interested", "curious", "neutral", "busy_callback", "gatekeeper", "hesitant", "frustrated", "not_interested", "do_not_call", "no_conversation",
] as const;
export type Sentiment = typeof SENTIMENTS[number];
export const CALLBACK_DAYS = ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type CallbackDay = typeof CALLBACK_DAYS[number];

export const PARTS_OF_DAY = ["morning", "afternoon", "evening", "night"] as const;
export type PartOfDay = typeof PARTS_OF_DAY[number];
/** Local clock range for each part of the day, [start, end) in hours. */
export const PART_OF_DAY_HOURS: Record<PartOfDay, [number, number]> = { morning: [9, 12], afternoon: [12, 16], evening: [16, 20], night: [20, 22] };

/**
 * When the client asked to be called back, exactly as said. Sarvam extracts the pieces; the app
 * resolves them to real times relative to the call, so the model never does date arithmetic.
 */
export type CallbackRequest = {
  requested: boolean;
  /** The client's own words about timing. */
  when_text: string | null;
  day: CallbackDay | null;
  /** Explicit calendar date, YYYY-MM-DD. */
  date?: string | null;
  /** "after five days", "next week" (7), "parso" (2). */
  after_days?: number | null;
  /** "after two hours" (120), "in 30 minutes". */
  after_minutes?: number | null;
  /** HH:MM, 24-hour. */
  local_time: string | null;
  /** Whether local_time is the time to call, or a bound ("after 7:30 PM", "before 1 PM"). */
  time_kind?: "at" | "after" | "before" | null;
  part_of_day?: PartOfDay | null;
  /** Soft deferrals: "month end", "next month", "next week". */
  relative?: "month_end" | "next_month" | "next_week" | null;
};

export type SentimentResult = {
  sentiment: Sentiment;
  /** Client attitude from -1 (very negative) to 1 (very positive). */
  score: number;
  summary: string;
  callback: CallbackRequest;
  meeting_intent: boolean;
  objections: string[];
  /** Other relevant facts from the call: requirement, product, decision maker, documents asked for. */
  key_points?: string[];
};

export type RecordingStatus =
  | "analyzed" | "needs_credentials" | "access_denied" | "download_failed" | "unsupported_source" | "too_short" | "analysis_failed";

export type RecordingAnalysis = {
  call_id: string;
  glid: string;
  called_at: string | null;
  duration_seconds: number | null;
  vendor: string | null;
  /** "manual": a transcript or call notes pasted by the user when building the queue. */
  source_kind: "airtel" | "gcs" | "s3" | "other" | "manual";
  status: RecordingStatus;
  status_detail: string | null;
  result: SentimentResult | null;
  language: string | null;
  transcript_chars: number;
  stt_model: string | null;
  chat_model: string | null;
  analyzed_at: string;
};

/** What the ranking, explanation and LLM review use from analysed conversations. */
export type ConversationSignals = {
  analyzed: number;
  counts: Partial<Record<Sentiment, number>>;
  average_score: number | null;
  latest: { sentiment: Sentiment; score: number; summary: string; at: string | null; key_points?: string[] } | null;
  /** Calls whose content came from transcripts pasted by the user rather than recordings. */
  manual?: number;
  /**
   * The callback the client asked for on their latest conversation, resolved to a local time range
   * [at, end). "exact" is a specific time; "range" a bounded part of the day; "day" a whole day
   * (the model picks the hour); "on_or_after" the first calling day from a date onwards.
   */
  callback: { at: string; end?: string; precision?: "exact" | "range" | "day" | "on_or_after"; label?: string; text: string | null; requested_on: string | null } | null;
  meeting_intent: boolean;
  /** Average client score by local hour of the analysed calls. */
  hour_scores: Record<string, { calls: number; average: number }>;
  recent_negative: boolean;
  /** The client's latest real conversation asked not to be called again. */
  asked_not_to_call?: boolean;
};
