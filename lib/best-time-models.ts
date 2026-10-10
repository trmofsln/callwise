import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { localParts } from "./best-time-policy";
import type { CallWindow, ModelArtifact, PredictionContext, PredictionRoute } from "./best-time-types";
import { loadGeneralizedModel, type GeneralizedModel } from "./best-time-generalized";

export type ModelRegistry = { history_aware: ModelArtifact | null; cold_start: ModelArtifact | null; generalized?: GeneralizedModel | null; issues: string[] };
const cache = new Map<string,{ stamp: number; model: ModelArtifact }>();
export function validateArtifact(value: unknown, route: "history_aware" | "cold_start"): ModelArtifact {
  const m=value as ModelArtifact;
  if (!m || m.schema_version!==1 || m.route!==route || m.primary_target!=="meeting_done" || typeof m.model_version!=="string" || !/^[\w.:-]{1,100}$/.test(m.model_version)) throw new Error("Invalid artifact identity or target.");
  if (m.label_kind!=="canonical" || m.deployment?.approved!==true || m.calibration?.calibrated!==true) throw new Error("Artifact has no approved, calibrated canonical meeting_done evaluation.");
  if (!/^[a-f0-9]{64}$/.test(m.dataset_sha256||"") || !/^[a-f0-9]{64}$/.test(m.split_sha256||"")) throw new Error("Missing artifact dataset/split provenance.");
  if (!Number.isInteger(m.evidence?.training_attempts) || !Number.isInteger(m.evidence?.training_positives) || m.evidence.training_attempts<100 || m.evidence.training_positives<10) throw new Error("Artifact has insufficient training support.");
  if (!m.smoothing || !Number.isFinite(m.smoothing.strength) || m.smoothing.strength<=0 || !m.smoothing.bins || Object.keys(m.smoothing.bins).length>168) throw new Error("Invalid smoothing schema.");
  for(const b of [m.smoothing.global,...Object.values(m.smoothing.bins)]) if(!Number.isInteger(b.count) || !Number.isInteger(b.positive) || b.count<0 || b.positive<0 || b.positive>b.count) throw new Error("Invalid artifact evidence counts.");
  if(m.smoothing.global.count!==m.evidence.training_attempts || m.smoothing.global.positive!==m.evidence.training_positives) throw new Error("Artifact training evidence does not reconcile.");
  for(const [field,groups] of Object.entries(m.smoothing.cohorts||{})) {
    if(!["industry","state","segment"].includes(field)) throw new Error("Unsupported cohort field.");
    for(const slots of Object.values(groups)) for(const b of Object.values(slots)) if(!Number.isInteger(b.count)||!Number.isInteger(b.positive)||b.count<0||b.positive<0||b.positive>b.count||b.count>m.smoothing.global.count) throw new Error("Invalid cohort evidence.");
  }
  if (!Array.isArray(m.feature_schema?.feature_names) || m.feature_schema.feature_names.length>1000) throw new Error("Missing feature schema.");
  if (m.family==="logistic") {
    if(!m.logistic || m.logistic.coefficients.length!==m.feature_schema.feature_names.length || !Number.isFinite(m.logistic.intercept) || m.logistic.coefficients.some(v=>!Number.isFinite(v))) throw new Error("Invalid logistic coefficients.");
    const allowed=new Set(["hour_sin","hour_cos","account_age_log1p","account_age_missing","prior_attempts_log1p","retry_gap_log1p","retry_gap_missing",...Array.from({length:7},(_,i)=>`weekday_${i}`)]);
    for(const [field,vocabulary] of Object.entries(m.feature_schema.categories||{})) {
      if(!["city","state","industry","business_type","segment"].includes(field) || !Array.isArray(vocabulary) || vocabulary.length>1000 || vocabulary.some(v=>typeof v!=="string"||v.length>200)) throw new Error("Invalid category schema.");
      for(const value of vocabulary) {allowed.add(`${field}=${value}`);if(m.feature_schema.interaction_fields?.includes(field)){allowed.add(`${field}=${value}*hour_sin`);allowed.add(`${field}=${value}*hour_cos`);}}
    }
    if(m.feature_schema.feature_names.some(n=>!allowed.has(n))) throw new Error("Artifact requires unavailable pre-call features.");
    if(m.route==="cold_start" && m.feature_schema.feature_names.some(n=>/^(prior_attempts|retry_gap)/.test(n))) throw new Error("Cold-start model cannot require personal call history.");
  } else if(!["hour_day","cohort_hour_day"].includes(m.family)) throw new Error("Unsupported model family.");
  if(m.calibration.kind!=="platt" || !Number.isFinite(m.calibration.slope) || !Number.isFinite(m.calibration.intercept)) throw new Error("No supported calibration parameters.");
  if(m.calibration.clip!==undefined && (!Number.isFinite(m.calibration.clip)||m.calibration.clip<=0||m.calibration.clip>=.5)) throw new Error("Invalid calibration clipping.");
  if(m.feature_schema.account_age_cap_days!==undefined && (!Number.isFinite(m.feature_schema.account_age_cap_days)||m.feature_schema.account_age_cap_days<=0)) throw new Error("Invalid age feature limit.");
  new Intl.DateTimeFormat("en",{timeZone:m.timezone}).format();
  return m;
}
export async function loadRegistry(): Promise<ModelRegistry> {
  const registry: ModelRegistry={history_aware:null,cold_start:null,issues:[]};
  const directory=path.resolve(/*turbopackIgnore: true*/ process.cwd(),process.env.BTC_MODEL_DIRECTORY||".data/best-time-to-call/models");
  for(const route of ["history_aware","cold_start"] as const) {
    const filename=path.join(directory,`${route}.json`);
    try {
      const info=await stat(filename);
      if(info.size>2_000_000) throw new Error("Artifact exceeds size limit.");
      const previous=cache.get(filename);
      const model=previous?.stamp===info.mtimeMs?previous.model:validateArtifact(JSON.parse(await readFile(filename,"utf8")),route);
      cache.set(filename,{stamp:info.mtimeMs,model}); registry[route]=model;
    } catch(error) {
      registry.issues.push(`${route}: ${(error as NodeJS.ErrnoException).code==="ENOENT"?"No trained approved artifact is available.":error instanceof Error?error.message:"Artifact could not be loaded."}`);
    }
  }
  const general=await loadGeneralizedModel();registry.generalized=general.model;
  if(general.issue)registry.issues.push(general.issue);
  return registry;
}
export function chooseModel(route: PredictionRoute, registry: ModelRegistry): ModelArtifact | null {
  if(route==="history_aware") return registry.history_aware;
  // Sparse sellers use the approved cohort path; no invented ensemble weights.
  if(route==="sparse_history" || route==="cold_start") return registry.cold_start;
  return null;
}
export function scoreWindows(context: PredictionContext, windows: CallWindow[], model: ModelArtifact): CallWindow[] {
  if(model.timezone!==context.timezone) throw new Error("Artifact and seller timezone differ.");
  const global=model.smoothing.global, rate=(global.positive+1)/(global.count+2);
  const scored=windows.map(window=>{
    const p=localParts(window.start,context.timezone), key=`${p.weekday}:${p.hour}`, bin=model.smoothing.bins[key];
    if(!bin || bin.count<5) return window;
    let score=(bin.positive+model.smoothing.strength*rate)/(bin.count+model.smoothing.strength);
    let support=bin.count;
    if(model.family==="cohort_hour_day") {
      const cohorts=["industry","state","segment"].flatMap(field=>{
        const value=context.metadata[field],cohort=value?model.smoothing.cohorts?.[field]?.[value]?.[key]:null;
        return cohort&&cohort.count>=5?[cohort]:[];
      }).sort((a,b)=>b.count-a.count);
      if(cohorts.length) {support=cohorts[0].count;score=(cohorts[0].positive+model.smoothing.strength*score)/(support+model.smoothing.strength);}
    }
    if(model.family==="logistic" && model.logistic) {
      const angle=2*Math.PI*(p.hour+p.minute/60+(model.route==="cold_start"?p.second/3600:0))/24;
      const gap=context.last_call_at?Math.max(0,(Date.parse(window.start)-Date.parse(context.last_call_at))/60000):0;
      const featureValues: Record<string,number>={hour_sin:Math.sin(angle),hour_cos:Math.cos(angle),prior_attempts_log1p:Math.log1p(Math.min(context.prior_calls,100))/Math.log(101),retry_gap_log1p:Math.log1p(Math.min(gap,10080))/Math.log(10081),retry_gap_missing:context.last_call_at?0:1};
      for(let day=0;day<7;day++) featureValues[`weekday_${day}`]=p.weekday===day?1:0;
      const created=context.metadata.account_created_at?Date.parse(context.metadata.account_created_at):NaN;
      const cap=model.feature_schema.account_age_cap_days||3650;
      featureValues.account_age_log1p=Number.isFinite(created)?Math.log1p(Math.min(cap,Math.max(0,(Date.parse(window.start)-created)/86400000)))/Math.log1p(cap):0;
      featureValues.account_age_missing=Number.isFinite(created)?0:1;
      for(const [field,vocabulary] of Object.entries(model.feature_schema.categories||{})) {
        let value=context.metadata[field]||"__missing__";if(!vocabulary.includes(value))value="__other__";
        for(const category of vocabulary) {
          const name=`${field}=${category}`;featureValues[name]=value===category?1:0;
          featureValues[`${name}*hour_sin`]=featureValues[name]*featureValues.hour_sin;
          featureValues[`${name}*hour_cos`]=featureValues[name]*featureValues.hour_cos;
        }
      }
      const z=model.logistic.intercept+model.logistic.coefficients.reduce((sum,c,i)=>sum+c*featureValues[model.feature_schema.feature_names[i]],0);
      score=1/(1+Math.exp(-Math.max(-40,Math.min(40,z))));
    }
    const clip=model.calibration.clip||1e-8;
    score=Math.max(clip,Math.min(1-clip,score));
    const logit=Math.log(score/(1-score));
    score=1/(1+Math.exp(-(model.calibration.slope!*logit+model.calibration.intercept!)));
    if(!Number.isFinite(score)||score<0||score>1) throw new Error("Model returned an invalid probability.");
    // Slot uncertainty is deliberately not described as individual model confidence.
    return {...window,score,score_target:"meeting_done" as const,support,uncertainty:null};
  });
  return scored.sort((a,b)=>(b.score??-1)-(a.score??-1)||Date.parse(a.start)-Date.parse(b.start));
}
