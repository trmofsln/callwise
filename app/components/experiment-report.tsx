"use client";
import { useEffect, useState } from "react";
import type { ExperimentMetrics, ExperimentModelReport, ExperimentReport } from "@/lib/experiment-types";
import Icon from "./workspace-icon";

function number(value: number | null | undefined, digits=4) { return value===null||value===undefined?"Unavailable":value.toFixed(digits); }
function MetricRow({name,metrics}:{name:string;metrics:ExperimentMetrics|null}) {
  return <tr><td>{name}</td><td>{metrics?.attempts?.toLocaleString()??"—"}</td><td>{metrics?.proxy_events??"—"}</td><td>{number(metrics?.average_precision)}</td><td>{number(metrics?.roc_auc)}</td><td>{number(metrics?.log_loss)}</td><td>{number(metrics?.brier)}</td></tr>;
}
function ModelReport({model}:{model:ExperimentModelReport}) {
  return <article className="experiment-model"><div className="card-heading"><div><h3>{model.name}</h3><p>{model.candidate?.replaceAll("_"," ")||"Waiting for a frozen experiment"}</p></div><span className="tag">{model.status}</span></div>
    {model.reason&&<p className="muted">{model.reason}</p>}
    {model.test&&<><div className="experiment-support"><span><strong>{model.training_attempts?.toLocaleString()}</strong> training attempts</span><span><strong>{model.training_positives}</strong> training proxy events</span><span>{model.calibrated?"Validation-fitted calibration":"Insufficient positives for calibration"}</span></div>
      <div className="table-wrap"><table><thead><tr><th>Locked final test</th><th>Calls</th><th>Proxy events</th><th>AUPRC</th><th>ROC AUC</th><th>Log loss</th><th>Brier</th></tr></thead><tbody><MetricRow name="Selected model" metrics={model.test}/><MetricRow name="Baseline" metrics={model.baseline}/></tbody></table></div>
      <p className="experiment-assessment">{model.predictive_acceptance_met?"Predictive criteria met on this proxy endpoint.":"Predictive acceptance criteria are not met."} {model.support_sufficient?"":"Rare-event support limits the evaluation. "}Deployment remains unapproved.</p>
      {model.uncertainty.average_precision&&<p className="muted">AUPRC 95% seller-cluster interval: {number(model.uncertainty.average_precision.lower)}–{number(model.uncertainty.average_precision.upper)}.</p>}
    </>}
    {!!model.preview.length&&<details className="experiment-preview"><summary>Run output · experimental clock model</summary><p>These frozen-model scores demonstrate numerical inference on future configured hours. They estimate the recorded-met proxy and do not establish seller eligibility or canonical completion probability.</p><div className="table-wrap"><table><thead><tr><th>Future window</th><th>Proxy estimate</th><th>Training slot support</th></tr></thead><tbody>{model.preview.map(w=><tr key={w.start}><td>{new Intl.DateTimeFormat("en-IN",{timeZone:w.timezone,weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(w.start))}<small>{w.timezone}</small></td><td>{(w.proxy_score*100).toFixed(3)}%<small>{w.calibrated?"Validation calibrated":"Uncalibrated"}</small></td><td>{w.support} calls</td></tr>)}</tbody></table></div></details>}
    {model.model_version&&<p className="source-note">{model.model_version}</p>}
  </article>;
}
export default function ExperimentReportPanel() {
  const [report,setReport]=useState<ExperimentReport|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(true);
  async function refresh() { setBusy(true);setError("");try{const r=await fetch("/api/admin/experiments",{cache:"no-store"});const b=await r.json();if(!r.ok)throw Error(b.error);setReport(b);}catch(e){setError(e instanceof Error?e.message:"Could not load the experiment.");}finally{setBusy(false);} }
  useEffect(()=>{let active=true;fetch("/api/admin/experiments",{cache:"no-store"}).then(async r=>{const b=await r.json();if(!r.ok)throw Error(b.error);if(active)setReport(b);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  return <section className="search-panel experiment-report" id="experiments"><div className="card-heading"><div><span className="eyebrow">REAL DATA · OFFLINE EVALUATION</span><h2>Model experiment</h2></div><button type="button" className="secondary" onClick={refresh} disabled={busy}>{busy?"Loading…":"Refresh evidence"}</button></div><p>Read-only Redash extraction. Fixed chronological splits. Experimental target disclosed.</p>
    {error&&<div className="alert error" role="alert">{error}</div>}
    {report&&<><div className="experiment-banner"><Icon name="shield" size={19}/><span>Experimental recorded-met proxy · Canonical meeting_done unverified · No deployment approval</span></div><div className="lookup-metrics"><div><span>Database source</span><strong>13<small>pg-main-prod-live</small></strong></div><div><span>Extracted attempts</span><strong>{report.attempts?.toLocaleString()??"In progress"}<small>{report.checkpoints} checkpoints · cap {report.planned_checkpoints}</small></strong></div><div><span>Observed proxy events</span><strong>{report.proxy_events??"Pending"}<small>physical records linked within 14 days</small></strong></div><div><span>Unique sellers</span><strong>{report.sellers?.toLocaleString()??"Pending"}<small>time-only predictors</small></strong></div></div>
      {report.models.map(m=><ModelReport key={m.name} model={m}/>)}<details className="experiment-limitations"><summary>Target, coverage & interpretation</summary><ul>{report.limitations.map(l=><li key={l}>{l}</li>)}</ul><p>Endpoint: <code>{report.target}</code></p>{report.dataset_sha256&&<p className="source-note">Dataset SHA-256: {report.dataset_sha256}</p>}</details>
    </>}
  </section>;
}
