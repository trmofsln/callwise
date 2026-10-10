/* eslint-disable @typescript-eslint/no-require-imports -- Isolated local HTTP and live Redash verification. */
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {randomBytes}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const base=process.argv[2]||'http://localhost:3102';
let cookie='';
async function request(endpoint,method='GET',body,origin=base) {
  const response=await fetch(`${base}${endpoint}`,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(170000)});
  const content=await response.text();return {status:response.status,body:content?JSON.parse(content):null};
}
async function main() {
  const report={started_at:new Date().toISOString(),base,checks:[]};
  const session=await request('/api/admin/session');
  assert.equal(session.body.configured,false,'Use an isolated fresh SQLITE_DATABASE_PATH; never run against the main database.');
  assert.equal((await request('/api/admin/predictions')).status,401);
  assert.equal((await request('/api/admin/experiments')).status,401);
  const password=randomBytes(24).toString('hex');
  const setup=await fetch(`${base}/api/admin/session`,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({action:'setup',password})});
  assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie').split(';')[0];
  const configuration=await request('/api/admin/predictions');assert.equal(configuration.status,200);
  assert.ok(!JSON.stringify(configuration.body).match(/sk-or-v1-|Bearer /));
  const save=await request('/api/admin/predictions','PUT',{...configuration.body.settings,llmEnabled:false});assert.equal(save.status,200);
  assert.equal((await request('/api/admin/predictions','PUT',save.body.settings,'https://untrusted.example')).status,403);
  assert.equal((await request('/api/predictions','POST',{glids:'1); DROP TABLE users; --'})).status,400);
  report.checks.push({name:'auth_origin_secret_masking_and_input_validation',status:'passed'});
  const experiment=await request('/api/admin/experiments');assert.equal(experiment.status,200);assert.equal(experiment.body.deployment_approved,false);assert.equal(experiment.body.canonical_label_verified,false);assert.equal(experiment.body.target,'observed_linked_physical_recorded_met_within14days');
  assert.ok(!JSON.stringify(experiment.body).match(/sk-or-v1-|Bearer |seller_id|employee_id/));
  report.checks.push({name:'authenticated_sanitized_experiment_report',status:'passed',state:experiment.body.state});
  const health=await request('/api/predictions/health');assert.equal(health.status,200);assert.equal(health.body.models_ready,false);assert.equal(health.body.generalized_ranking_ready,true);
  report.checks.push({name:'health_reports_unavailable_models',status:'passed'});
  const first=fs.readdirSync('.data/user-lookups').filter(f=>f.endsWith('.json')).sort()[0];
  const record=first?JSON.parse(fs.readFileSync(`.data/user-lookups/${first}`,'utf8')):null;
  const glid=process.env.BTC_SAMPLE_GLID||record?.requestedGlids?.[0];
  if(glid) {
    const started=Date.now(),lookup=await request('/api/users','POST',{glids:glid});
    if(lookup.status===200) {
      assert.equal(lookup.body.predictions.length,1);const prediction=lookup.body.predictions[0];
      assert.equal(prediction.primary_target,'meeting_done');assert.ok(['personal_history','generalized','fallback'].includes(prediction.prediction_route));assert.ok(prediction.recommended_window);assert.equal(prediction.ranking_scope,'overall');assert.ok(prediction.ranked_windows.length<=4);assert.notEqual(prediction.retry_plan.next_call_at,prediction.recommended_window.start);assert.ok(prediction.retry_plan.after_minutes>=prediction.retry_plan.minimum_gap_minutes);assert.ok(prediction.daily_windows.every(d=>d.windows.length<=4));if(glid==='204563657'){assert.equal(prediction.ranking_strategy,'seller_meetings');assert.equal(prediction.evidence.prior_calls,141);assert.ok(prediction.recommended_window.ranking.linked_meetings>0);}
      assert.ok(prediction.ranked_windows.every(w=>w.score===null));assert.equal(prediction.llm_status.status,'disabled');
      const exported=JSON.parse(fs.readFileSync(`.data/user-lookups/${lookup.body.lookupId}.json`,'utf8'));
      assert.deepEqual(exported.predictions,lookup.body.predictions);
      report.checks.push({name:'live_redash_lookup_prediction_and_json_export',status:'passed',returned_users:lookup.body.users.length,window_count:prediction.ranked_windows.length,elapsed_ms:Date.now()-started,global_context_status:lookup.body.globalContexts[0]?.status||null});
    } else report.checks.push({name:'live_redash_lookup_prediction_and_json_export',status:'failed',http_status:lookup.status,reason:lookup.body.error,elapsed_ms:Date.now()-started});
    const batch=await request('/api/predictions','POST',{glids:glid});
    report.checks.push({name:'batch_prediction_endpoint_live',status:batch.status===200&&batch.body.predictions?.length===1?'passed':'failed',http_status:batch.status});
  } else report.checks.push({name:'live_redash_lookup',status:'not_run',reason:'No previous GLID lookup exists.'});
  fs.writeFileSync('.data/best-time-to-call/http-smoke.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(process.env.BTC_BROWSER_QA==='1')console.log(execFileSync(process.execPath,['scripts/btc-browser-smoke.cjs',base],{env:{...process.env,BTC_QA_ADMIN_COOKIE:cookie},encoding:'utf8',windowsHide:true,timeout:180000}));
  if(report.checks.some(c=>c.status==='failed'))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
