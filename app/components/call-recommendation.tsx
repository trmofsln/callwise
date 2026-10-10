import type { CallWindow, Prediction } from "@/lib/best-time-types";
import Icon from "./workspace-icon";
import ScoringModel, { SlotScore, evidenceHeadline } from "./scoring-model";
import { DevJson } from "./dev-mode";
import { confidenceLabel, duration, rawStrength, retrySummary, STRATEGY_BASIS, STRATEGY_LABEL, WEEKDAYS, when } from "./format";
import { SarvamMark } from "./sentiment";
import RetryLadder from "./retry-ladder";

function SlotEvidence({ window }: { window: CallWindow }) {
  const r = window.ranking;
  const notes: string[] = [];
  if (r?.source === "seller_meetings" || r?.source === "seller_answers") {
    notes.push(`${r.answered_calls} answered of ${r.calls} calls in this slot`);
    if (r.short_calls > 0) notes.push(`${r.short_calls} under 20 s, priority reduced`);
    if (r.evidence_scope === "pooled_hour") notes.push("hour pooled across weekdays");
    if (r.time_basis !== "actual_start") notes.push("includes approximate DSR entry times");
  } else if (r?.source === "generalized_model") {
    notes.push(`${window.support.toLocaleString("en-GB")} training calls at this hour`);
    if (r.reason.includes("backs off")) notes.push("weekday sparse, hour pooled");
  } else if (window.score === null) {
    notes.push("no conclusive history for this slot");
  }
  if (r?.callback_request) notes.push("seller asked to be called at this time");
  if (window.outside_configured_hours) notes.push(r?.callback_request ? "outside usual hours, as the seller asked" : "outside usual hours but answered before");
  if (r?.preferred_day) notes.push("strong day");
  return <><strong className="slot-evidence">{evidenceHeadline(window)}</strong>{notes.length > 0 && <small>{notes.join(" · ")}</small>}</>;
}

function RetryPlan({ prediction }: { prediction: Prediction }) {
  const retry = prediction.retry_plan, tz = prediction.timezone, first = prediction.recommended_window;
  return <aside className="retry-preview" aria-label="Retry plan if unanswered">
    <span className="panel-label"><Icon name="phone" size={16} /> If the call is unanswered</span>
    <strong>{retrySummary(prediction)}</strong>
    {retry.after_minutes !== null && retry.anchor_at
      ? <span className="retry-delay">Retry {duration(retry.after_minutes)} after the planned call ({when(retry.anchor_at, tz, false)}){retry.approach ? ` · ${retry.approach.strategy.replaceAll("_", " ")}` : ""}</span>
      : retry.anchor_at ? <span className="retry-delay">Minimum wait {duration(retry.minimum_gap_minutes)}</span> : null}
    {first && retry.ladder?.length ? <ol className="retry-steps">
      <li><span>0</span><div><b>Call</b>{when(first.start, tz)}</div></li>
      {retry.ladder.map(s => <li key={s.retry}><span>{s.retry}</span><div><b>Retry {s.retry}</b>{when(s.at, tz)} · {s.strategy === "interval" ? `+${s.after_minutes} min` : s.strategy === "seller_requested" ? "seller's time" : "best slot"} · {Math.round(s.p_answer * 100)}%</div></li>)}
    </ol> : <p className="muted">{retry.reason}</p>}
    <small className="retry-limit">{retry.next_call_at ? `Attempt ${retry.attempt_number} of up to ${retry.maximum_attempts} in this sequence.` : `Up to ${retry.maximum_attempts} attempts per sequence.`} {retry.stop_condition}</small>
  </aside>;
}

/** The project's highlight: a headline, the 2–3 sentence summary and the facts behind it. */
export function WhyThisTime({ prediction, compact = false }: { prediction: Prediction; compact?: boolean }) {
  const insight = prediction.insight;
  const level = prediction.confidence.level;
  return <section className={`why-card ${compact ? "why-compact" : ""}`} aria-label="Why this time">
    <header className="why-head">
      <span className="why-icon" aria-hidden="true"><Icon name="bolt" size={18} /></span>
      <div className="why-heading">
        <span className="eyebrow">Why this time</span>
        <h3>{insight?.title ?? "Why this time"}</h3>
      </div>
      <span className={`pill confidence-${level}`} title={prediction.confidence.reason}>{confidenceLabel(level)}</span>
    </header>
    {prediction.conversation?.callback && <p className={`why-callback ${prediction.recommended_window?.ranking?.callback_request ? "used" : ""}`}><Icon name="clock" size={14} /><span>Seller asked for a callback <b>{prediction.conversation.callback.label ?? ""}</b>{prediction.conversation.callback.text ? ` ("${prediction.conversation.callback.text}")` : ""}{prediction.recommended_window?.ranking?.callback_request ? ", so the plan calls then." : ". This plan can't use that time, so it shows the best time within the planning period."}</span><SarvamMark compact /></p>}
    <p className="why-summary">{prediction.explanation}</p>
    {!compact && insight && insight.details.length > 0 && <ul className="why-details">{insight.details.map((d, i) => <li key={i}><Icon name="check" size={14} /><span>{d}</span></li>)}</ul>}
    {!compact && <footer className="why-foot"><Icon name="shield" size={13} />{prediction.llm_status.status === "reviewed" ? "Written from this seller's real call history and checked by Luna (GPT-6) against the data." : "Written from this seller's real call history by fixed rules."}</footer>}
  </section>;
}

export default function CallRecommendation({ prediction }: { prediction?: Prediction }) {
  if (!prediction) return null;
  const strategy = prediction.ranking_strategy || "operating_hours";
  const tz = prediction.timezone, best = prediction.recommended_window;
  const strongest = Math.max(0, ...prediction.ranked_windows.map(w => rawStrength(w) ?? 0)) || null;
  const tiedTop = strongest !== null && prediction.ranked_windows.filter(w => rawStrength(w) === strongest).length > 1;
  const preferredDays = prediction.day_preference?.weekdays || [];
  const level = prediction.confidence.level;
  return <section className="call-recommendation" aria-label={`Calling plan for GLID ${prediction.glid}`}>
    <WhyThisTime prediction={prediction} />

    <div className="plan-hero">
      <div className={`call-next ${best ? "" : "call-next-empty"}`}>
        <span className="eyebrow call-next-label">BEST TIME TO CALL<SarvamMark compact /></span>
        <strong>{best ? when(best.start, tz) : "No eligible window"}</strong>
        <small>{best ? `Until ${when(best.end, tz, false)} · ${tz}` : prediction.routing_reason.replaceAll("_", " ")}</small>
        <div className="plan-pills">
          <span className={`pill basis-${strategy}`}>{STRATEGY_LABEL[strategy]}</span>
          <span className={`pill confidence-${level}`} title={prediction.confidence.reason}>{confidenceLabel(level)}</span>
        </div>
      </div>
      <RetryPlan prediction={prediction} />
    </div>
    {best && <RetryLadder steps={prediction.retry_plan.ladder ?? []} approach={prediction.retry_plan.approach} timezone={tz} first={best.start} />}

    <div className="plan-grid">
      <div className="overall-calling-plan">
        <div className="panel-heading"><h4>Ranked calling windows</h4><span>{STRATEGY_BASIS[strategy]}</span></div>
        {preferredDays.length > 0 && <p className="day-preference-note"><Icon name="calendar" size={14} /><span>{prediction.day_preference.basis === "explicit" ? "Preferred days" : "Strongest days in history"}: <strong>{preferredDays.map(d => WEEKDAYS[d]).join(", ")}</strong></span></p>}
        {prediction.ranked_windows.length > 0 ? <div className="table-wrap"><table>
          <thead><tr><th>Rank</th><th>Window</th><th>Evidence</th><th>Evidence vs best slot</th></tr></thead>
          <tbody>{prediction.ranked_windows.map((window, rank) => <tr key={window.id} className={rank === 0 ? "slot-first" : ""}>
            <td><span className="slot-rank">{rank + 1}</span></td>
            <td><strong>{when(window.start, tz)}</strong><small>to {when(window.end, tz, false)}</small></td>
            <td><SlotEvidence window={window} /></td>
            <td><SlotScore window={window} best={strongest} tied={tiedTop} /></td>
          </tr>)}</tbody>
        </table></div> : <p className="muted">No window passes the calling rules right now. {prediction.routing_reason.replaceAll("_", " ")}.</p>}
        <p className="source-note">The evidence bar compares this seller&apos;s slots with each other. Rank also puts the seller&apos;s strongest day first, so a top-ranked slot can show less evidence than a later one. Daily attempt limits and the minimum gap still apply.</p>
      </div>
    </div>

    <div className="plan-evidence">
      <dl className="call-evidence">
        <div><dt>Confidence</dt><dd>{confidenceLabel(level)}</dd><small>{prediction.confidence.reason}</small></div>
        <div><dt>Seller history used</dt><dd>{prediction.evidence.prior_calls} prior calls</dd><small>{prediction.evidence.proxy_completed_meetings} ERP-recorded meetings · {prediction.evidence.history_status === "verified" ? "history fetched" : "history unavailable"}</small></div>
        <div><dt>Ranking basis</dt><dd>{STRATEGY_LABEL[strategy]}</dd><small>{prediction.confidence.calibrated ? "Calibrated meeting estimate" : "Advisory ranking, not a guaranteed outcome"}</small></div>
      </dl>
      <ScoringModel prediction={prediction} />
    </div>

    <details className="plan-assumptions"><summary>Evidence notes and operating assumptions</summary>
      {prediction.day_preference?.reason && <p>{prediction.day_preference.reason}</p>}
      <p>{prediction.retry_plan.reason}</p>
      <ul>{[...prediction.evidence.data_quality, ...prediction.evidence.assumptions].map((issue, index) => <li key={index}>{issue}</li>)}</ul>
      <p className="source-note">Meetings come from the ERP record (a proxy for completed meetings). Meetings without a usable call link do not influence slot ranking. As of {when(prediction.as_of, tz)}.</p>
    </details>
    <DevJson label="Prediction API response" data={prediction} />
  </section>;
}
