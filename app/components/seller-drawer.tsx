"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "./workspace-icon";
import CallRecommendation from "./call-recommendation";
import UserActivitySection from "./user-activity";
import GlobalContextSection from "./global-context";
import { DevJson } from "./dev-mode";
import { LogCallForm } from "./log-call";
import { outcomeMeta, removeLogEntry, type CallLogEntry } from "./call-log";
import { ConfidenceBadge, StatusBadge } from "./queue-table";
import { displayName, relativeWindow, type SellerRow } from "./seller-model";
import { useToast } from "./toast";
import ConversationPanel, { LastCallSentiment, SarvamMark, SentimentChip } from "./sentiment";
import SellerFactorChips from "./seller-factors";

type Tab = "plan" | "conversations" | "history" | "profile" | "context" | "log";

function formatDate(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { dateStyle: "medium" }).format(date);
}

export default function SellerDrawer({ row, now, lookupId, log, onClose, onRefresh }: { row: SellerRow; now: number; lookupId: string | null; log: CallLogEntry[]; onClose: () => void; onRefresh: (glid: string) => Promise<void> | void }) {
  const [tab, setTab] = useState<Tab>("plan");
  const panel = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const user = row.user, label = displayName(row), w = relativeWindow(row, now);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    document.body.classList.add("drawer-open");
    return () => { document.removeEventListener("keydown", onKey); document.body.classList.remove("drawer-open"); previous?.focus?.(); };
  }, [onClose]);

  async function copyGlid() {
    try { await navigator.clipboard.writeText(row.glid); toast({ tone: "success", message: `GLID ${row.glid} copied. Paste it into the ERP dialler.` }); }
    catch { toast({ tone: "error", message: "Could not copy. Select the GLID and copy it manually." }); }
  }

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: "plan", label: "Calling plan" },
    { key: "conversations", label: "Conversations", count: (user?.recordingAnalyses ?? []).filter(a => a.status === "analyzed").length },
    { key: "history", label: "History", count: user ? user.activity.metrics.callCount + user.activity.metrics.meetingCount : 0 },
    { key: "profile", label: "Profile" },
    { key: "context", label: "Global Context" },
    { key: "log", label: "Outcomes", count: log.length },
  ];

  return <div className="drawer-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" ref={panel} tabIndex={-1}>
      <header className="drawer-head">
        <div className="drawer-title">
          <span className="eyebrow">Seller</span>
          <h2 id="drawer-title">{label}</h2>
          <div className="drawer-meta">
            <button type="button" className="chip-btn" onClick={copyGlid} title="Copy GLID"><Icon name="copy" size={13} />GLID {row.glid}</button>
            {row.city && <span>{row.city}</span>}{row.customerType && <span>{row.customerType}</span>}{row.reps.length > 0 && <span>Rep: {row.reps.join(", ")}</span>}
          </div>
        </div>
        <button type="button" className="icon-btn" aria-label="Close seller details" onClick={onClose}><Icon name="x" size={18} /></button>
      </header>
      <div className="drawer-summary">
        <div><span className="label label-with-mark">Best time<SarvamMark compact /></span><div className="summary-when"><StatusBadge status={row.status} /><strong>{w.label}</strong></div><span className="muted-xs">{w.detail}</span></div>
        <div><span className="label">Confidence</span><ConfidenceBadge level={row.confidence} /></div>
        <div><span className="label">History</span><strong>{row.calls} calls · {row.successfulMeetings} meetings</strong><span className="muted-xs">{row.answeredCalls} answered</span></div>
        <div className="summary-cta"><button type="button" className="btn btn-primary" onClick={() => setTab("log")}><Icon name="check" size={15} />Log call outcome</button></div>
      </div>
      <div className="tabs drawer-tabs" role="tablist" aria-label="Seller details">
        {tabs.map(t => <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={tab === t.key ? "tab active" : "tab"} onClick={() => setTab(t.key)}>{t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}</button>)}
      </div>
      <div className="drawer-body" role="tabpanel">
        {tab === "plan" && (row.prediction ? <>
          {row.prediction.conversation?.latest && <LastCallSentiment sentiment={row.prediction.conversation.latest.sentiment} score={row.prediction.conversation.latest.score} summary={row.prediction.conversation.latest.summary} at={row.prediction.conversation.latest.at} />}
          <CallRecommendation prediction={row.prediction} />
          <SellerFactorChips factors={row.prediction.seller_factors} title="Seller factors used for retries" />
        </> : <p className="empty-inline-text">No calling recommendation was returned for this seller.</p>)}
        {tab === "conversations" && <ConversationPanel glid={row.glid} analyses={user?.recordingAnalyses ?? []} onAnalyzed={onRefresh} />}
        {tab === "history" && (user ? <UserActivitySection activity={user.activity} /> : <p className="empty-inline-text">No user record was found, so there is no call or meeting history.</p>)}
        {tab === "profile" && (user ? <>
          <dl className="facts profile-facts">
            <div><dt>User created</dt><dd>{formatDate(user.createdAt)}</dd></div>
            <div><dt>Customer type</dt><dd>{user.customerType || "Not available"}</dd></div>
            <div><dt>Designation</dt><dd>{user.designation || "Not available"}</dd></div>
          </dl>
          <section className="card-section"><h3>Company records <span>{user.company.length}</span></h3>
            {user.company.length ? user.company.map((company, index) => <div className="company-row" key={String(company.companyid ?? index)}>
              <strong>Company {String(company.companyid ?? "—")}</strong><span>{[company.city, company.state, company.country].filter(Boolean).map(String).join(", ") || "Location unavailable"}</span>
              <span>Created {formatDate(company.creationdate ? String(company.creationdate) : null)}</span><span>{company.custtype_name ? String(company.custtype_name) : "Type unavailable"}</span>
            </div>) : <p className="muted">No company record linked to this GLID.</p>}
          </section>
          <section className="card-section"><h3>Assignment</h3>
            {user.assignments.length ? <div className="table-scroll"><table className="data-table compact"><thead><tr><th>STS company</th><th>Assigned employee</th><th>Employee ID</th><th>Vertical</th></tr></thead><tbody>
              {user.assignments.map((a, i) => <tr key={i}><td>{String(a.record.companyid ?? "—")}</td><td>{a.employee?.name || "Not available"}</td><td>{a.employee?.employeeId || String(a.record.assignedto ?? "—")}</td><td>{a.vertical?.name || "Not available"}</td></tr>)}
            </tbody></table></div> : <p className="muted">No STS assignment linked to this GLID.</p>}
          </section>
          <DevJson label="User lookup API response" data={user} />
        </> : <p className="empty-inline-text">No user record was found for this GLID.</p>)}
        {tab === "context" && (row.context ? <GlobalContextSection context={row.context} /> : <p className="empty-inline-text">Global Context was not returned for this GLID.</p>)}
        {tab === "log" && <>
          <LogCallForm glid={row.glid} label={label} lookupId={lookupId} />
          <section className="card-section"><h3>Logged in this browser <span>{log.length}</span></h3>
            {log.length ? <ul className="log-list">{[...log].reverse().map(e => <li key={e.id}>
              <span className={`badge badge-${outcomeMeta(e.outcome).tone}`}>{outcomeMeta(e.outcome).label}</span>
              <div><strong>{new Date(e.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</strong>
                {e.followUpAt && <span className="muted-xs">Follow-up {new Date(e.followUpAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>}
                {e.note && <p>{e.note}</p>}
                {e.retry && <div className="log-retry">{e.retry.sentiment && <SentimentChip sentiment={e.retry.sentiment} compact />}<span><b>{e.retry.call_at ? `Retry ${new Date(e.retry.call_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : "No retry"}</b> · {e.retry.reason}</span><small>{e.retry.source === "llm" ? `AI plan · ${e.retry.model}` : "Rules engine"}</small></div>}</div>
              <button type="button" className="link-btn" onClick={() => removeLogEntry(e.id)}>Remove</button>
            </li>)}</ul> : <p className="muted">Nothing logged yet. ERP call history is in the History tab.</p>}
          </section>
        </>}
      </div>
    </div>
  </div>;
}
