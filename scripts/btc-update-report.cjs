/* eslint-disable @typescript-eslint/no-require-imports -- Report only frozen, already completed evaluations. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const {loadServer}=require('./server-loader.cjs');
const {readExperimentReport}=loadServer('lib/best-time-experiments.ts');
const {DEFAULT_SCHEDULING}=loadServer('lib/best-time-policy.ts');
const root='.data/btc-operational-v3',docs='docs/best-time-to-call';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const fmt=v=>v===null||v===undefined?'Unavailable':Number(v).toPrecision(6);
async function main() {
  const report=await readExperimentReport(DEFAULT_SCHEDULING);
  if(!report.models.every(m=>m.status==='evaluated'))throw Error('Both frozen evaluations must be complete and verified.');
  const manifest=read(`${root}/dataset-manifest.json`),provider=read('.data/best-time-to-call/openrouter-smoke.json');
  const tests=Object.fromEntries(['general_erp','cold_start'].map(route=>[route,read(`${root}/models/${route}/test-results.json`)]));
  const cards=Object.fromEntries(['general_erp','cold_start'].map(route=>[route,read(`${root}/models/${route}/model-card.json`)]));
  const rows=report.models.flatMap(m=>[[m.name,'Selected',m.test],[m.name,'Hour/day',m.baseline]].map(([name,candidate,metrics])=>`| ${name} | ${candidate} | ${metrics.attempts} | ${metrics.proxy_events} | ${fmt(metrics.average_precision)} | ${fmt(metrics.roc_auc)} | ${fmt(metrics.log_loss)} | ${fmt(metrics.brier)} |`)).join('\n');
  const artifact={generated_at:new Date().toISOString(),target:report.target,canonical_label_verified:false,policy_lift_measured:false,dataset:{attempts:report.attempts,sellers:report.sellers,proxy_events:report.proxy_events,dataset_sha256:report.dataset_sha256,as_of:report.as_of},models:report.models.map(({preview,...model})=>({...model,preview_omitted:!!preview.length})),tests,cards};
  fs.writeFileSync(`${docs}/operational-results.json`,JSON.stringify(artifact,null,2));
  if(!fs.existsSync(`${docs}/results-initial-audit.md`))fs.writeFileSync(`${docs}/results-initial-audit.md`,'> Historical pre-training checkpoint; superseded by [current results](results.md).\n\n'+fs.readFileSync(`${docs}/results.md`,'utf8'),{flag:'wx'});
  const text=`# Measured results and limits

Two actual offline models were trained on a read-only Redash extraction. The app, production build, responsive dashboard, authenticated model report, portable inference, and live GPT-6 Luna tool review are working. **These are experimental operational-proxy models; no canonical meeting_done model or causal completed-meeting lift is claimed.**

The user's primary objective remains completed meetings attributable to calls, overriding PS03's meeting_fixed priority. The explicit fitted endpoint is **${report.target}**, stored separately from canonical meeting_done:null.

## Actual dataset and validation

Source 13 / pg-main-prod-live, persistent extraction query 47566, ${report.checkpoints} bounded checkpoints. ${report.attempts.toLocaleString()} deduplicated calls, ${report.sellers.toLocaleString()} sellers, ${report.proxy_events} positives. Calls were selected by deterministic hash order on 10 preregistered dates, uniformly capped at 4,000 per date without outcome balancing. Sunday 16 August exhausted at 3,284. V3 uniformly expanded the same V2 dates before model fitting; original V1/V2 evidence remains intact.

| Cohort | Train calls / proxy events | Validation | Locked final test |
| --- | ---: | ---: | ---: |
| General ERP time-only | ${manifest.history_counts.train.rows} / ${manifest.history_counts.train.positives} | ${manifest.history_counts.validation.rows} / ${manifest.history_counts.validation.positives} | ${manifest.history_counts.test.rows} / ${manifest.history_counts.test.positives} |
| First contact in observed scope | ${manifest.cold_start_counts.train.rows} / ${manifest.cold_start_counts.train.positives} | ${manifest.cold_start_counts.validation.rows} / ${manifest.cold_start_counts.validation.positives} | ${manifest.cold_start_counts.test.rows} / ${manifest.cold_start_counts.test.positives} |

Dates: train 12/14/16/18 August; validation 2/4/6 September; final test 21/23/25 September 2026. Labels mature 14 days after actual call start before the next split. Cold membership is seller-disjoint. Both pipelines were frozen before either final test was scored, then evaluated once under atomic locks. Dataset SHA-256: **${report.dataset_sha256}**; observation cutoff: **${report.as_of}**.

## Actual held-out predictive results

| Cohort | Model | Calls | Proxy events | AUPRC | ROC AUC | Log loss | Brier |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

${report.models.map(m=>`${m.name}: selected **${m.candidate}**; ${m.calibrated?'validation-fitted Platt calibration':'uncalibrated due insufficient validation-positive support'}. Predictive acceptance: **${m.predictive_acceptance_met?'met for this proxy endpoint':'unmet'}**. AUPRC 95% seller-cluster interval: ${m.uncertainty.average_precision?`${fmt(m.uncertainty.average_precision.lower)}–${fmt(m.uncertainty.average_precision.upper)}`:'undefined'}.`).join('\n\n')}

The first-contact final test contains zero observed positive records: PR/ROC discrimination cannot be established. Its finite log loss/Brier describe negative-only predictions, not successful detection of completed meetings. No headline accuracy is used. Rare-event acceptance was tightened **before fitting** to tolerances of 5% of the baseline, with floors of 0.0001 for Brier and 0.001 for log loss; the saved acceptance contracts contain exact thresholds. Raw selected-model metrics, calibration diagnostics, support by weekday, baselines, secondary diagnostics, uncertainty and model cards are in [operational-results.json](operational-results.json).

Only prospective local hour and weekday enter model features. Current seller metadata, employee IDs, call status/duration, prior outcomes and mutable counters are excluded. Train lacks Monday observations; final test includes Monday. The unchanged scientific preview suppresses unseen/sparse weekday slots; the live advisory fallback pools training evidence by hour for these weekdays and does not claim calibrated probabilities for this extension. Observational employee schedules and the general ERP population do not establish transfer to hotlead campaigns or causal benefits from rescheduling calls.

The general winner is the strong smoothed hour/day baseline, followed by validation-fitted calibration. Calibration preserves its ranking and retrospective top-20% budget yield: there is no measured ranking/yield improvement over the raw baseline. Its log loss improves slightly. This is a measured predictive association with an operational recording proxy, not completed-meeting policy lift.

## Target and coverage limits

A positive means a seller-consistent linked physical DSR record with non-null result other than 9, inserted between actual call start and 14 days later. Direct/reverse keys are checked; contradictory reverse links are rejected. A negative means **no observed qualifying linked recorded-met record in the current replica**, not a confirmed completed-meeting failure. Entry time is an insertion clock; declared physical-meeting dates and later verification are not proven event/availability times. Multiple snapshot batches and later edits/retention/linkage gaps remain limitations.

The observed first-contact scope searches all exposed current-replica qualifying prior calls since 1 May, including unsampled records. It does not prove lifetime absence or complete real-world history. Ambiguous same-time first rows were quarantined in locked membership before training. Naive ERP timestamps assume Asia/Kolkata. Synthetic lead_id values group sellers; real lead/retry-chain identity is unavailable. General temporal evaluation permits repeated sellers, while first-contact evaluation remains seller-disjoint. Canonical meeting_done and meeting_fixed remain unknown; provider-reported Answered is only a secondary operational diagnostic.

The original hotlead pilot remains a separate 4,978-attempt / 4,706-seller dataset with 0 canonical labels and 0 linked meeting proxies. Its strict canonical trainers still refuse that data; see [initial checkpoint](results-initial-audit.md) and [label audit](label-audit.md). Accessible schema catalogs still lack the canonical labels; sources 8/10 expose schemas but deny queries.

## Application and live provider evidence

The Callwise dashboard brings calling plans ahead of profile details, displays one overall ranking of up to four day-and-time choices, personal meeting/answer evidence and short-call penalties, independent conditional retry timing, constraints and evidence, preserves activity/Global Context/JSON exports, and works at desktop and 390-pixel mobile widths. Admin displays authenticated aggregate model results and frozen proxy-clock inference; it exposes no raw seller records or saved keys. SQLite retains existing credentials and stores predictions/model/experiment metadata. Canonical API probabilities remain null until approved, calibrated canonical artifacts are available. Both proxy artifacts remain deployment_approved:false.

Live Luna model: **${provider.model}**. The previous key authenticated but had exceeded its monthly limit; the user's reference key successfully called the exact model and was saved locally without exposing it. Latest actual grounded tool review: **${provider.live_smoke.status}**, ${provider.live_smoke.tool_executions} tools, ${provider.live_smoke.latency_ms} ms, ${provider.live_smoke.input_tokens} input / ${provider.live_smoke.output_tokens} output tokens, cost US$${provider.live_smoke.cost}; independent programmatic errors: ${provider.live_smoke.programmatic_errors.length}. This smoke uses an artificial non-sensitive context; it is provider/contract evidence, not scientific prediction accuracy. Separate 14-case synthetic mocked routing checks have zero constraint violations and 14/14 grounded outputs.

Automated tests, lint, types, production build and final HTTP/browser results are recorded in [checklist](checklist.md) and [aggregate evidence](evidence-summary.json). Reproduce from [commands](reproduce.md). Local server: http://127.0.0.1:3000. Desktop/mobile/home/Admin screenshots are saved under ignored .data/best-time-to-call/.

The aspirational 10% relative completed-meeting yield improvement at equal call budget is **unmeasured**. Keep the 15-minute rule pending verified outcomes and a seller-randomized pilot; trained predictive proxy scores do not justify changing production scheduling. Canonical label/attribution definitions, complete campaign prehistory, historical availability, timezone/contact/capacity policy and prospective validation remain the dependencies for deployment.
`;
  fs.writeFileSync(`${docs}/results.md`,text);
  console.log(JSON.stringify({output:`${docs}/results.md`,models:report.models.map(m=>({route:m.route,status:m.status,predictive_acceptance_met:m.predictive_acceptance_met})),seller_records_included:false}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
