"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import AppShell from "./components/app-shell";
import Icon from "./components/workspace-icon";
import QueueTable from "./components/queue-table";
import ExecutionFlows from "./components/execution-flow";
import SellerDrawer from "./components/seller-drawer";
import { LogCallDialog } from "./components/log-call";
import { AnswerByHour, NextBestCall, QueueOverview } from "./components/queue-overview";
import { buildRows, displayName, nextBestCall } from "./components/seller-model";
import { loggedToday, useCallLog } from "./components/call-log";
import { useDevMode } from "./components/dev-mode";
import { CallContextDialog, contextPayload, filledContext, typedGlids, type CallContextDraft } from "./components/call-context";
import type { UserLookup } from "@/lib/user-types";

const LAST_KEY = "callwise.lastLookup";
function readLast() { try { return window.localStorage.getItem(LAST_KEY) ?? ""; } catch { return ""; } }
function subscribeLast(cb: () => void) { window.addEventListener("storage", cb); return () => window.removeEventListener("storage", cb); }

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(id); }, [intervalMs]);
  return now;
}

function SkeletonQueue() {
  return <section className="card queue" aria-busy="true" aria-label="Building call queue">
    <div className="queue-head"><h2>Building call queue…</h2><span className="muted-xs">Reading ERP call and meeting history, ranking windows and checking calling rules</span></div>
    <div className="skeleton-rows">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton-row"><span /><span /><span /><span /></div>)}</div>
  </section>;
}

function Onboarding() {
  return <section className="card onboarding" aria-label="How the call queue works">
    <div className="onboarding-intro">
      <span className="eyebrow">Best Time to Call</span>
      <h2>Know who to call right now, and when to try again</h2>
      <p>Add the sellers you plan to call. Callwise reads their ERP call and meeting history, ranks future one-hour windows inside your calling rules, and puts the seller who is due now at the top.</p>
    </div>
    <ol className="how-list">
      <li><span>1</span><div><strong>Seller history first</strong><p>Hours that led to meetings rank first, then hours the seller answered. Very short calls count less.</p></div></li>
      <li><span>2</span><div><strong>General model when history is thin</strong><p>A weekday-and-hour model trained on 150,875 past ERP calls ranks the hours instead.</p></div></li>
      <li><span>3</span><div><strong>Calling rules always apply</strong><p>Calling hours, minimum gap, daily and 7-day caps, do-not-call marks and booked appointments.</p></div></li>
    </ol>
    <p className="muted-xs">Recommendations show evidence and a confidence level, not a guaranteed outcome. No meeting probability is shown until a validated completed-meeting model exists.</p>
  </section>;
}

function Workspace() {
  const dev = useDevMode();
  const now = useNow();
  const log = useCallLog();
  const last = useSyncExternalStore(subscribeLast, readLast, () => "");
  const [glids, setGlids] = useState("");
  const [result, setResult] = useState<UserLookup | null>(null);
  const [requested, setRequested] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openGlid, setOpenGlid] = useState<string | null>(null);
  const [logGlid, setLogGlid] = useState<string | null>(null);
  // Optional previous-call transcripts, analysed by Sarvam with the next queue build.
  const [callContext, setCallContext] = useState<CallContextDraft | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const [sentContext, setSentContext] = useState<ReturnType<typeof contextPayload>>(undefined);

  const run = useCallback(async (input: string, draft: CallContextDraft | null = null) => {
    if (!input.trim()) return;
    setLoading(true); setError(""); setOpenGlid(null);
    try {
      const call_context = contextPayload(draft, typedGlids(input));
      const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ glids: input, call_context }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Lookup failed. Please try again.");
      setResult(body); setRequested(input); setSentContext(call_context);
      try { window.localStorage.setItem(LAST_KEY, input); } catch { /* storage unavailable */ }
    } catch (e) { setError(e instanceof Error ? e.message : "Could not connect. Check your network and try again."); }
    finally { setLoading(false); }
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); run(glids, callContext); }

  // Re-run the lookup for one seller (e.g. after Sarvam analysed new recordings) and merge it in place.
  const refreshSeller = useCallback(async (glid: string) => {
    try {
      const call_context = sentContext?.glid === glid ? sentContext : undefined;
      const response = await fetch("/api/users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ glids: glid, call_context }) });
      const body = await response.json() as UserLookup & { error?: string };
      if (!response.ok) throw new Error(body.error || "Refresh failed.");
      setResult(prev => prev ? {
        ...prev,
        users: [...prev.users.filter(u => u.glid !== glid), ...body.users],
        predictions: [...(prev.predictions ?? []).filter(p => p.glid !== glid), ...(body.predictions ?? [])],
        globalContexts: [...(prev.globalContexts ?? []).filter(c => c.glid !== glid), ...(body.globalContexts ?? [])],
      } : prev);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not refresh the seller."); }
  }, [sentContext]);

  function download() {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `users-${result.lookupId}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const entered = useMemo(() => typedGlids(glids), [glids]);
  const context = filledContext(callContext);
  const contextGlid = context ? (entered.includes(context.glid) ? context.glid : entered[0] ?? "") : "";
  const rows = useMemo(() => result ? buildRows(result, now) : [], [result, now]);
  const logged = useMemo(() => loggedToday(log, now), [log, now]);
  const next = useMemo(() => nextBestCall(rows, new Set(logged.keys())), [rows, logged]);
  const openRow = rows.find(r => r.glid === openGlid) ?? null;
  const logRow = rows.find(r => r.glid === logGlid) ?? null;
  const fetched = result ? new Intl.DateTimeFormat("en-IN", { timeStyle: "short" }).format(new Date(result.fetchedAt)) : "";

  return <>
    <form className="card lookup" onSubmit={submit}>
      <label htmlFor="glids" className="lookup-label">Sellers to plan</label>
      <div className="lookup-row">
        <div className="field-search lookup-input"><Icon name="search" size={16} />
          <input id="glids" value={glids} onChange={e => setGlids(e.target.value)} placeholder="Enter GLIDs separated by commas, e.g. 123456, 789012" aria-describedby="glids-help" required disabled={loading} autoComplete="off" /></div>
        <button type="button" className={`btn btn-secondary ${context ? "btn-context-on" : ""}`} onClick={() => setContextOpen(true)} disabled={loading} aria-haspopup="dialog">
          <Icon name="note" size={15} />{context ? `Call context · ${context.calls.length}` : "Previous call context"}<span className="optional-tag">optional</span></button>
        <button type="submit" className="btn btn-primary" disabled={loading || !glids.trim()}>{loading ? (context ? "Building with Sarvam…" : "Building…") : "Build call queue"}</button>
        {last && !loading && last !== glids && <button type="button" className="btn btn-secondary" onClick={() => { setGlids(last); run(last, callContext); }}><Icon name="refresh" size={15} />Reload last list</button>}
      </div>
      {context && <p className="context-chip"><Icon name="note" size={14} /><span><b>{context.calls.length} previous call{context.calls.length === 1 ? "" : "s"}</b> for GLID {contextGlid || "(first entered)"} will be read by Sarvam AI when you build the queue.</span>
        <button type="button" className="link-btn" onClick={() => setContextOpen(true)}>Edit</button><button type="button" className="link-btn" onClick={() => setCallContext(null)}>Remove</button></p>}
      <p id="glids-help" className="muted-xs">Up to 50 sellers per queue. {result ? <>Queue built at {fetched} for {result.requestedGlids.length} GLIDs · <button type="button" className="link-btn" onClick={() => run(requested, callContext)} disabled={loading}>Refresh recommendations</button>{dev && <> · <button type="button" className="link-btn" onClick={download}>Download API response</button></>}</> : "Recommendations use live ERP data at the moment you build the queue."}</p>
    </form>

    {error && <div className="alert alert-error" role="alert"><Icon name="alert" size={16} /><span>{error}</span>{requested || glids ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => run(requested || glids, callContext)}>Try again</button> : null}</div>}
    {loading && <SkeletonQueue />}
    {!loading && result && <>
      {result.missingGlids.length > 0 && <div className="alert alert-warn" role="status"><Icon name="info" size={16} /><span>No ERP user record for {result.missingGlids.join(", ")}. They stay in the queue with whatever recommendation could be made.</span></div>}
      <QueueOverview rows={rows} logged={logged} />
      <div className="split">
        <NextBestCall row={next} now={now} total={rows.length} onOpen={setOpenGlid} onLog={setLogGlid} />
        <AnswerByHour rows={rows} />
      </div>
      <QueueTable rows={rows} now={now} logged={logged} onOpen={setOpenGlid} onLog={setLogGlid} />
      <ExecutionFlows result={result} rows={rows} />
    </>}
    {!loading && !result && !error && <Onboarding />}

    {openRow && <SellerDrawer row={openRow} now={now} lookupId={result?.lookupId ?? null} log={log.filter(e => e.glid === openRow.glid)} onClose={() => setOpenGlid(null)} onRefresh={refreshSeller} />}
    {logRow && <LogCallDialog glid={logRow.glid} label={displayName(logRow)} lookupId={result?.lookupId ?? null} onClose={() => setLogGlid(null)} />}
    {contextOpen && <CallContextDialog glids={entered} value={callContext} onSave={setCallContext} onClose={() => setContextOpen(false)} />}
  </>;
}

export default function Home() {
  return <AppShell active="queue" title="Call queue"><Workspace /></AppShell>;
}
