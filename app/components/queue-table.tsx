"use client";

import { useMemo, useState } from "react";
import Icon from "./workspace-icon";
import { confidenceLabel, STRATEGY_LABEL } from "./format";
import { displayName, relativeWindow, SORTS, sortRows, type QueueStatus, type SellerRow, type SortKey } from "./seller-model";
import { outcomeMeta, type CallLogEntry } from "./call-log";
import { SarvamMark, SentimentChip } from "./sentiment";

export const STATUS_META: Record<QueueStatus, { label: string; tone: string }> = {
  now: { label: "Call now", tone: "good" },
  today: { label: "Later today", tone: "info" },
  upcoming: { label: "Upcoming", tone: "neutral" },
  blocked: { label: "No window", tone: "bad" },
};

type Tab = "all" | QueueStatus;
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" }, { key: "now", label: "Call now" }, { key: "today", label: "Later today" },
  { key: "upcoming", label: "Upcoming" }, { key: "blocked", label: "No window" },
];
const ANY = "__any__";

function dateShort(value: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(d);
}

export function StatusBadge({ status }: { status: QueueStatus }) {
  const m = STATUS_META[status];
  return <span className={`badge badge-${m.tone}`}><span className="dot" />{m.label}</span>;
}

export function ConfidenceBadge({ level }: { level: SellerRow["confidence"] }) {
  const tone = level === "very_high" || level === "high" ? "good" : level === "moderate" ? "info" : "bad";
  return <span className={`badge badge-outline badge-${tone}`}>{confidenceLabel(level).replace(" confidence", "").replace(" evidence", "")}</span>;
}

export default function QueueTable({ rows, now, logged, onOpen, onLog }: {
  rows: SellerRow[]; now: number; logged: Map<string, CallLogEntry>;
  onOpen: (glid: string) => void; onLog: (glid: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [query, setQuery] = useState("");
  const [rep, setRep] = useState(ANY);
  const [confidence, setConfidence] = useState(ANY);
  const [basis, setBasis] = useState(ANY);
  const [outcome, setOutcome] = useState(ANY);
  const [hideLogged, setHideLogged] = useState(false);
  const [sort, setSort] = useState<SortKey>("time");

  const reps = useMemo(() => [...new Set(rows.flatMap(r => r.reps))].sort(), [rows]);
  const outcomes = useMemo(() => [...new Set(rows.map(r => r.lastOutcome ?? "No calls on record"))].sort(), [rows]);
  const bases = useMemo(() => [...new Set(rows.map(r => r.strategy))], [rows]);
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { all: rows.length, now: 0, today: 0, upcoming: 0, blocked: 0 };
    rows.forEach(r => c[r.status]++);
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortRows(rows.filter(r =>
      (tab === "all" || r.status === tab) &&
      (!q || [r.glid, r.name, r.company, r.city, ...r.reps].some(v => v?.toLowerCase().includes(q))) &&
      (rep === ANY || r.reps.includes(rep)) &&
      (confidence === ANY || r.confidence === confidence) &&
      (basis === ANY || r.strategy === basis) &&
      (outcome === ANY || (r.lastOutcome ?? "No calls on record") === outcome) &&
      (!hideLogged || !logged.has(r.glid))), sort);
  }, [rows, tab, query, rep, confidence, basis, outcome, hideLogged, logged, sort]);

  const filtersActive = rep !== ANY || confidence !== ANY || basis !== ANY || outcome !== ANY || hideLogged || query;
  function reset() { setRep(ANY); setConfidence(ANY); setBasis(ANY); setOutcome(ANY); setHideLogged(false); setQuery(""); }

  return <section className="card queue" aria-labelledby="queue-title">
    <div className="queue-head">
      <h2 id="queue-title">Call queue</h2>
      <div className="tabs" role="tablist" aria-label="Filter by status">
        {TABS.map(t => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "tab active" : "tab"} onClick={() => setTab(t.key)}>
          {t.label}<span className="tab-count">{counts[t.key]}</span>
        </button>)}
      </div>
    </div>
    <div className="toolbar">
      <label className="field-search"><Icon name="search" size={15} /><span className="sr-only">Search sellers</span>
        <input id="queue-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search GLID, company, city, rep" /></label>
      <select id="filter-rep" aria-label="Sales representative" value={rep} onChange={e => setRep(e.target.value)} disabled={!reps.length}>
        <option value={ANY}>All reps</option>{reps.map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      <select id="filter-confidence" aria-label="Confidence" value={confidence} onChange={e => setConfidence(e.target.value)}>
        <option value={ANY}>Any confidence</option><option value="very_high">Very high</option><option value="high">High</option><option value="moderate">Moderate</option><option value="insufficient">Insufficient</option>
      </select>
      <select id="filter-basis" aria-label="Ranking basis" value={basis} onChange={e => setBasis(e.target.value)}>
        <option value={ANY}>Any basis</option>{bases.map(b => <option key={b} value={b}>{STRATEGY_LABEL[b]}</option>)}
      </select>
      <select id="filter-outcome" aria-label="Previous call outcome" value={outcome} onChange={e => setOutcome(e.target.value)}>
        <option value={ANY}>Any last outcome</option>{outcomes.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
      <label className="check"><input id="filter-logged" type="checkbox" checked={hideLogged} onChange={e => setHideLogged(e.target.checked)} />Hide logged today</label>
      <span className="toolbar-spacer" />
      <label className="sort"><span>Sort</span>
        <select id="queue-sort" value={sort} onChange={e => setSort(e.target.value as SortKey)}>{SORTS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select></label>
    </div>

    {visible.length === 0 ? <div className="empty-inline">
      <Icon name="search" size={18} /><div><strong>No sellers match these filters</strong><p>{filtersActive ? "Clear the filters to see the full queue." : "No sellers in this status."}</p></div>
      {filtersActive && <button type="button" className="btn btn-secondary btn-sm" onClick={reset}>Clear filters</button>}
    </div> : <div className="table-scroll">
      <table className="data-table">
        <thead><tr><th scope="col">Seller</th><th scope="col"><span className="th-with-mark">Best time to call<SarvamMark compact /></span></th><th scope="col">Confidence</th><th scope="col">Basis</th><th scope="col">Last contact</th><th scope="col">Assigned rep</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{visible.map(r => {
          const w = relativeWindow(r, now), log = logged.get(r.glid);
          return <tr key={r.glid} className={`queue-row status-${r.status}`} onClick={() => onOpen(r.glid)}>
            <td data-label="Seller"><div className="cell-primary">{displayName(r)}</div>
              <div className="cell-secondary">{[r.company || r.name ? `GLID ${r.glid}` : null, r.city, r.customerType].filter(Boolean).join(" · ") || "No profile details"}</div></td>
            <td data-label="Best time"><div className="cell-when"><StatusBadge status={r.status} /><span className="cell-primary">{w.label}</span></div><div className="cell-secondary">{w.detail}</div>{r.prediction?.insight && <div className={`cell-why ${r.status === "blocked" ? "cell-why-muted" : ""}`}><Icon name="bolt" size={12} />{r.prediction.insight.title}</div>}</td>
            <td data-label="Confidence"><ConfidenceBadge level={r.confidence} /></td>
            <td data-label="Basis"><span className="cell-secondary-strong">{STRATEGY_LABEL[r.strategy]}</span></td>
            <td data-label="Last contact">{log
              ? <><span className={`badge badge-${outcomeMeta(log.outcome).tone}`}>{outcomeMeta(log.outcome).label}</span><div className="cell-secondary">Logged {new Date(log.at).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} · this browser</div></>
              : r.lastCall ? <><div className="cell-primary">{dateShort(r.lastCall.at)}</div><div className="cell-secondary">{r.lastOutcome ?? "Outcome not recorded"}{r.lastCall.employeeName ? ` · ${r.lastCall.employeeName}` : ""}</div></>
              : <span className="cell-secondary">No calls on record</span>}
              {r.prediction?.conversation?.latest && <div className="cell-sentiment"><SentimentChip sentiment={r.prediction.conversation.latest.sentiment} compact /></div>}</td>
            <td data-label="Rep"><span className="cell-secondary-strong">{r.reps.join(", ") || "Unassigned"}</span></td>
            <td className="cell-actions" onClick={e => e.stopPropagation()}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => onLog(r.glid)} disabled={!r.user && !r.prediction}>Log call</button>
              <button type="button" className="btn btn-primary btn-sm queue-row-open" onClick={() => onOpen(r.glid)}>Open plan<Icon name="chevron" size={14} /></button>
            </td>
          </tr>;
        })}</tbody>
      </table>
    </div>}
    <div className="queue-foot"><span>{visible.length} of {rows.length} sellers</span>{filtersActive ? <button type="button" className="link-btn" onClick={reset}>Clear filters</button> : null}</div>
  </section>;
}
