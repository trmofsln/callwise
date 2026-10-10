"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { UserLookup } from "@/lib/user-types";
import Icon from "./workspace-icon";
import { BEST_TIME_GRAPH, RETRY_GRAPH, type FlowEdge, type FlowGraph, type FlowNode, type NodeKind } from "./execution-flow-graph";
import { bestTimeReasons, resolveBestTimeRun, resolveRetryRun, retryReasons, type FlowRun, type RunStatus } from "./execution-flow-run";
import { displayName, type SellerRow } from "./seller-model";
import { useRetryPlans } from "./retry-plan-store";

// Geometry: a top-down flow. Columns hold parallel or alternative branches; rows are steps.
const NW = 184, NH = 54, COLW = 204, ROWH = 84, PADX = 70, PADY = 40;
const pos = (n: FlowNode) => ({ x: PADX + n.col * COLW, y: PADY + n.row * ROWH });
const KIND_LABEL: Record<NodeKind, string> = { input: "Input", data: "Data", rules: "Rules", ml: "ML model", llm: "LLM / AI", output: "Result" };
const STATUS_LABEL: Record<RunStatus | "active" | "pending", string> = { completed: "Completed", skipped: "Skipped", unavailable: "Unavailable", failed: "Fell back / failed", not_run: "Not run", offline: "Ran offline", not_recorded: "Not recorded", active: "Running", pending: "Waiting" };
const EXECUTED: RunStatus[] = ["completed", "failed", "offline"];

function edgePath(graph: FlowGraph, e: FlowEdge): string {
  const a = graph.nodes.find(x => x.id === e.from)!, b = graph.nodes.find(x => x.id === e.to)!;
  const pa = pos(a), pb = pos(b);
  if (e.loop || b.row < a.row) {
    const sx = pa.x, sy = pa.y + NH / 2, tx = pb.x, ty = pb.y + NH / 2;
    return `M${sx},${sy} C${sx - 58},${sy} ${tx - 58},${ty} ${tx},${ty}`;
  }
  if (a.row === b.row) {
    const left = b.col < a.col, sx = left ? pa.x : pa.x + NW, tx = left ? pb.x + NW : pb.x, y = pa.y + NH / 2;
    return `M${sx},${y} L${tx},${y}`;
  }
  if (a.col === b.col && b.row - a.row > 1) {
    // Skip over the boxes in between by running down the right-hand gutter.
    const sx = pa.x + NW, sy = pa.y + NH / 2, ty = pb.y + NH / 2, gx = pa.x + NW + 12;
    return `M${sx},${sy} C${gx + 6},${sy} ${gx},${sy + 20} ${gx},${(sy + ty) / 2} S${gx + 6},${ty} ${pb.x + NW},${ty}`;
  }
  const sx = pa.x + NW / 2, sy = pa.y + NH, tx = pb.x + NW / 2, ty = pb.y, my = (sy + ty) / 2;
  return `M${sx},${sy} C${sx},${my} ${tx},${my} ${tx},${ty}`;
}

type Timing = { start: number; end: number };
/** Replay timeline from the recorded run: rows play in order; nodes in a row overlap (parallel). */
function timeline(graph: FlowGraph, run: FlowRun): { at: Record<string, Timing>; total: number } {
  const rows = [...new Set(graph.nodes.map(n => n.row))].sort((a, b) => a - b);
  const real = rows.map(r => Math.max(1, ...graph.nodes.filter(n => n.row === r && EXECUTED.includes(run.nodes[n.id]?.status)).map(n => run.nodes[n.id]?.ms ?? 1)));
  const totalReal = real.reduce((s, v) => s + v, 0);
  const at: Record<string, Timing> = {};
  let clock = 0;
  rows.forEach((r, i) => {
    const rowDur = Math.max(420, (real[i] / totalReal) * 6500);
    for (const n of graph.nodes.filter(x => x.row === r && EXECUTED.includes(run.nodes[x.id]?.status))) {
      const ms = run.nodes[n.id]?.ms;
      const share = ms && real[i] > 1 ? Math.max(0.35, ms / real[i]) : 1;
      at[n.id] = { start: clock, end: clock + rowDur * share };
    }
    if (graph.nodes.some(x => x.row === r && at[x.id])) clock += rowDur;
  });
  return { at, total: clock + 400 };
}

type Selection = { graph: "best" | "retry"; kind: "node" | "edge"; id: string } | null;

function Diagram({ graph, run, selection, onSelect, replay }: { graph: FlowGraph; run: FlowRun; selection: Selection; onSelect: (s: Selection) => void; replay: { t: number; at: Record<string, Timing> } | null }) {
  const width = PADX + 4 * COLW + NW + 30, height = PADY + (Math.max(...graph.nodes.map(n => n.row)) + 1) * ROWH + 10;
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const nodeState = (id: string): string => {
    const status = run.nodes[id]?.status ?? "not_recorded";
    if (!replay) return status;
    const t = replay.at[id];
    if (!t) return status;
    return replay.t < t.start ? "pending" : replay.t < t.end ? "active" : status;
  };
  const flowing = (e: FlowEdge) => {
    if (!replay || !run.edges[e.id]?.active) return false;
    const a = replay.at[e.from], b = replay.at[e.to];
    return !!a && !!b && replay.t >= a.end - 120 && replay.t < b.end;
  };
  const key = (fn: () => void) => (ev: KeyboardEvent) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); fn(); } };
  const isSel = (kind: "node" | "edge", id: string) => selection?.graph === graph.id && selection.kind === kind && selection.id === id;

  return <div className="xf-canvas">
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="group" aria-label={graph.title}>
      <defs>
        {["on", "off", "sel"].map(k => <marker key={k} id={`xf-arrow-${graph.id}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className={`xf-head-${k}`} /></marker>)}
        <pattern id={`xf-hatch-${graph.id}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" className="xf-hatch-line" /></pattern>
      </defs>
      {graph.groups.map(g => {
        const x = PADX + g.col0 * COLW - 12, y = PADY + g.row0 * ROWH - 22, w = (g.col1 - g.col0) * COLW + NW + 24, h = (g.row1 - g.row0) * ROWH + NH + 32;
        return <g key={g.label} className={`xf-group g-${g.kind}`}><rect x={x} y={y} width={w} height={h} rx="10" /><text x={x + 10} y={y + 14}>{g.label}</text></g>;
      })}
      {graph.edges.map(e => {
        const d = edgePath(graph, e), active = run.edges[e.id]?.active, sel = isSel("edge", e.id), flow = flowing(e);
        return <g key={e.id} className={`xf-edge ${active ? "on" : "off"} ${sel ? "sel" : ""} ${flow ? "flow" : ""}`}>
          <path d={d} className="xf-edge-line" markerEnd={`url(#xf-arrow-${graph.id}-${sel ? "sel" : active ? "on" : "off"})`} />
          {flow && !reduced && <circle r="4" className="xf-particle"><animateMotion dur="0.9s" repeatCount="indefinite" path={d} /></circle>}
          <path d={d} className="xf-edge-hit" tabIndex={0} role="button" aria-label={`Arrow: ${graph.nodes.find(n => n.id === e.from)?.label} to ${graph.nodes.find(n => n.id === e.to)?.label}. ${active ? "Used in this run" : "Not used"}`}
            onClick={() => onSelect({ graph: graph.id, kind: "edge", id: e.id })} onKeyDown={key(() => onSelect({ graph: graph.id, kind: "edge", id: e.id }))} />
        </g>;
      })}
      {graph.nodes.map(n => {
        const p = pos(n), st = nodeState(n.id), sel = isSel("node", n.id);
        return <g key={n.id} transform={`translate(${p.x},${p.y})`} className={`xf-node k-${n.kind} st-${st} ${sel ? "sel" : ""}`} tabIndex={0} role="button"
          aria-label={`${n.label}, ${KIND_LABEL[n.kind]}, ${STATUS_LABEL[st as RunStatus] ?? st}`} aria-pressed={sel}
          onClick={() => onSelect({ graph: graph.id, kind: "node", id: n.id })} onKeyDown={key(() => onSelect({ graph: graph.id, kind: "node", id: n.id }))}>
          <rect width={NW} height={NH} rx="8" className="xf-box" />
          {st === "unavailable" && <rect width={NW} height={NH} rx="8" fill={`url(#xf-hatch-${graph.id})`} className="xf-hatch" />}
          <rect width="4" height={NH} rx="2" className="xf-kindbar" />
          <text x="13" y="21" className="xf-label">{n.label}</text>
          <text x="13" y="39" className="xf-sub">{n.sub}</text>
          <circle cx={NW - 12} cy="12" r="4.5" className="xf-dot" />
        </g>;
      })}
    </svg>
  </div>;
}

function Panel({ graph, run, selection, onSelect, onClose, reasons }: { graph: FlowGraph; run: FlowRun; selection: NonNullable<Selection>; onSelect: (s: Selection) => void; onClose: () => void; reasons: { title: string; items: string[] }[] }) {
  const byId = (id: string) => graph.nodes.find(n => n.id === id)!;
  const go = (id: string) => onSelect({ graph: graph.id, kind: "node", id });
  if (selection.kind === "edge") {
    const e = graph.edges.find(x => x.id === selection.id)!;
    const r = run.edges[e.id];
    return <aside className="xf-panel" aria-label="Arrow details">
      <header><span className="xf-kind k-edge">Data flow</span><button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="x" size={16} /></button></header>
      <h3><button type="button" className="link-btn" onClick={() => go(e.from)}>{byId(e.from).label}</button> → <button type="button" className="link-btn" onClick={() => go(e.to)}>{byId(e.to).label}</button></h3>
      <p className={`xf-run ${r?.active ? "on" : "off"}`}>{r?.active ? "Used in this run" : "Not used in this run"}{e.loop ? " · loops back for the next retry" : ""}</p>
      <dl className="xf-facts">
        <div><dt>What is passed</dt><dd>{e.payload}</dd></div>
        {e.fields.length > 0 && <div><dt>Fields</dt><dd className="xf-fields">{e.fields.map(f => <code key={f}>{f}</code>)}</dd></div>}
        <div><dt>Transformation</dt><dd>{e.transform}</dd></div>
        <div><dt>Destination receives</dt><dd>{e.scope === "complete" ? "The complete output" : "Selected fields only"}</dd></div>
        <div><dt>Waits for</dt><dd>{e.waits}</dd></div>
      </dl>
      {r?.sample !== undefined ? <div className="xf-sample"><span className="eyebrow">From this run · counts and fields only</span><pre>{JSON.stringify(r.sample, null, 2)}</pre></div>
        : <p className="muted-xs">No runtime sample is recorded for this arrow; the fields above are the schema from the code.</p>}
    </aside>;
  }
  const n = byId(selection.id), r = run.nodes[n.id];
  const incoming = graph.edges.filter(e => e.to === n.id), outgoing = graph.edges.filter(e => e.from === n.id);
  return <aside className="xf-panel" aria-label="Stage details">
    <header><span className={`xf-kind k-${n.kind}`}>{KIND_LABEL[n.kind]}</span><span className={`xf-status st-${r?.status}`}>{STATUS_LABEL[r?.status ?? "not_recorded"]}</span><button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}><Icon name="x" size={16} /></button></header>
    <h3>{n.label}</h3>
    <p className="xf-purpose">{n.purpose}</p>
    <section className="xf-this-run"><span className="eyebrow">This run</span>{r?.note && <p>{r.note}</p>}
      {r?.values.length ? <dl>{r.values.map(([k, v], i) => <div key={i}><dt>{k}</dt><dd>{v}</dd></div>)}</dl> : null}</section>
    {n.kind === "output" && <section className="xf-reasons">{reasons.map(g => <div key={g.title}><span className="eyebrow">{g.title}</span><ul>{g.items.map((it, i) => <li key={i}>{it}</li>)}</ul></div>)}</section>}
    <dl className="xf-facts">
      <div><dt>Input</dt><dd>{n.input}</dd></div>
      <div><dt>Data source</dt><dd>{n.source}</dd></div>
      <div><dt>Processing</dt><dd><ul>{n.logic.map((l, i) => <li key={i}>{l}</li>)}</ul></dd></div>
      {n.model && <div><dt>Model</dt><dd>{n.model}</dd></div>}
      <div><dt>Output</dt><dd>{n.output}</dd></div>
      <div><dt>Depends on</dt><dd className="xf-links">{incoming.length ? incoming.map(e => <button key={e.id} type="button" className="chip-btn" onClick={() => onSelect({ graph: graph.id, kind: "edge", id: e.id })}>{byId(e.from).label} →</button>) : "Nothing (entry point)"}</dd></div>
      <div><dt>Goes to</dt><dd className="xf-links">{outgoing.length ? outgoing.map(e => <button key={e.id} type="button" className="chip-btn" onClick={() => onSelect({ graph: graph.id, kind: "edge", id: e.id })}>→ {byId(e.to).label}</button>) : "Final result"}</dd></div>
      <div><dt>Code</dt><dd><code>{n.code}</code></dd></div>
    </dl>
  </aside>;
}

function Flow({ graph, run, selection, onSelect, reasons, seller }: { graph: FlowGraph; run: FlowRun; selection: Selection; onSelect: (s: Selection) => void; reasons: { title: string; items: string[] }[]; seller: string }) {
  const [t, setT] = useState<number | null>(null);
  const plan = useMemo(() => timeline(graph, run), [graph, run]);
  const raf = useRef<number | null>(null);
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  function play() {
    if (raf.current) cancelAnimationFrame(raf.current);
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed >= plan.total) { setT(null); raf.current = null; return; }
      setT(elapsed); raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  }
  const counts = Object.values(run.nodes).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return <section className="xf-flow" aria-labelledby={`xf-${graph.id}`}>
    <div className="xf-head">
      <div><h3 id={`xf-${graph.id}`}>{graph.title}</h3>
        <p className="muted-xs">For {seller} · {counts.completed ?? 0} completed · {(counts.skipped ?? 0) + (counts.not_run ?? 0)} skipped or not run · {counts.unavailable ?? 0} unavailable{counts.failed ? ` · ${counts.failed} fell back` : ""}</p></div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={play} disabled={t !== null}><Icon name="bolt" size={14} />{t !== null ? "Replaying…" : run.recorded ? "Replay this run" : "Illustrative playback"}</button>
    </div>
    {t !== null && <p className="xf-replay-note">{run.recorded ? "Replay of the recorded run: order and relative durations come from this build's execution record, sped up. It is not a live feed." : "Illustrative playback: this response has no execution record, so durations are not real."}</p>}
    <Diagram graph={graph} run={run} selection={selection} onSelect={onSelect} replay={t === null ? null : { t, at: plan.at }} />
    <div className="xf-decision"><span className="eyebrow"><Icon name="check" size={12} />Result and why</span>
      <div className="xf-decision-grid">{reasons.map(g => <div key={g.title}><b>{g.title}</b><ul>{g.items.map((it, i) => <li key={i}>{it}</li>)}</ul></div>)}</div></div>
  </section>;
}

/** Two explorable execution flows for the queue just built: best time to call, and retry timing. */
export default function ExecutionFlows({ result, rows }: { result: UserLookup; rows: SellerRow[] }) {
  const sellers = rows.filter(r => r.prediction);
  const [glid, setGlid] = useState<string>(sellers[0]?.glid ?? "");
  const [selection, setSelection] = useState<Selection>(null);
  const plans = useRetryPlans();
  const row = sellers.find(r => r.glid === glid) ?? sellers[0];
  const bestRun = row ? resolveBestTimeRun(BEST_TIME_GRAPH, result, row) : null;
  const retryRun = row ? resolveRetryRun(RETRY_GRAPH, row, plans[row.glid]) : null;
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") setSelection(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selection]);
  if (!row || !bestRun || !retryRun) return null;
  const graph = selection?.graph === "retry" ? RETRY_GRAPH : BEST_TIME_GRAPH, run = selection?.graph === "retry" ? retryRun : bestRun;
  const label = displayName(row);
  const best = bestTimeReasons(row), retry = retryReasons(row, plans[row.glid]);
  return <section className="card xf" aria-labelledby="xf-title">
    <div className="xf-top">
      <div><span className="eyebrow">How this queue was built</span><h2 id="xf-title">Execution flow</h2>
        <p className="muted">What actually ran when you clicked Build call queue, for one seller at a time. Click any box or arrow to see the data it used and produced.</p></div>
      <label className="xf-seller">Seller<select value={row.glid} onChange={e => { setGlid(e.target.value); setSelection(null); }}>{sellers.map(r => <option key={r.glid} value={r.glid}>{displayName(r)} · {r.glid}</option>)}</select></label>
    </div>
    <div className="xf-legend" aria-label="Legend">
      {(["input", "data", "rules", "ml", "llm", "output"] as NodeKind[]).map(k => <span key={k}><i className={`xf-swatch k-${k}`} />{KIND_LABEL[k]}</span>)}
      <span className="xf-sep" />
      {(["completed", "skipped", "unavailable", "failed", "not_run"] as RunStatus[]).map(s => <span key={s}><i className={`xf-state st-${s}`} />{STATUS_LABEL[s]}</span>)}
    </div>
    <Flow graph={BEST_TIME_GRAPH} run={bestRun} selection={selection} onSelect={setSelection} reasons={best} seller={label} />
    <Flow graph={RETRY_GRAPH} run={retryRun} selection={selection} onSelect={setSelection} reasons={retry} seller={label} />
    <details className="xf-gaps"><summary>Known gaps and how to read this</summary>
      <ul>
        <li>Statuses come from this build&apos;s execution record (<code>trace</code> on the lookup) and the seller&apos;s prediction. Inside one seller&apos;s pipeline only four blocks are timed (context, rules, AI review, validator), so steps within a block share its time.</li>
        <li>Booked DSR appointments (<code>sts_dsr_app_date/time</code>) block overlapping windows; they are not treated as callback requests.</li>
        <li>Pasted previous-call context applies to that build only. An &quot;asked not to call&quot; found in it pauses calling for that build; nothing is written back to the ERP do-not-call mark.</li>
        <li>Only the seller&apos;s latest real conversation (under 30 days old) can set a callback. A request beyond the planning days is mentioned in the explanation, and the model picks a time within them.</li>
        <li>The canonical meeting model is not available (no verified &quot;meeting done&quot; label), so that branch never runs.</li>
        <li>Retry rates are observed associations from past ERP retries, not a measured causal effect.</li>
      </ul>
    </details>
    {selection && <Panel graph={graph} run={run} selection={selection} onSelect={setSelection} onClose={() => setSelection(null)} reasons={selection.graph === "retry" ? retry : best} />}
  </section>;
}
