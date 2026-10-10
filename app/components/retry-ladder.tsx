import type { RetryApproach, RetryStep } from "@/lib/best-time-types";
import Icon from "./workspace-icon";

const STRATEGY: Record<RetryStep["strategy"], string> = { interval: "Interval", best_slot: "Next best slot", seller_requested: "Seller's time" };
const APPROACH: Record<RetryApproach["strategy"], string> = { interval_first: "Interval-first", best_slot_first: "Best-slot-first", seller_time_first: "Seller's time first", mixed: "Mixed" };

function when(iso: string, tz: string) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}
function gap(minutes: number) {
  if (minutes < 60) return `+${minutes} min`;
  if (minutes < 24 * 60) return `+${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `+${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? "" : "s"}`;
}
const pct = (p: number) => `${Math.round(p * 100)}%`;

/** First call, then up to four data-driven retries, each with its approach, timing, odds and proof. */
export default function RetryLadder({ steps, approach, timezone, first, firstLabel = "Best time to call" }: { steps: RetryStep[]; approach: RetryApproach | null | undefined; timezone: string; first?: string | null; firstLabel?: string }) {
  if (!steps.length) return null;
  return <section className="ladder" aria-label="Retry ladder">
    <header className="ladder-head">
      <div><span className="eyebrow"><Icon name="refresh" size={13} />Retry ladder if unanswered</span>{approach && <h4>{APPROACH[approach.strategy]}: {approach.summary}</h4>}</div>
      <div className="ladder-reach" title="Chance of having reached the seller by the last retry, from retry data"><span>Reach by retry {steps.length}</span><b>{pct(steps.at(-1)!.cumulative_reach)}</b></div>
    </header>
    <ol className="ladder-steps">
      {first && <li className="ladder-step ladder-first"><span className="ladder-dot">0</span><div className="ladder-main"><div className="ladder-line"><b>Call</b><strong>{when(first, timezone)}</strong><span className="ladder-chip chip-first">{firstLabel}</span></div></div></li>}
      {steps.map(s => <li key={s.retry} className={`ladder-step step-${s.strategy}`}>
        <span className="ladder-dot">{s.retry}</span>
        <div className="ladder-main">
          <div className="ladder-line">
            <b>Retry {s.retry}</b><strong>{when(s.at, timezone)}</strong>
            <span className={`ladder-chip chip-${s.strategy}`}>{STRATEGY[s.strategy]}{s.strategy === "interval" ? ` ${gap(s.after_minutes)}` : ` · ${gap(s.after_minutes)}`}</span>
            <span className="ladder-odds" title="Estimated chance this retry is answered, and of a meeting if it is"><span className="odds-bar"><span style={{ width: pct(s.p_answer) }} /></span>{pct(s.p_answer)} answer · {pct(s.p_meeting_if_answered)} meeting if answered</span>
          </div>
          <p>{s.reason}</p>
          <details><summary>Proof for this retry</summary><ul>{s.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
        </div>
      </li>)}
    </ol>
    {approach && <details className="ladder-why" open>
      <summary>Why this retry approach for this seller</summary>
      <ul>{approach.pointers.map((p, i) => <li key={i}><Icon name="check" size={13} /><span>{p}</span></li>)}</ul>
      <p className="muted-xs">Estimates come from {approach.source}. They are observed associations (reps chose when to retry), used to rank options, not guarantees.</p>
    </details>}
  </section>;
}
