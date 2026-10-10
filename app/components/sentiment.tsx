"use client";

import { useState } from "react";
import Image from "next/image";
import Icon from "./workspace-icon";
import { useToast } from "./toast";
import { SENTIMENTS, type RecordingAnalysis, type Sentiment } from "@/lib/recording-types";

/** Eleven client sentiments, ordered from most to least promising, each with its own colour. */
export const SENTIMENT_META: Record<Sentiment, { label: string; hint: string }> = {
  enthusiastic: { label: "Enthusiastic", hint: "Keen and ready to proceed" },
  interested: { label: "Interested", hint: "Positive, wants details" },
  curious: { label: "Curious", hint: "Open, asking questions" },
  neutral: { label: "Neutral", hint: "Polite, no clear direction" },
  busy_callback: { label: "Busy, call back", hint: "Busy now or asked to be called later" },
  gatekeeper: { label: "Not the decision maker", hint: "Staff or family answered; the owner was unavailable" },
  hesitant: { label: "Hesitant", hint: "Unsure, price or value concerns" },
  frustrated: { label: "Frustrated", hint: "Irritated or complaining" },
  not_interested: { label: "Not interested", hint: "Declined" },
  do_not_call: { label: "Asked not to call", hint: "Explicitly asked never to be called again" },
  no_conversation: { label: "No conversation", hint: "Voicemail, silence or wrong number" },
};

const STATUS_TEXT: Record<RecordingAnalysis["status"], string> = {
  analyzed: "Analysed",
  needs_credentials: "Vendor login needed",
  access_denied: "Storage access denied",
  download_failed: "Download failed",
  unsupported_source: "Unsupported source",
  too_short: "Too short to analyse",
  analysis_failed: "Analysis failed",
};

export function SentimentChip({ sentiment, compact = false }: { sentiment: Sentiment; compact?: boolean }) {
  return <span className={`sentiment-chip s-${sentiment} ${compact ? "compact" : ""}`} title={SENTIMENT_META[sentiment].hint}><span className="dot" />{SENTIMENT_META[sentiment].label}</span>;
}

/** "Powered by Sarvam" label. `compact` is the tiny version shown wherever a best time to call appears. */
export function SarvamMark({ compact = false }: { compact?: boolean }) {
  // SVGs are served as-is (unoptimized): the image optimizer does not process SVG by default.
  return <span className={`sarvam-mark ${compact ? "compact" : ""}`} title="Call sentiment and callback requests are analysed by Sarvam AI"><span>Powered by</span><Image src="/brand/sarvam-wordmark.svg" alt="Sarvam AI" width={compact ? 56 : 74} height={compact ? 9 : 12} unoptimized /></span>;
}

/** Client mood from −1 to +1 on a red–grey–green scale. */
export function MoodMeter({ score }: { score: number }) {
  const pct = Math.round(((Math.max(-1, Math.min(1, score)) + 1) / 2) * 100);
  return <span className="mood-meter" role="img" aria-label={`Client mood ${score >= 0 ? "+" : ""}${score.toFixed(1)} on a −1 to +1 scale`} title={`Client mood ${score >= 0 ? "+" : ""}${score.toFixed(2)} (−1 to +1)`}>
    <span className="mood-track"><span className="mood-marker" style={{ left: `${pct}%` }} /></span>
    <span className="mood-value">{score >= 0 ? "+" : ""}{score.toFixed(1)}</span>
  </span>;
}

/** The latest call's sentiment: colour-coded category, mood meter and a one-line summary. */
export function LastCallSentiment({ sentiment, score, summary, at, label = "Last call sentiment", compact = false }: { sentiment: Sentiment; score: number; summary?: string | null; at?: string | null; label?: string; compact?: boolean }) {
  return <div className={`last-call s-${sentiment} ${compact ? "compact" : ""}`}>
    <div className="last-call-head"><span className="eyebrow">{label}</span>{at && <span className="muted-xs">{when(at)}</span>}</div>
    <div className="last-call-row"><SentimentChip sentiment={sentiment} /><MoodMeter score={score} /></div>
    {summary && !compact && <p>{summary}</p>}
  </div>;
}

function when(value: string | null) {
  if (!value) return "Time unknown";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export default function ConversationPanel({ glid, analyses, onAnalyzed }: { glid: string; analyses: RecordingAnalysis[]; onAnalyzed: (glid: string) => Promise<void> | void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = analyses.filter(a => a.status === "analyzed" && a.result);
  const counts = SENTIMENTS.map(s => ({ s, n: done.filter(a => a.result!.sentiment === s).length })).filter(x => x.n > 0);
  const blocked = analyses.filter(a => a.status !== "analyzed");
  const pasted = done.filter(a => a.source_kind === "manual").length;
  const scored = done.filter(a => a.result!.sentiment !== "no_conversation");
  const average = scored.length ? scored.reduce((n, a) => n + a.result!.score, 0) / scored.length : null;

  async function analyse() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/recordings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ glid }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Analysis failed.");
      toast({ tone: "success", message: body.processed ? `Sarvam analysed ${body.processed} recording${body.processed === 1 ? "" : "s"}. Updating the calling plan…` : "No new recordings to analyse. Plan is up to date." });
      await onAnalyzed(glid);
    } catch (e) { setError(e instanceof Error ? e.message : "Analysis failed."); }
    finally { setBusy(false); }
  }

  return <section className="sentiment-panel" aria-labelledby={`sentiment-${glid}`}>
    <header className="sentiment-head">
      <div><span className="eyebrow">Previous calls</span><h3 id={`sentiment-${glid}`}>Conversation sentiment</h3></div>
      <SarvamMark />
    </header>
    {done.length > 0 ? <>
      <div className="sentiment-summary">
        <div className="sentiment-bar" role="img" aria-label={counts.map(c => `${c.n} ${SENTIMENT_META[c.s].label}`).join(", ")}>
          {counts.map(c => <span key={c.s} className={`s-${c.s}`} style={{ flexGrow: c.n }} title={`${SENTIMENT_META[c.s].label}: ${c.n}`} />)}
        </div>
        <div className="sentiment-legend">{counts.map(c => <span key={c.s}><SentimentChip sentiment={c.s} compact /> {c.n}</span>)}</div>
        <p className="muted-xs">{done.length} call{done.length === 1 ? "" : "s"} analysed{pasted ? ` (${pasted} from pasted transcripts)` : ""}{average !== null ? ` · average client mood ${average >= 0 ? "+" : ""}${average.toFixed(2)} on a −1 to +1 scale` : ""}. Sentiment feeds the calling plan: hours with positive calls rank higher, and a callback time the seller asked for is used first when it falls in the planning period.</p>
      </div>
      <ul className="sentiment-list">
        {done.map(a => <li key={a.call_id}>
          <SentimentChip sentiment={a.result!.sentiment} />
          <div>
            <p>{a.result!.summary}</p>
            <span className="muted-xs">{a.source_kind === "manual" ? <span className="source-tag">{a.vendor ?? "Pasted transcript"}</span> : null}{a.source_kind === "manual" && a.status_detail ? "Today" : when(a.called_at)}{a.duration_seconds ? ` · ${Math.round(a.duration_seconds)} s` : ""}{a.language ? ` · ${a.language}` : ""}{a.result!.meeting_intent ? " · meeting intent" : ""}</span>
            {a.result!.callback.requested && <span className="callback-note"><Icon name="clock" size={12} />Asked for a callback{a.result!.callback.when_text ? `: "${a.result!.callback.when_text}"` : ""}</span>}
            {a.result!.key_points && a.result!.key_points.length > 0 && <span className="muted-xs">Discussed: {a.result!.key_points.join(" · ")}</span>}
            {a.result!.objections.length > 0 && <span className="muted-xs">Concerns: {a.result!.objections.join(", ")}</span>}
          </div>
          <span className="score" title="Client mood from −1 to +1">{a.result!.score >= 0 ? "+" : ""}{a.result!.score.toFixed(1)}</span>
        </li>)}
      </ul>
    </> : <p className="muted">No call has been analysed for this seller yet. Sarvam converts each recording to text, then classifies how the client responded. You can also paste earlier call transcripts with “Previous call context” before building the queue.</p>}
    {blocked.length > 0 && <details className="sentiment-blocked"><summary>{blocked.length} recording{blocked.length === 1 ? "" : "s"} could not be analysed</summary>
      <ul>{blocked.map(a => <li key={a.call_id}><strong>{STATUS_TEXT[a.status]}</strong> · {when(a.called_at)}{a.vendor ? ` · ${a.vendor}` : ""}<span className="muted-xs">{a.status_detail}</span></li>)}</ul>
    </details>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="sentiment-actions">
      <button type="button" className="btn btn-primary" onClick={analyse} disabled={busy}>{busy ? "Analysing with Sarvam…" : done.length ? "Analyse new recordings" : "Analyse recordings with Sarvam"}</button>
      <span className="muted-xs">Analyses up to 5 of the newest answered recordings. Recordings are sent to Sarvam AI for transcription; transcripts are not stored.</span>
    </div>
  </section>;
}
