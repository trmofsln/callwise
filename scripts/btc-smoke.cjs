/* eslint-disable @typescript-eslint/no-require-imports -- Non-sensitive live provider smoke. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const {createHash}=require('node:crypto');
const {loadServer}=require('./server-loader.cjs');
const {reviewPrediction}=loadServer('lib/best-time-llm.ts');
const {deterministicPrediction,validatePrediction}=loadServer('lib/best-time-service.ts');
const {DEFAULT_SCHEDULING}=loadServer('lib/best-time-policy.ts');
async function main() {
  const model=process.env.OPENROUTER_MODEL||'openai/gpt-6-luna';
  const base=(process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1').replace(/\/$/,'');
  const catalogResponse=await fetch(`${base}/models`,{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}.`);
  const catalog=await catalogResponse.json(),entry=catalog.data?.find(m=>m.id===model);
  const report={model,catalog_verified_at:new Date().toISOString(),catalog_present:!!entry,supported_parameters:entry?.supported_parameters||[],live_smoke:null};
  const now=new Date().toISOString();
  const context={context_id:'non-sensitive-provider-smoke',glid:'1',as_of:now,timezone:'Asia/Kolkata',history_status:'verified',first_contact_verified:false,history_scope:'Artificial smoke context; no real seller data.',prior_calls:0,recent_attempts:0,attempts_today:0,last_call_at:null,last_unanswered_at:null,do_not_call:false,appointments:[],metadata:{},issues:['Smoke only; no verified model artifact.'],proxy_completed_meetings:0};
  const registry={history_aware:null,cold_start:null,issues:['No approved artifact.']};
  const settings={...DEFAULT_SCHEDULING,llmDeadlineMs:30000};
  const prediction=deterministicPrediction(context,settings,registry);
  const output=await reviewPrediction(prediction,context,settings,name=>{
    if(name==='get_prediction_context') return {context_id:context.context_id,eligible_tool:prediction.selected_tool,history_status:context.history_status};
    if(name===prediction.selected_tool) return {model_version:prediction.model_version,route:prediction.prediction_route,windows:prediction.ranked_windows,explanation:prediction.explanation,routing_reason:prediction.routing_reason};
    if(name==='score_retry_plan') return prediction.retry_plan;
    if(name==='validate_prediction') return {validation_status:prediction.validation_status,validation_issues:prediction.validation_issues,programmatic_errors:validatePrediction(prediction,context,settings,registry),selected_tool:prediction.selected_tool,selected_model_version:prediction.selected_model_version,routing_reason:prediction.routing_reason,explanation:prediction.explanation};
    throw new Error('Ineligible tool.');
  });
  report.live_smoke={...output.llm_status,programmatic_errors:validatePrediction(output,context,settings,registry),synthetic_context:true,key_verified:output.llm_status.status==='reviewed',scientific_accuracy_evaluated:false};
  fs.mkdirSync('.data/best-time-to-call',{recursive:true});fs.writeFileSync('.data/best-time-to-call/openrouter-smoke.json',JSON.stringify(report,null,2));
  if(output.llm_status.status==='reviewed')fs.writeFileSync('.data/best-time-to-call/openrouter-verification.json',JSON.stringify({status:'reviewed',verified_at:new Date().toISOString(),signature:createHash('sha256').update([process.env.OPENROUTER_API_KEY?.trim()||'',process.env.OPENROUTER_BASE_URL||'https://openrouter.ai/api/v1',model].join('\n')).digest('hex')}),{mode:0o600});
  console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
