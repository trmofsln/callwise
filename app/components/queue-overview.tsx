"use client";

import Icon from "./workspace-icon";
import { STRATEGY_LABEL } from "./format";
import { answerRateByHour, displayName, relativeWindow, type SellerRow } from "./seller-model";
import { ConfidenceBadge, StatusBadge } from "./queue-table";
import type { CallLogEntry } from "./call-log";
import { LastCallSentiment, SarvamMark } from "./sentiment";

export function NextBestCall({ row, now, total, onOpen, onLog }: { row: SellerRow | null; now: number; total: number; onOpen: (glid: string) => void; onLog: (glid: string) => void }) {
  if (!row) return <section className="card next-call next-call-empty" aria-label="Next best call">
    <span className="eyebrow">Next best call</span>
    <h2>No calls due today</h2>
    <p>{total ? "Every seller in this queue is either logged today, scheduled for a later day, or blocked by calling rules. Check Upcoming for the next windows." : "Build a queue to see who to call next."}</p>
  </section>;
  const w = relativeWindow(row, now), p = row.prediction!;
  return <section className="card next-call" aria-label="Next best call">
    <div className="next-call-main">
      <span className="eyebrow"><Icon name="bolt" size={13} />Next best call</span>
      <h2>{displayName(row)}</h2>
      <div className="next-call-meta">{(row.company || row.name) && <span>GLID {row.glid}</span>}{row.city && <span>{row.city}</span>}{row.reps.length > 0 && <span>Rep: {row.reps.join(", ")}</span>}</div>
      <div className="next-call-insight"><span className="why-icon" aria-hidden="true"><Icon name="bolt" size={15} /></span><div><span className="eyebrow">Why this time</span><strong>{p.insight?.title ?? "Why this time"}</strong></div></div>
      <p className="next-call-why">{p.explanation}</p>
      {p.conversation?.latest && <LastCallSentiment sentiment={p.conversation.latest.sentiment} score={p.conversation.latest.score} at={p.conversation.latest.at} compact />}
    </div>
    <div className="next-call-side">
      <div className="next-call-when"><StatusBadge status={row.status} /><strong>{w.label}</strong><span>{w.detail}</span><SarvamMark compact /></div>
      <div className="next-call-facts"><span>Basis</span><b>{STRATEGY_LABEL[row.strategy]}</b><span>Confidence</span><ConfidenceBadge level={row.confidence} /></div>
      <div className="next-call-actions">
        <button type="button" className="btn btn-primary" onClick={() => onOpen(row.glid)}>Open calling plan<Icon name="arrow" size={15} /></button>
        <button type="button" className="btn btn-secondary" onClick={() => onLog(row.glid)}>Log call</button>
      </div>
    </div>
  </section>;
}

export function QueueOverview({ rows, logged }: { rows: SellerRow[]; logged: Map<string, CallLogEntry> }) {
  const by = (s: SellerRow["status"]) => rows.filter(r => r.status === s).length;
  const calls = rows.reduce((n, r) => n + r.calls, 0), answered = rows.reduce((n, r) => n + r.answeredCalls, 0);
  const meetings = rows.reduce((n, r) => n + r.successfulMeetings, 0);
  const booked = [...logged.values()].filter(e => e.outcome === "meeting_booked").length;
  const tiles = [
    { label: "Call now", value: by("now"), note: "window open or within 15 min", tone: "good" },
    { label: "Later today", value: by("today"), note: "window later today", tone: "info" },
    { label: "Upcoming", value: by("upcoming"), note: "next window on a later day", tone: "neutral" },
    { label: "No window", value: by("blocked"), note: "blocked by rules or no data", tone: "bad" },
  ];
  return <section className="overview" aria-label="Queue overview">
    <div className="stat-group">
      {tiles.map(t => <div key={t.label} className={`stat stat-${t.tone}`}><span className="stat-label"><span className="dot" />{t.label}</span><strong>{t.value}</strong><span className="stat-note">{t.note}</span></div>)}
    </div>
    <div className="stat-group stat-group-muted">
      <div className="stat"><span className="stat-label">Calls on record</span><strong>{calls.toLocaleString("en-IN")}</strong><span className="stat-note">{calls ? `${Math.round(100 * answered / calls)}% answered` : "ERP history, these sellers"}</span></div>
      <div className="stat"><span className="stat-label">Successful meetings</span><strong>{meetings}</strong><span className="stat-note">{calls ? `${(100 * meetings / calls).toFixed(1)} per 100 calls` : "ERP history"}</span></div>
      <div className="stat"><span className="stat-label">Logged today</span><strong>{logged.size}</strong><span className="stat-note">{booked} meeting{booked === 1 ? "" : "s"} booked · this browser</span></div>
    </div>
  </section>;
}

/** Historical answer rate by hour for the sellers in this queue. Shown only with enough calls to read. */
export function AnswerByHour({ rows }: { rows: SellerRow[] }) {
  const data = answerRateByHour(rows).filter(d => d.hour >= 8 && d.hour <= 20);
  const total = data.reduce((n, d) => n + d.calls, 0);
  if (total < 20) return null;
  const max = Math.max(...data.map(d => d.calls));
  return <section className="card hour-card" aria-labelledby="hour-title">
    <div className="card-head"><div><h3 id="hour-title">When these sellers answered</h3><p>Historical ERP calls by hour of day, {total.toLocaleString("en-IN")} calls with a recorded start. Bar height is call volume; the darker part was answered.</p></div></div>
    <div className="hour-chart" role="img" aria-label="Calls and answered calls by hour">
      {data.map(d => <div key={d.hour} className="hour-col" title={`${String(d.hour).padStart(2, "0")}:00 · ${d.answered} of ${d.calls} answered (${Math.round(100 * d.answered / d.calls)}%)`}>
        <span className="hour-rate">{d.calls >= 5 ? `${Math.round(100 * d.answered / d.calls)}%` : ""}</span>
        <div className="hour-bar" style={{ height: `${Math.max(4, 100 * d.calls / max)}%` }}><div className="hour-fill" style={{ height: `${100 * d.answered / d.calls}%` }} /></div>
        <span className="hour-label">{d.hour}</span>
      </div>)}
    </div>
    <p className="muted-xs">Percentages show the answered share where an hour has at least 5 calls. This describes past calls, not a prediction.</p>
  </section>;
}
