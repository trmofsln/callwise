/* eslint-disable @typescript-eslint/no-require-imports -- Export aggregate evidence only, and store experiment metadata. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {loadServer}=require('./server-loader.cjs');
const {getAdminStore}=loadServer('lib/sqlite.ts');
const names=['data-quality','live-schema-report','openrouter-smoke','retry-audit','http-smoke','browser-smoke','inference-smoke','retry-ranking-live','model-display-live'];
async function main() {
const summary={generated_at:new Date().toISOString(),primary_target:'meeting_done',canonical_models_trained:false,canonical_held_out_results:null,policy_lift_measured:false};
summary.environment={node:process.versions.node,packages:Object.fromEntries(['next','react','typescript'].map(name=>[name,JSON.parse(fs.readFileSync(`node_modules/${name}/package.json`,'utf8')).version])),extraction_seed:42,bootstrap_seed:1729};
const python=spawnSync('python',['-c','import json,platform,importlib.metadata; print(json.dumps({"python":platform.python_version(),"packages":{p:importlib.metadata.version(p) for p in ["numpy","tzdata","pypdf"]}}))'],{encoding:'utf8',timeout:10000});if(python.status===0)summary.environment.python=JSON.parse(python.stdout);
for(const name of names) {
  const f=`.data/best-time-to-call/${name}.json`;if(fs.existsSync(f))summary[name.replaceAll('-','_')]=JSON.parse(fs.readFileSync(f,'utf8'));
}
const sourceChecks='.data/best-time-to-call/source-checks/report.json';if(fs.existsSync(sourceChecks))summary.source_checks=JSON.parse(fs.readFileSync(sourceChecks,'utf8'));
const browserQa='.data/best-time-to-call/browser-smoke-qa.json';if(fs.existsSync(browserQa))summary.authenticated_browser_qa=JSON.parse(fs.readFileSync(browserQa,'utf8'));
const activeSplits='.data/best-time-to-call/splits-v2.json';if(fs.existsSync(activeSplits)){const split=JSON.parse(fs.readFileSync(activeSplits,'utf8'));summary.active_split_manifest={revision:split.manifest_revision,reason:split.revision_reason,counts:Object.fromEntries(['history','cold_start'].map(track=>[track,Object.fromEntries(Object.entries(split[track]).map(([key,values])=>[key,values.length]))]))};}
const store=getAdminStore();
const {readExperimentReport}=loadServer('lib/best-time-experiments.ts');
summary.operational_proxy_experiment=await readExperimentReport(await store.readPredictionSettings());
summary.proxy_models_trained=summary.operational_proxy_experiment.models.filter(m=>['trained','evaluated'].includes(m.status)).length;
for(const model of summary.operational_proxy_experiment.models)if(model.model_version)await store.registerModel(model.model_version,model.route,{...model,label_kind:'proxy',canonical_label_verified:false,deployment_approved:false});
await store.recordExperiment('btc-operational-proxy-v3',summary.operational_proxy_experiment);
await store.recordExperiment('btc-2026-10-10-audit',summary);
fs.mkdirSync('docs/best-time-to-call',{recursive:true});
fs.writeFileSync('docs/best-time-to-call/evidence-summary.json',JSON.stringify(summary,null,2));
console.log(JSON.stringify({stored_experiment:'btc-2026-10-10-audit',output:'docs/best-time-to-call/evidence-summary.json',seller_records_included:false}));
}
main().catch(()=>{console.error('Aggregate evidence export failed. No credentials or seller records were logged.');process.exitCode=1;});
