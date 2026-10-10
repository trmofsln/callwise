"use client";

import { useState } from "react";
import Icon from "./workspace-icon";
import { SarvamMark } from "./sentiment";

export type CallContextDraft = { glid: string; calls: { text: string; at: string }[] };

export const CALL_LIMITS = { calls: 10, chars: 8000 } as const;

/** GLIDs as typed in the lookup box, normalised the way the server does (no leading zeros). */
export function typedGlids(input: string): string[] {
  return [...new Set(input.split(",").map(v => v.trim()).filter(v => /^\d{1,19}$/.test(v)).map(v => v.replace(/^0+(?=\d)/, "")))];
}

/** Calls with text, in order. Null when nothing was entered. */
export function filledContext(draft: CallContextDraft | null): CallContextDraft | null {
  const calls = draft?.calls.filter(c => c.text.trim()) ?? [];
  return draft && calls.length ? { glid: draft.glid, calls } : null;
}

/** Request body for /api/users; the time is local (IST) wall-clock from the datetime input. */
export function contextPayload(draft: CallContextDraft | null, glids: string[]) {
  const filled = filledContext(draft);
  if (!filled) return undefined;
  const glid = glids.includes(filled.glid) ? filled.glid : glids[0];
  return { glid, calls: filled.calls.map(c => ({ text: c.text, at: c.at || null })) };
}

const blank = () => ({ text: "", at: "" });

/** Notepad for earlier call transcripts or notes, Call 1 oldest. Sarvam reads them when the queue is built. */
export function CallContextDialog({ glids, value, onSave, onClose }: { glids: string[]; value: CallContextDraft | null; onSave: (draft: CallContextDraft | null) => void; onClose: () => void }) {
  const [glid, setGlid] = useState(value && glids.includes(value.glid) ? value.glid : glids[0] ?? "");
  const [calls, setCalls] = useState(value?.calls.length ? value.calls : [blank()]);
  const [now] = useState(() => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const update = (index: number, patch: Partial<{ text: string; at: string }>) => setCalls(list => list.map((c, i) => i === index ? { ...c, ...patch } : c));
  const filled = calls.filter(c => c.text.trim()).length;

  function save() {
    onSave(filled ? { glid, calls } : null);
    onClose();
  }

  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="modal call-context-modal" role="dialog" aria-modal="true" aria-labelledby="context-title" onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
      <div className="modal-head">
        <div><h2 id="context-title">Previous call context</h2><p>Optional. Paste transcripts or notes from earlier calls with this seller, oldest first.</p></div>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="context-intro">
        <SarvamMark />
        <p>Sarvam AI reads each call for the seller&apos;s sentiment, a short summary, and any callback they asked for. A callback time inside the planning period becomes the best time to call. A later one is noted in the plan.</p>
      </div>
      {glids.length > 1 ? <label className="field context-glid">Seller (GLID)
        <select value={glid} onChange={e => setGlid(e.target.value)}>{glids.map(g => <option key={g} value={g}>{g}</option>)}</select>
      </label> : <p className="muted-xs">{glids.length ? `Applies to GLID ${glids[0]}.` : "Applies to the first GLID you enter."}</p>}
      <ol className="context-calls">
        {calls.map((call, index) => <li key={index} className="notepad">
          <div className="notepad-head">
            <strong>Call {index + 1} transcription</strong>
            <label className="notepad-when"><span>When</span><input type="datetime-local" value={call.at} max={now} onChange={e => update(index, { at: e.target.value })} aria-label={`Call ${index + 1} date and time`} /></label>
            {calls.length > 1 && <button type="button" className="icon-btn" aria-label={`Remove call ${index + 1}`} onClick={() => setCalls(list => list.filter((_, i) => i !== index))}><Icon name="x" size={15} /></button>}
          </div>
          <textarea value={call.text} maxLength={CALL_LIMITS.chars} rows={6} spellCheck={false} autoFocus={index === calls.length - 1 && !call.text}
            placeholder={index === 0 ? "e.g. Rep: Namaste, IndiaMART se bol raha hoon…\nSeller: Abhi busy hoon, shaam 7:30 ke baad call karna." : "Paste the next call…"}
            onChange={e => update(index, { text: e.target.value })} aria-label={`Call ${index + 1} transcription`} />
          <span className="notepad-count">{call.text.length.toLocaleString("en-IN")} / {CALL_LIMITS.chars.toLocaleString("en-IN")}</span>
        </li>)}
      </ol>
      <div className="context-foot">
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setCalls(list => [...list, blank()])} disabled={calls.length >= CALL_LIMITS.calls}><Icon name="note" size={14} />Add call</button>
        <span className="muted-xs">Leave “When” empty if the call was today. Transcripts are sent to Sarvam AI and are not stored.</span>
        <div className="context-actions">
          {value && <button type="button" className="btn btn-secondary" onClick={() => { onSave(null); onClose(); }}>Clear</button>}
          <button type="button" className="btn btn-primary" onClick={save}>{filled ? `Use ${filled} call${filled === 1 ? "" : "s"}` : "Save"}</button>
        </div>
      </div>
    </div>
  </div>;
}
