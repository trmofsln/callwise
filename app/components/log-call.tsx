"use client";

import { useState, type FormEvent } from "react";
import { logCall, OUTCOMES, removeLogEntry, type CallLogEntry, type LoggedOutcome } from "./call-log";
import { useToast } from "./toast";
import Icon from "./workspace-icon";
import { LastCallSentiment, SarvamMark } from "./sentiment";
import SellerFactorChips from "./seller-factors";
import RetryLadder from "./retry-ladder";
import { rememberRetryPlan } from "./retry-plan-store";
import type { AiRetryPlan } from "@/lib/retry-planner";

/** Local datetime-input value (YYYY-MM-DDTHH:MM) for an instant, in the browser's timezone. */
function localInput(iso: string) {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
function when(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** The AI retry plan: what Sarvam heard on the call, when to retry, and why. */
export function RetryPlanCard({ plan }: { plan: AiRetryPlan }) {
  const r = plan.this_call?.result;
  return <section className={`retry-ai retry-${plan.status}`} aria-label="AI retry plan">
    <header><span className="eyebrow"><Icon name="bolt" size={13} />AI retry plan</span><SarvamMark compact /></header>
    {r && <LastCallSentiment sentiment={r.sentiment} score={r.score} summary={r.summary} label={plan.this_call?.chat_model ? "This call · Sarvam sentiment" : "This call · from the logged outcome"} />}
    {plan.call_at ? <div className="retry-ai-when">
      <span className="label">Call again</span>
      <strong>{when(plan.call_at)}</strong>
      <span className="muted-xs">Window {plan.window?.label}{plan.window?.seller_requested ? " · the seller asked for this time" : ""}{plan.minimum_gap_minutes ? ` · minimum wait ${plan.minimum_gap_minutes} min (${plan.gap_reason})` : ""}</span>
    </div> : <div className="retry-ai-when"><span className="label">{plan.status === "stop" ? "Stop" : "No retry window"}</span></div>}
    <p className="retry-ai-reason">{plan.reason}</p>
    {plan.factors_used.length > 0 && <div className="factor-chips">{plan.factors_used.map(f => <span key={f} className="factor-chip used">{f}</span>)}</div>}
    <RetryLadder steps={plan.ladder ?? []} approach={plan.approach} timezone="Asia/Kolkata" first={plan.called_at} firstLabel="Call just made, not successful" />
    <SellerFactorChips factors={plan.factors} title="Seller factors considered" />
    <footer className="muted-xs"><Icon name="shield" size={12} />{plan.source === "llm" ? `Time and reason by ${plan.model}, checked against ${plan.candidates.length} windows allowed by the calling rules.` : "Time and reason by the rules engine."}{plan.llm_note ? ` ${plan.llm_note}` : ""}{plan.source === "llm" && plan.rules_choice && plan.rules_choice.call_at !== plan.call_at ? ` Rules engine alone would pick ${plan.rules_choice.label}.` : ""}</footer>
  </section>;
}

/** Record a call outcome and an optional follow-up. Saved in this browser only (no ERP write API).
 *  For an unsuccessful call, the AI plans the retry from the transcript and the seller's factors. */
export function LogCallForm({ glid, label, lookupId, onDone, compact = false }: { glid: string; label: string; lookupId?: string | null; onDone?: () => void; compact?: boolean }) {
  const toast = useToast();
  const [outcome, setOutcome] = useState<LoggedOutcome | null>(null);
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [transcript, setTranscript] = useState("");
  const [plan, setPlan] = useState<AiRetryPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState("");
  const unsuccessful = !!outcome && outcome !== "meeting_booked";

  async function planRetry() {
    if (!outcome || outcome === "meeting_booked") return;
    setPlanning(true); setError(""); setPlan(null);
    try {
      const response = await fetch("/api/retry", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ glid, lookupId, outcome, transcript }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Could not plan the retry.");
      setPlan(body); rememberRetryPlan(body);
      if (body.call_at) setFollowUp(localInput(body.call_at));
    } catch (e) { setError(e instanceof Error ? e.message : "Could not plan the retry."); }
    finally { setPlanning(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!outcome) { setError("Choose what happened on the call."); return; }
    const retry: CallLogEntry["retry"] = plan && unsuccessful ? { status: plan.status, call_at: plan.call_at, window: plan.window?.label ?? null, reason: plan.reason, source: plan.source, model: plan.model, sentiment: plan.this_call?.result?.sentiment ?? null, score: plan.this_call?.result?.score ?? null } : undefined;
    const entry = logCall({ glid, outcome, note: note.trim(), followUpAt: followUp ? new Date(followUp).toISOString() : null, ...(retry ? { retry } : {}) });
    const meta = OUTCOMES.find(o => o.key === outcome)!;
    toast({ tone: "success", message: `${meta.label} logged for ${label}${retry?.call_at ? `, retry ${when(retry.call_at)}` : ""}. Saved in this browser.`, action: { label: "Undo", run: () => removeLogEntry(entry.id) } });
    setOutcome(null); setNote(""); setFollowUp(""); setTranscript(""); setPlan(null); setError("");
    onDone?.();
  }

  return <form className={`log-form ${compact ? "compact" : ""}`} onSubmit={submit}>
    <fieldset>
      <legend>Call outcome</legend>
      <div className="segmented" role="radiogroup" aria-label="Call outcome">
        {OUTCOMES.map(o => <label key={o.key} className={`seg seg-${o.tone} ${outcome === o.key ? "on" : ""}`}>
          <input type="radio" name={`outcome-${glid}`} value={o.key} checked={outcome === o.key} onChange={() => { setOutcome(o.key); setError(""); setPlan(null); }} />{o.label}
        </label>)}
      </div>
    </fieldset>
    {unsuccessful && <section className="retry-ask" aria-label="Plan the retry with AI">
      <div className="retry-ask-head"><strong>Not successful? Let AI plan the retry</strong><SarvamMark compact /></div>
      <p className="muted-xs">Paste what was said on this call (optional). Sarvam reads it for sentiment and any callback request; sarvam-105b then weighs it with the seller&apos;s segment, lifecycle stage (new onboarding, renewal, upsell), last successful meeting and answer history, and picks the retry time from the windows the calling rules allow.</p>
      <textarea className="retry-transcript" value={transcript} onChange={e => setTranscript(e.target.value)} maxLength={8000} rows={4} spellCheck={false} placeholder={"e.g. Seller: Abhi meeting mein hoon, kal subah 11 baje call karna. Owner bhi tab milenge."} aria-label="Transcript of this call" />
      <div className="retry-ask-actions">
        <button type="button" className="btn btn-secondary" onClick={planRetry} disabled={planning}><Icon name="bolt" size={15} />{planning ? "Planning with Sarvam…" : plan ? "Plan again" : "Plan retry with AI"}</button>
        <span className="muted-xs">{transcript.length.toLocaleString("en-IN")} / 8,000 · sent to Sarvam AI, not stored</span>
      </div>
      {plan && <RetryPlanCard plan={plan} />}
    </section>}
    <div className="form-row">
      <label className="field"><span>Follow-up {plan?.call_at ? "(set by the AI retry plan)" : "(optional)"}</span><input id={`follow-${glid}`} type="datetime-local" value={followUp} onChange={e => setFollowUp(e.target.value)} /></label>
      <label className="field grow"><span>Note (optional)</span><input id={`note-${glid}`} value={note} maxLength={280} onChange={e => setNote(e.target.value)} placeholder="e.g. asked for a call after 4 pm" /></label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions">
      <button type="submit" className="btn btn-primary">Save outcome</button>
      <span className="muted-xs">Stored only in this browser. It is not written to the ERP and does not change the recommendation.</span>
    </div>
  </form>;
}

export function LogCallDialog({ glid, label, lookupId, onClose }: { glid: string; label: string; lookupId?: string | null; onClose: () => void }) {
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal log-modal" role="dialog" aria-modal="true" aria-labelledby="log-title" onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="modal-head"><div><h2 id="log-title">Log call</h2><p>{label} · GLID {glid}</p></div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose} autoFocus><Icon name="x" size={18} /></button></div>
      <LogCallForm glid={glid} label={label} lookupId={lookupId} onDone={onClose} />
    </div>
  </div>;
}
