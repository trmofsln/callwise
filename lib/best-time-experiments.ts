import { readFile, readdir, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { candidateWindows, localParts } from "./best-time-policy";
import type { ModelArtifact, PredictionContext, SchedulingSettings } from "./best-time-types";
import type { ClockPreview, ExperimentMetrics, ExperimentModelReport, ExperimentReport } from "./experiment-types";

export const EXPERIMENT_TARGET = "observed_linked_physical_recorded_met_within14days" as const;
// Live general proxy fallback: research-v4 retrained hour/day table (docs/best-time-to-call/research-v4).
// Roll back with BTC_EXPERIMENT_DIRECTORY=.data/btc-operational-v3.
export const DEFAULT_EXPERIMENT_DIRECTORY = "models/live";
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue { return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {}; }
function finite(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function string(value: unknown): string | null { return typeof value === "string" && value.length <= 300 ? value : null; }
export function reportMetrics(value: unknown): ExperimentMetrics | null {
  const v=object(value);if(!Object.keys(v).length)return null;
  return {attempts:finite(v.attempts),proxy_events:finite(v.completed_meetings),prevalence:finite(v.class_prevalence),average_precision:finite(v.average_precision),roc_auc:finite(v.roc_auc),brier:finite(v.brier),log_loss:finite(v.log_loss)};
}
async function json(filename: string): Promise<RecordValue | null> {
  try { if((await stat(filename)).size>2_000_000)throw Error("Report size limit.");return object(JSON.parse(await readFile(filename,"utf8"))); }
  catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT")return null;throw Error("An experiment report could not be verified."); }
}

// This preview has no seller context. It demonstrates a frozen experimental clock model.
// Canonical recommendation probabilities remain under the approved-model registry.
export function scoreExperimentalClock(value: unknown, windows: {start:string;end:string;timezone:string}[], limit=3, poolHours=false): ClockPreview[] {
  const m=value as Omit<ModelArtifact,"route"> & { experimental: boolean; trained_target: string; route: string };
  if(!m || m.schema_version!==1 || m.experimental!==true || m.label_kind!=="proxy" || m.trained_target!==EXPERIMENT_TARGET || m.deployment?.approved!==false || !["cold_start_observed_scope","erp_outbound_observed_proxy"].includes(m.route))throw Error("Separate unapproved proxy artifact required.");
  if(!m.smoothing || m.smoothing.global.count!==m.evidence?.training_attempts || m.smoothing.global.positive!==m.evidence?.training_positives || m.smoothing.strength<=0)throw Error("Proxy evidence does not reconcile.");
  for(const bin of [m.smoothing.global,...Object.values(m.smoothing.bins||{})])if(!Number.isInteger(bin.count)||!Number.isInteger(bin.positive)||bin.count<0||bin.positive<0||bin.positive>bin.count)throw Error("Invalid proxy support.");
  const allowed=new Set(["hour_sin","hour_cos",...Array.from({length:7},(_,i)=>`weekday_${i}`)]);
  if(!m.feature_schema?.feature_names?.every(name=>allowed.has(name)) || Object.keys(m.feature_schema.categories||{}).length)throw Error("Only clock features can enter this experimental preview.");
  if(!["logistic","hour_day","cohort_hour_day"].includes(m.family))throw Error("Unsupported proxy model.");
  if(m.family==="logistic" && (!m.logistic || !Number.isFinite(m.logistic.intercept) || m.logistic.coefficients.length!==m.feature_schema.feature_names.length || m.logistic.coefficients.some(c=>!Number.isFinite(c))))throw Error("Invalid proxy coefficients.");
  if(!m.calibration || (m.calibration.calibrated && (m.calibration.kind!=="platt" || !Number.isFinite(m.calibration.slope) || !Number.isFinite(m.calibration.intercept))))throw Error("Invalid proxy calibration.");
  if(m.calibration.clip!==undefined&&(!Number.isFinite(m.calibration.clip)||m.calibration.clip<=0||m.calibration.clip>=.5))throw Error("Invalid proxy clipping.");
  const rate=(m.smoothing.global.positive+1)/(m.smoothing.global.count+2),result:ClockPreview[]=[];
  for(const window of windows) {
    if(window.timezone!==m.timezone || !Number.isFinite(Date.parse(window.start)) || !Number.isFinite(Date.parse(window.end)) || Date.parse(window.end)<=Date.parse(window.start))throw Error("Invalid experimental clock window.");
    const p=localParts(window.start,m.timezone);
    let bin=m.smoothing.bins[`${p.weekday}:${p.hour}`];
    if((!bin||bin.count<5)&&poolHours)bin=Object.entries(m.smoothing.bins).filter(([key])=>key.endsWith(`:${p.hour}`)).reduce((s,[,b])=>({count:s.count+b.count,positive:s.positive+b.positive}),{count:0,positive:0});
    if(!bin || bin.count<5)continue;
    let score=(bin.positive+m.smoothing.strength*rate)/(bin.count+m.smoothing.strength);
    if(m.family==="logistic" && m.logistic) {
      const angle=2*Math.PI*(p.hour+p.minute/60+p.second/3600)/24;
      const values:Record<string,number>={hour_sin:Math.sin(angle),hour_cos:Math.cos(angle)};
      for(let day=0;day<7;day++)values[`weekday_${day}`]=Number(p.weekday===day);
      const z=m.logistic.intercept+m.logistic.coefficients.reduce((sum,c,i)=>sum+c*values[m.feature_schema.feature_names[i]],0);
      score=1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
    }
    if(m.calibration.calibrated) {
      const clip=m.calibration.clip||1e-8;score=Math.max(clip,Math.min(1-clip,score));
      score=1/(1+Math.exp(-(m.calibration.slope!*Math.log(score/(1-score))+m.calibration.intercept!)));
    }
    if(!Number.isFinite(score)||score<0||score>1)throw Error("Invalid proxy score.");
    result.push({...window,proxy_score:score,support:bin.count,calibrated:m.calibration.calibrated===true});
  }
  return result.sort((a,b)=>b.proxy_score-a.proxy_score||Date.parse(a.start)-Date.parse(b.start)).slice(0,limit);
}

async function modelReport(root: string, folder: string, name: string, windows: ClockPreview[]): Promise<ExperimentModelReport> {
  const report:ExperimentModelReport={name,route:folder,status:"pending",model_version:null,candidate:null,trained_target:EXPERIMENT_TARGET,training_attempts:null,training_positives:null,validation:null,test:null,baseline:null,calibrated:false,support_sufficient:false,predictive_acceptance_met:false,uncertainty:{average_precision:null},preview:[],reason:null};
  try {
    const directory=path.join(root,"models",folder),card=await json(path.join(directory,"model-card.json"));
    if(!card)return report;
    if(card.trained!==true){report.status="blocked";report.reason=string(card.reason)||"Insufficient verified experimental support.";return report;}
    if(card.experimental!==true||card.label_kind!=="proxy"||card.trained_target!==EXPERIMENT_TARGET||card.deployment_approved!==false)throw Error("Experiment identity mismatch.");
    const [model,freeze,test,experiments]=await Promise.all([json(path.join(directory,"model.json")),json(path.join(directory,"freeze.json")),json(path.join(directory,"test-results.json")),json(path.join(directory,"experiments.json"))]);
    const bytes=await readFile(path.join(directory,"model.json"));
    if(!model||!freeze||createHash("sha256").update(bytes).digest("hex")!==freeze.model_sha256 || card.model_version!==model.model_version || (test && test.model_version!==card.model_version))throw Error("Frozen model provenance mismatch.");
    report.status=test?"evaluated":"trained";report.route=string(card.route)||folder;report.model_version=string(card.model_version);report.candidate=string(experiments?.selected_candidate);report.validation=reportMetrics(card.validation_metrics);report.test=reportMetrics(test?.selected_metrics);report.baseline=reportMetrics(test?.hour_day_baseline_metrics);
    report.training_attempts=finite(object(model.evidence).training_attempts);report.training_positives=finite(object(model.evidence).training_positives);report.calibrated=object(card.calibration).calibrated===true;report.support_sufficient=test?.support_sufficient===true;report.predictive_acceptance_met=test?.predictive_acceptance_met===true;
    const ci=object(object(object(test?.uncertainty).intervals).average_precision);
    if(finite(ci.lower)!==null&&finite(ci.upper)!==null)report.uncertainty.average_precision={lower:ci.lower as number,upper:ci.upper as number};
    report.preview=scoreExperimentalClock(model,windows);
  } catch {report.status="invalid";report.reason="The experiment artifact failed provenance or schema validation.";}
  return report;
}

export async function readExperimentReport(settings: SchedulingSettings): Promise<ExperimentReport> {
  const root=path.resolve(/*turbopackIgnore: true*/process.cwd(),process.env.BTC_EXPERIMENT_DIRECTORY||DEFAULT_EXPERIMENT_DIRECTORY);
  const [manifest,plan]=await Promise.all([json(path.join(root,"dataset-manifest.json")),json(path.join(root,"plan.json"))]);
  let checkpoints=0;try{checkpoints=(await readdir(path.join(root,"raw"))).filter(f=>f.endsWith(".json")).length;}catch{}
  const now=new Date().toISOString();
  const context:PredictionContext={context_id:"admin-clock-preview",glid:"0",as_of:now,timezone:settings.timezone,history_status:"verified",history_scope:"Clock-model demonstration; no seller eligibility asserted.",first_contact_verified:false,prior_calls:0,recent_attempts:0,attempts_today:0,last_call_at:null,last_unanswered_at:null,do_not_call:false,appointments:[],metadata:{},issues:[],proxy_completed_meetings:0};
  const windows=candidateWindows(context,{...settings,enabled:true,horizonDays:14}).map(w=>({...w,proxy_score:0,calibrated:false}));
  const models=await Promise.all([modelReport(root,"general_erp","General ERP · time only",windows),modelReport(root,"cold_start","First contact · observed scope",windows)]);
  const dateCount=Object.values(object(plan?.dates)).reduce<number>((sum,dates)=>sum+(Array.isArray(dates)?dates.length:0),0);
  return {state:models.some(m=>m.status==="evaluated")?"evaluated":manifest?"prepared":plan?"extracting":"not_started",target:EXPERIMENT_TARGET,canonical_label_verified:false,deployment_approved:false,policy_lift_measured:false,source_id:13,attempts:finite(manifest?.deduplicated_rows),sellers:finite(manifest?.sellers),proxy_events:finite(manifest?.positives),checkpoints,planned_checkpoints:dateCount*Number(plan?.chunks_per_day||80),as_of:string(manifest?.as_of),dataset_sha256:string(manifest?.dataset_sha256),models,limitations:["Target: a seller-linked physical recorded-met record within 14 days; canonical meeting_done remains unverified.","Current replica observations do not prove original historical availability or lifetime first-contact coverage.","Only hour and weekday enter these experimental models; present-day seller metadata is excluded.","Observed schedules and limited weekday support do not establish causal meeting lift. The general model also supplies advisory slot rankings when personal history is inconclusive; these are not canonical meeting probabilities."]};
}
