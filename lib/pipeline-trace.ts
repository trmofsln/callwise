// Lightweight execution trace for "Build call queue". The request path records each stage it
// actually runs (with start offset, duration and a short non-sensitive detail), so the
// execution-flow view can show what happened in this run instead of a hand-drawn guess.
// Stage IDs are shared with the flowchart (app/components/execution-flow-graph.ts); a stage the
// code did not record shows as "not recorded" there.

export const RUN_STAGES = [
  "input",           // request validation (GLIDs, optional pasted calls)
  "sarvam_context",  // pasted transcripts -> sarvam-105b reader (parallel with the ERP query)
  "redash_query",    // one Redash query on PostgreSQL source 13
  "global_context",  // Global Context API, 4 GLIDs at a time (parallel with the ERP query)
  "build_profiles",  // rows -> UserProfile (summarizeActivity)
  "attach_analyses", // cached Sarvam analyses (app store) + pasted-call analyses -> recordingAnalyses
  "predict_batch",   // per-seller prediction pipeline, 4 sellers at a time
  "save_lookup",     // each seller's profile + Global Context saved for the retry planner (3 days)
] as const;
export type RunStage = typeof RUN_STAGES[number];
export type StageStatus = "completed" | "skipped" | "unavailable" | "failed";
export type StageRecord = { id: RunStage; status: StageStatus; started_ms: number; duration_ms: number; detail: string };
export type RunTrace = { started_at: string; total_ms: number; stages: StageRecord[] };

/** Per-seller facts recorded while the prediction is computed (no extra queries or model calls). */
export type PredictionPipeline = {
  timings: { context_ms: number; deterministic_ms: number; llm_ms: number; validate_ms: number };
  context: {
    history_status: string; prior_calls: number; recent_attempts: number; attempts_today: number;
    last_call_at: string | null; not_before: string | null; appointments: number; blocked_dates: number;
    do_not_call: boolean; timed_calls: number; answered_calls: number; linked_meetings: number; hour_slots: number;
    analysed_calls: number; minimum_wait_minutes: number; minimum_wait_reason: string;
  };
  candidates: { total: number; requested: number; outside_usual_hours: number };
  llm_attempted: boolean;
  validation: { errors: number; replaced_with_rules: boolean };
};

export class PipelineTrace {
  private readonly t0 = Date.now();
  readonly stages: StageRecord[] = [];

  /** Run one stage and record it; failures are recorded and rethrown. */
  async time<T>(id: RunStage, fn: () => Promise<T> | T, detail: (result: T) => string = () => ""): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.stages.push({ id, status: "completed", started_ms: start - this.t0, duration_ms: Date.now() - start, detail: detail(result) });
      return result;
    } catch (error) {
      this.stages.push({ id, status: "failed", started_ms: start - this.t0, duration_ms: Date.now() - start, detail: error instanceof Error ? error.message.slice(0, 160) : "Failed" });
      throw error;
    }
  }

  mark(id: RunStage, status: StageStatus, detail: string) {
    this.stages.push({ id, status, started_ms: Date.now() - this.t0, duration_ms: 0, detail });
  }

  toJSON(): RunTrace {
    return { started_at: new Date(this.t0).toISOString(), total_ms: Date.now() - this.t0, stages: [...this.stages].sort((a, b) => a.started_ms - b.started_ms) };
  }
}
