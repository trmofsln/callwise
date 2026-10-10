import type { CallWindow, Prediction } from "@/lib/best-time-types";
import { useDevMode } from "./dev-mode";
import { percent, rawStrength } from "./format";

/** Short, plain-language evidence for one window. */
export function evidenceHeadline(window: CallWindow | null) {
  if (!window) return "No eligible window";
  if (window.score !== null) return `${(window.score * 100).toFixed(1)}% meeting estimate`;
  const r = window.ranking;
  if (r?.callback_request && !r.calls && r.proxy_estimate === null) return "Requested by the seller";
  if (r?.source === "seller_meetings") return `${r.linked_meetings} linked ${r.linked_meetings === 1 ? "meeting" : "meetings"}`;
  if (r?.source === "seller_answers") return `${r.answered_calls} answered ${r.answered_calls === 1 ? "call" : "calls"}`;
  if (r?.source === "generalized_model") return "Model-ranked hour";
  return "Within calling hours";
}

function devValue(window: CallWindow) {
  if (window.score !== null) return `${percent(window.score)} meeting probability`;
  const r = window.ranking;
  if (r?.source === "generalized_model" && r.proxy_estimate !== null) return `${percent(r.proxy_estimate)} ERP proxy estimate`;
  if (r?.source === "seller_meetings" || r?.source === "seller_answers") return `${r.priority_score.toLocaleString("en-GB")} ranking points`;
  return "no model score";
}

/** Strength relative to the seller's strongest window (1 = strongest). */
export function SlotScore({ window, best, tied = false }: { window: CallWindow; best: number | null; tied?: boolean }) {
  const dev = useDevMode();
  const value = rawStrength(window);
  const share = value !== null && best ? Math.max(0.06, value / best) : null;
  return <div className="slot-score">
    <span className="slot-score-value">{share === null ? "Even" : share >= 0.995 ? (tied ? "Joint strongest" : "Strongest") : `${Math.round(share * 100)}%`}</span>
    {share !== null && <span className="strength-bar" aria-hidden="true"><span style={{ width: `${share * 100}%` }} /></span>}
    {dev && <small className="dev-inline">{devValue(window)}</small>}
  </div>;
}

export default function ScoringModel({ prediction }: { prediction: Prediction }) {
  const dev = useDevMode();
  const model = prediction.scoring_model;
  if (!model) return null;
  const evaluation = model.evaluation;
  return <div className="scoring-model">
    <div className="scoring-model-name"><strong>{model.name}</strong><span className="tag">{model.kind === "trained_ml" ? "Trained ML" : model.kind === "history_heuristic" ? "History heuristic" : "Operating rules"}</span></div>
    <p>{model.description}</p>
    <div className="model-top-score"><span>Top choice evidence</span><strong>{evidenceHeadline(prediction.recommended_window)}</strong></div>
    {(evaluation || dev) && <details className="model-details"><summary>Model quality and version</summary>
      {evaluation && (evaluation.roc_auc !== null || evaluation.average_precision !== null) && <p>Held-out test: ROC AUC <strong>{evaluation.roc_auc?.toFixed(3) ?? "n/a"}</strong>, AUPRC <strong>{evaluation.average_precision?.toFixed(4) ?? "n/a"}</strong> across {evaluation.attempts?.toLocaleString("en-GB")} calls and {evaluation.proxy_events} proxy meetings. These describe the model overall, not this seller.</p>}
      {model.training_attempts > 0 && <p>Trained on {model.training_attempts.toLocaleString("en-GB")} historical calls.</p>}
      <p className="source-note">Version <code>{model.version}</code></p>
    </details>}
  </div>;
}
