export type ExperimentMetrics = {
  attempts: number | null; proxy_events: number | null; prevalence: number | null;
  average_precision: number | null; roc_auc: number | null; brier: number | null; log_loss: number | null;
};
export type ClockPreview = { start: string; end: string; timezone: string; proxy_score: number; support: number; calibrated: boolean };
export type ExperimentModelReport = {
  name: string; route: string; status: "pending" | "blocked" | "trained" | "evaluated" | "invalid";
  model_version: string | null; candidate: string | null; trained_target: string;
  training_attempts: number | null; training_positives: number | null;
  validation: ExperimentMetrics | null; test: ExperimentMetrics | null; baseline: ExperimentMetrics | null;
  calibrated: boolean; support_sufficient: boolean; predictive_acceptance_met: boolean;
  uncertainty: { average_precision: { lower: number; upper: number } | null };
  preview: ClockPreview[]; reason: string | null;
};
export type ExperimentReport = {
  state: "not_started" | "extracting" | "prepared" | "evaluated";
  target: "observed_linked_physical_recorded_met_within14days";
  canonical_label_verified: false; deployment_approved: false; policy_lift_measured: false;
  source_id: number; attempts: number | null; sellers: number | null; proxy_events: number | null;
  checkpoints: number; planned_checkpoints: number; as_of: string | null;
  dataset_sha256: string | null; models: ExperimentModelReport[]; limitations: string[];
};
