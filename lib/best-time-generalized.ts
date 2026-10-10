import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { DEFAULT_EXPERIMENT_DIRECTORY, EXPERIMENT_TARGET, reportMetrics, scoreExperimentalClock } from "./best-time-experiments";
import type { ExperimentMetrics } from "./experiment-types";
import type { ModelArtifact } from "./best-time-types";
export type GeneralizedModel = Omit<ModelArtifact,"route"> & {route:string;experimental:true;trained_target:string;evaluation?:ExperimentMetrics|null};
async function readJson(filename:string) {
  if((await stat(filename)).size>2_000_000)throw Error("Generalized artifact exceeds size limit.");
  const bytes=await readFile(filename),value=JSON.parse(bytes.toString("utf8"));
  return {bytes,value};
}
export async function loadGeneralizedModel():Promise<{model:GeneralizedModel|null;issue:string|null}> {
  try {
    const root=path.resolve(/*turbopackIgnore: true*/process.cwd(),process.env.BTC_EXPERIMENT_DIRECTORY||DEFAULT_EXPERIMENT_DIRECTORY,"models","general_erp");
    const [model,freeze,card,test]=await Promise.all(["model.json","freeze.json","model-card.json","test-results.json"].map(f=>readJson(path.join(/*turbopackIgnore: true*/root,f))));
    const m=model.value,c=card.value,t=test.value;
    if(createHash("sha256").update(model.bytes).digest("hex")!==freeze.value.model_sha256 || c.model_version!==m.model_version || t.model_version!==m.model_version || freeze.value.dataset_sha256!==m.dataset_sha256 || t.model_sha256!==freeze.value.model_sha256 || t.trained_target!==EXPERIMENT_TARGET || c.trained!==true || c.trained_target!==EXPERIMENT_TARGET || t.support_sufficient!==true || t.predictive_acceptance_met!==true || m.route!=="erp_outbound_observed_proxy")throw Error("Generalized model provenance or held-out support failed.");
    scoreExperimentalClock(m,[]);
    return {model:{...m,evaluation:reportMetrics(t.selected_metrics)},issue:null};
  }catch{return {model:null,issue:"A frozen general proxy model with sufficient held-out support is unavailable; configured hours are the last fallback."};}
}
