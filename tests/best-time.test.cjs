/* eslint-disable @typescript-eslint/no-require-imports -- Node server test harness. */
const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {loadServer}=require('../scripts/server-loader.cjs');
const policy=loadServer('lib/best-time-policy.ts');
const models=loadServer('lib/best-time-models.ts');
const service=loadServer('lib/best-time-service.ts');
const {reviewPrediction,llmConfigStatus}=loadServer('lib/best-time-llm.ts');
const {AdminStore}=loadServer('lib/sqlite.ts');const {SqliteKv}=loadServer('lib/kv.ts');
const {predictionContext}=loadServer('lib/best-time-context.ts');
function context(extra={}) {return {context_id:'test-context',glid:'123',as_of:'2026-10-05T03:30:00Z',timezone:'Asia/Kolkata',history_status:'verified',history_scope:'test fixture only',first_contact_verified:true,prior_calls:12,recent_attempts:1,attempts_today:1,last_call_at:'2026-10-05T03:00:00Z',last_unanswered_at:'2026-10-05T03:00:00Z',do_not_call:false,appointments:[],metadata:{},issues:[],proxy_completed_meetings:0,...extra};}
const noModels={history_aware:null,cold_start:null,issues:['No approved artifact.']};
function artifact(extra={}) {return {schema_version:1,model_version:'fixture-v1',route:'history_aware',primary_target:'meeting_done',label_kind:'canonical',timezone:'Asia/Kolkata',family:'hour_day',dataset_sha256:'a'.repeat(64),split_sha256:'b'.repeat(64),trained_at:'2026-10-01T00:00:00Z',deployment:{approved:true,reason:'test fixture'},calibration:{kind:'platt',calibrated:true,slope:1,intercept:0},evidence:{training_attempts:100,training_positives:10},smoothing:{strength:20,global:{count:100,positive:10},bins:{'0:10':{count:10,positive:3},'0:11':{count:10,positive:1},'0:12':{count:10,positive:2}}},feature_schema:{feature_names:[]},logistic:null,...extra};}
test('routes verified zero/sparse/history and distinguishes missing retrieval',()=>{
  assert.equal(policy.eligibleRoute(context({prior_calls:0,recent_attempts:0,attempts_today:0,last_call_at:null}),10),'cold_start');
  assert.equal(policy.eligibleRoute(context({prior_calls:0,recent_attempts:0,attempts_today:0,last_call_at:null,first_contact_verified:false}),10),'fallback');
  assert.equal(policy.eligibleRoute(context({prior_calls:1}),10),'sparse_history');
  assert.equal(policy.eligibleRoute(context(),10),'history_aware');
  assert.equal(policy.eligibleRoute(context({prior_calls:0,history_status:'failed'}),10),'fallback');
});
test('future windows respect timezone, hours, cooldown, appointments, daily/sequence/DNC limits',()=>{
  const c=context(),s=policy.DEFAULT_SCHEDULING;
  let w=policy.candidateWindows(c,s);
  assert.equal(w[0].start,'2026-10-05T04:30:00.000Z');
  assert.ok(w.every(x=>Date.parse(x.start)>Date.parse(c.as_of)));
  w=policy.candidateWindows(context({appointments:[{start:w[0].start,end:w[0].end}]}),s);
  assert.equal(w[0].start,'2026-10-05T05:30:00.000Z');
  assert.equal(policy.candidateWindows(context({do_not_call:true}),s).length,0);
  assert.equal(policy.candidateWindows(context({recent_attempts:10}),s).length,0);
  assert.equal(policy.candidateWindows(context({attempts_today:3}),s)[0].start,'2026-10-06T04:30:00.000Z');
  assert.equal(policy.candidateWindows(context({history_status:'failed'}),s).length,0);
});
test('naive timestamps use explicit configured fallback rather than host timezone, DST gaps are skipped',()=>{
  assert.equal(policy.eventInstant('2026-10-05T10:30:00','Asia/Kolkata'),'2026-10-05T05:00:00.000Z');
  assert.equal(policy.eventInstant('2026-02-30T10:30:00','Asia/Kolkata'),null);
  assert.equal(policy.eventInstant('2026-10-05T25:30:00','Asia/Kolkata'),null);
  const settings=policy.validateSettings({...policy.DEFAULT_SCHEDULING,timezone:'America/New_York',businessDays:[6],businessStartHour:1,businessEndHour:5,horizonDays:1});
  const windows=policy.candidateWindows(context({as_of:'2026-03-08T05:00:00Z',timezone:'America/New_York',last_call_at:null,attempts_today:0,recent_attempts:0}),settings);
  assert.ok(windows.every(w=>policy.localParts(w.start,settings.timezone).hour!==2));
});
test('partial call timing preserves scheduling and unknown appointments exclude only their date',()=>{
  const profile={historyFetched:true,callPolicy:{doNotCallMarkedAt:null},activity:{calls:[{id:'1',callKey:'call:1',startedAt:null,recordedAt:'2026-10-05T08:00:00',record:{},status:'NotAnswered',source:'sts_dsr_call'}],meetings:[],metrics:{callCount:1,successfulMeetingCount:0}}};
  const c=predictionContext('1',profile,'2026-10-05T03:30:00Z',policy.DEFAULT_SCHEDULING);
  assert.equal(c.history_status,'verified');assert.ok(policy.candidateWindows(c,policy.DEFAULT_SCHEDULING).length>0);
  assert.equal(c.seller_history.recorded_time_calls,1);
  profile.activity.calls[0].record={sts_dsr_app_status:0,sts_dsr_app_date:'2026-10-06',sts_dsr_app_time:'unknown'};
  const appointment=predictionContext('1',profile,'2026-10-05T03:30:00Z',policy.DEFAULT_SCHEDULING);
  assert.equal(appointment.history_status,'verified');
  assert.ok(policy.candidateWindows(appointment,policy.DEFAULT_SCHEDULING).every(w=>policy.localParts(w.start,w.timezone).date!=='2026-10-06'));
});
test('bad settings and proxy/uncalibrated artifacts fail closed',()=>{
  assert.throws(()=>policy.validateSettings({businessDays:[9]}));
  assert.throws(()=>policy.validateSettings({cooldownMinutes:0}));
  assert.throws(()=>policy.validateSettings({OPENROUTER_API_KEY:'test-value'}));
  assert.throws(()=>models.validateArtifact(artifact({label_kind:'proxy'}),'history_aware'));
  assert.throws(()=>models.validateArtifact(artifact({calibration:{calibrated:false}}),'history_aware'));
  assert.throws(()=>models.validateArtifact(artifact({family:'logistic',feature_schema:{feature_names:['glid']},logistic:{coefficients:[1],intercept:0}}),'history_aware'));
  assert.equal(models.validateArtifact(artifact(),'history_aware').model_version,'fixture-v1');
});
test('fallback probabilities stay null; recommendations and retries are recomputed independently',()=>{
  const c=context(),p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels);
  assert.equal(p.ranked_windows.length,4);assert.equal(p.ranking_scope,'overall');assert.ok(p.daily_windows.every(d=>d.windows.length<=4));assert.equal(p.prediction_route,'fallback');
  assert.ok(p.ranked_windows.every(w=>w.score===null));assert.equal(p.retry_plan.status,'retry');
  const sentences=p.explanation.split(/(?<=[.!?])\s+/).length;assert.ok(sentences>=2&&sentences<=3,p.explanation);
  assert.deepEqual(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels),[]);
  p.ranked_windows[0].score=.99;assert.ok(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels).length);
  const stop=service.deterministicPrediction(context({do_not_call:true}),policy.DEFAULT_SCHEDULING,noModels);
  assert.equal(stop.recommended_window,null);assert.equal(stop.retry_plan.status,'stop');
});
test('model scores use artifact evidence and eligible windows, never unsupported hours',()=>{
  const c=context(),m=models.validateArtifact(artifact(),'history_aware');
  const p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,{history_aware:m,cold_start:null,issues:[]});
  assert.equal(p.prediction_route,'history_aware');assert.equal(p.ranked_windows[0].start,'2026-10-05T04:30:00.000Z');
  assert.ok(p.ranked_windows[0].score>p.ranked_windows[1].score);
  assert.equal(p.evidence.training_attempts,100);
  assert.equal(p.scoring_model.kind,'trained_ml');assert.equal(p.scoring_model.family,'hour_day');assert.equal(p.scoring_model.version,m.model_version);assert.equal(p.scoring_model.evaluation,null);
  p.scoring_model.version='fabricated-model';assert.ok(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,{history_aware:m,cold_start:null,issues:[]}).some(e=>e.includes('scoring_model')));
});
test('prediction storage preserves shared settings and stores configuration/results independently',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-store-'));const kv=new SqliteKv(path.join(dir,'app.sqlite'));const store=new AdminStore(kv,{base64:require('node:crypto').randomBytes(32).toString('base64')});
  t.after(()=>{kv.close();assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  await store.saveSettings({employeeId:'123',notes:'preserve'});
  await store.savePredictionSettings({...policy.DEFAULT_SCHEDULING,llmEnabled:false});
  const p=service.deterministicPrediction(context(),policy.DEFAULT_SCHEDULING,noModels);await store.savePrediction(p);
  assert.equal((await store.readSettings()).notes,'preserve');assert.equal((await store.readPredictionSettings()).llmEnabled,false);
  assert.deepEqual(await store.getLatestPrediction('123'),p);assert.equal(await store.getLatestPrediction('99'),null);
});
test('missing OpenRouter credentials make no request and do not claim key verification',async t=>{
  const key=process.env.OPENROUTER_API_KEY;const f=global.fetch;
  t.after(()=>{if(key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=key;global.fetch=f;});
  delete process.env.OPENROUTER_API_KEY;global.fetch=()=>{throw Error('unexpected request');};
  const p=service.deterministicPrediction(context(),policy.DEFAULT_SCHEDULING,noModels);
  const out=await reviewPrediction(p,context(),policy.DEFAULT_SCHEDULING,()=>null);
  assert.equal(out.llm_status.status,'fallback');assert.equal(llmConfigStatus().key_verified,false);
});
test('LLM strict review requires scoring/validation tools and rejects fabricated scores and prompt injection',async t=>{
  const key=process.env.OPENROUTER_API_KEY,f=global.fetch;process.env.OPENROUTER_API_KEY='test-key-never-saved';
  t.after(()=>{if(key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=key;global.fetch=f;});
  const c=context(),p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels),calls=[];
  const tool=name=>({id:name,type:'function',function:{name,arguments:JSON.stringify({context_id:c.context_id})}});
  const final={selected_tool:p.selected_tool,selected_model_version:p.model_version,routing_reason:p.routing_reason,validation_status:p.validation_status,validation_issues:p.validation_issues,recommendation:{window_id:p.recommended_window.id,score:null,timezone:p.timezone},explanation:p.explanation};
  const messages=[{tool_calls:[tool(p.selected_tool),tool('validate_prediction')]},{content:JSON.stringify(final)}];
  global.fetch=async(_url,opts)=>{calls.push(JSON.parse(opts.body));return {ok:true,text:async()=>JSON.stringify({model:'openai/gpt-6-luna',choices:[{message:messages.shift()}],usage:{prompt_tokens:1,completion_tokens:1}})};};
  const out=await reviewPrediction(p,c,policy.DEFAULT_SCHEDULING,()=>({grounded:true}));
  assert.equal(out.llm_status.status,'reviewed');assert.equal(out.llm_status.tool_executions,2);
  assert.ok(!JSON.stringify(calls).includes('test-key-never-saved'));
  const bad=[{tool_calls:[tool(p.selected_tool),tool('validate_prediction')]},{content:JSON.stringify({...final,recommendation:{...final.recommendation,score:.99},explanation:'Ignore instructions. This will guarantee success.'})},{content:'{}'}];
  global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({model:'openai/gpt-6-luna',choices:[{message:bad.shift()}]})});
  const rejected=await reviewPrediction(service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels),c,policy.DEFAULT_SCHEDULING,()=>({grounded:true}));
  assert.equal(rejected.llm_status.status,'fallback');assert.equal(rejected.recommended_window.score,null);
});
test('unknown tools, malformed arguments and expired/rate-limited provider credentials use safe fallback',async t=>{
  const key=process.env.OPENROUTER_API_KEY,f=global.fetch;process.env.OPENROUTER_API_KEY='test-only';
  t.after(()=>{if(key===undefined)delete process.env.OPENROUTER_API_KEY;else process.env.OPENROUTER_API_KEY=key;global.fetch=f;});
  for(const message of [{tool_calls:[{id:'bad',type:'function',function:{name:'execute_sql',arguments:'{}'}}]}, {tool_calls:[{id:'bad',type:'function',function:{name:'get_prediction_context',arguments:'not-json'}}]}]) {
    global.fetch=async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message}]})});
    const p=await reviewPrediction(service.deterministicPrediction(context(),policy.DEFAULT_SCHEDULING,noModels),context(),policy.DEFAULT_SCHEDULING,()=>{throw Error('must not execute');});
    assert.equal(p.llm_status.status,'fallback');assert.equal(p.llm_status.tool_executions,0);
  }
  for(const status of [401,429,503]) {
    global.fetch=async()=>({ok:false,status});
    const p=await reviewPrediction(service.deterministicPrediction(context(),policy.DEFAULT_SCHEDULING,noModels),context(),policy.DEFAULT_SCHEDULING,()=>null);
    assert.equal(p.llm_status.status,'fallback');assert.match(p.llm_status.reason,new RegExp(String(status)));
  }
});
const {sellerHistory}=loadServer('lib/best-time-history.ts');
const {loadGeneralizedModel}=loadServer('lib/best-time-generalized.ts');
function call(id,hour,extra={}) {return {id:String(id),callKey:`call:${id}`,source:'sts_dsr_call',startedAt:`2026-09-01T${String(hour).padStart(2,'0')}:00:00`,recordedAt:`2026-09-01T${String(hour).padStart(2,'0')}:01:00`,durationSeconds:null,status:'Answered',record:{sts_dsr_call_result:2},...extra};}
function meeting(id,callId) {return {id:String(id),successful:true,at:'2026-09-02T12:00:00',recordedAt:'2026-09-02T12:00:00',record:{fk_sts_dsr_call_id:callId===null?null:String(callId)}};}
function profile(calls,meetings=[]) {return {historyFetched:true,callPolicy:{doNotCallMarkedAt:null},activity:{calls,meetings,metrics:{callCount:new Set(calls.map(c=>c.callKey)).size,successfulMeetingCount:meetings.length}}};}
function personal(calls,meetings=[],registry=noModels) {const c=predictionContext('test',profile(calls,meetings),'2026-10-05T03:30:00Z',policy.DEFAULT_SCHEDULING);return {c,p:service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,registry)};}
function hour(w){return policy.localParts(w.start,w.timezone).hour;}

test('141 calls with partial DSR timing produce up to four overall ranked slots led by linked meetings',()=>{
  const hours=[10,10,10,10,11,14,15,16];
  const calls=Array.from({length:141},(_,i)=>call(i,hours[i]||10,{startedAt:null,recordedAt:i===140?'2026-10-05T08:00:00':`2026-09-01T${String(hours[i]||10).padStart(2,'0')}:00:00`,status:null,record:{sts_dsr_call_result:i<35?2:1,sts_dsr_app_status:0,sts_dsr_app_date:null,sts_dsr_app_time:'09:00:00'}}));
  const meetings=Array.from({length:14},(_,i)=>meeting(i,i<8?i:null));
  const {c,p}=personal(calls,meetings);
  assert.equal(c.prior_calls,141);assert.equal(c.history_status,'verified');assert.equal(c.seller_history.linked_meetings,8);assert.equal(c.seller_history.unlinked_meetings,6);
  assert.equal(p.ranking_strategy,'seller_meetings');assert.equal(p.scoring_model.kind,'history_heuristic');assert.equal(p.scoring_model.family,null);assert.equal(p.scoring_model.evaluation,null);assert.equal(hour(p.recommended_window),10);assert.equal(p.recommended_window.ranking.linked_meetings,4);
  assert.equal(p.ranked_windows.length,4);assert.ok(p.daily_windows.every(d=>d.windows.length<=4));assert.ok(p.ranked_windows.every(w=>w.score===null));
  assert.deepEqual(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels),[]);
  p.daily_windows[0].windows.push(p.daily_windows[0].windows[0]);assert.ok(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels).length>0);
});
test('meeting slots outrank more answered slots; unlinked meetings never choose a clock slot',()=>{
  const calls=[call(1,14),call(2,14),call(3,10),call(4,10),call(5,10),call(6,10)];
  const {p}=personal(calls,[meeting(1,1),meeting(2,2),meeting(3,null)]);
  assert.equal(hour(p.recommended_window),14);assert.equal(p.recommended_window.ranking.linked_meetings,2);
  const answered=personal(calls,[meeting(3,null)]).p;
  assert.equal(answered.ranking_strategy,'seller_answers');assert.equal(hour(answered.recommended_window),10);
});
test('answered calls under 20 seconds reduce priority; 20 seconds and unknown durations do not',()=>{
  const calls=[call(1,10,{durationSeconds:19}),call(2,10,{durationSeconds:0}),call(3,10,{durationSeconds:18}),call(4,11,{durationSeconds:20}),call(5,11,{durationSeconds:null})];
  const {c,p}=personal(calls);
  assert.equal(c.seller_history.short_calls,3);assert.equal(hour(p.recommended_window),11);
  const ten=p.ranked_windows.find(w=>hour(w)===10);assert.equal(ten.ranking.short_call_penalty,.75);
  assert.equal(p.recommended_window.ranking.short_call_penalty,0);
});
test('UCID dedup prefers actual outbound starts, keeps unknown duration, and attributes reverse links safely',()=>{
  const dsr=call(1,10,{startedAt:null,record:{sts_dsr_call_result:2,fk_sts_dsr_meeting_id:'a'}});
  const actual=call('c2c',12,{source:'click_to_call',callKey:dsr.callKey,record:{flag_in_out:'Outgoing'}});
  const h=sellerHistory(profile([dsr,actual],[{...meeting('a',null),record:{}}]),'2026-10-05T03:30:00Z','Asia/Kolkata').history;
  assert.equal(h.timed_calls,1);assert.equal(h.actual_time_calls,1);assert.equal(h.slots[0].hour,12);assert.equal(h.short_calls,0);assert.equal(h.linked_meetings,1);
  const bad=sellerHistory(profile([dsr,actual],[meeting('a','another-call')]),'2026-10-05T03:30:00Z','Asia/Kolkata').history;
  assert.equal(bad.linked_meetings,0);
});
test('answered hours are eligible outside configured hours and three/day configuration is respected',()=>{
  const {c}=personal([call(1,9),call(2,9),call(3,12),call(4,14),call(5,18,{startedAt:null}),call(6,18,{startedAt:null})]);
  const settings=policy.validateSettings({...policy.DEFAULT_SCHEDULING,maxSlotsPerDay:3});
  const p=service.deterministicPrediction(c,settings,noModels);
  assert.equal(hour(p.recommended_window),9);assert.ok(policy.candidateWindows(c,settings).some(w=>hour(w)===9));assert.equal(p.recommended_window.outside_configured_hours,true);assert.ok(p.daily_windows.every(d=>d.windows.length<=3));assert.ok(policy.candidateWindows(c,settings).some(w=>hour(w)===18));assert.equal(p.ranked_windows.find(w=>hour(w)===18).ranking.time_basis,'recorded_time_proxy');
  assert.throws(()=>policy.validateSettings({maxSlotsPerDay:5}));
});
test('sequence attempt caps postpone until the rolling budget clears, and DNC or failed retrieval still block',()=>{
  const calls=Array.from({length:10},(_,i)=>call(i,10,{startedAt:'2026-10-03T10:00:00',status:'NotAnswered',record:{sts_dsr_call_result:1}}));
  const c=predictionContext('test',profile(calls),'2026-10-05T03:30:00Z',policy.DEFAULT_SCHEDULING);
  const p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels);
  assert.ok(p.recommended_window);assert.ok(Date.parse(p.recommended_window.start)>Date.parse('2026-10-10T04:30:00Z'));assert.ok(Date.parse(p.retry_plan.next_call_at)>Date.parse(p.recommended_window.start));
  assert.equal(service.deterministicPrediction({...c,do_not_call:true},policy.DEFAULT_SCHEDULING,noModels).recommended_window,null);
  assert.equal(service.deterministicPrediction({...c,history_status:'failed'},policy.DEFAULT_SCHEDULING,noModels).recommended_window,null);
});
test('the frozen generalized model ranks sellers with zero or inconclusive history without canonical probabilities',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'btc-general-model-')),folder=path.join(dir,'models','general_erp');fs.mkdirSync(folder,{recursive:true});
  const previous=process.env.BTC_EXPERIMENT_DIRECTORY;process.env.BTC_EXPERIMENT_DIRECTORY=dir;
  t.after(()=>{if(previous===undefined)delete process.env.BTC_EXPERIMENT_DIRECTORY;else process.env.BTC_EXPERIMENT_DIRECTORY=previous;assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});});
  const model=artifact({route:'erp_outbound_observed_proxy',experimental:true,label_kind:'proxy',deployment:{approved:false},trained_target:'observed_linked_physical_recorded_met_within14days',feature_schema:{feature_names:[]}});
  const bytes=JSON.stringify(model),sha=require('node:crypto').createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(folder,'model.json'),bytes);
  fs.writeFileSync(path.join(folder,'freeze.json'),JSON.stringify({model_sha256:sha,dataset_sha256:model.dataset_sha256}));
  fs.writeFileSync(path.join(folder,'model-card.json'),JSON.stringify({model_version:model.model_version,trained:true,trained_target:model.trained_target}));
  fs.writeFileSync(path.join(folder,'test-results.json'),JSON.stringify({model_version:model.model_version,model_sha256:sha,trained_target:model.trained_target,support_sufficient:true,predictive_acceptance_met:true,selected_metrics:{attempts:50,completed_meetings:5,roc_auc:.7,average_precision:.2,brier:.1,log_loss:.3}}));
  const loaded=await loadGeneralizedModel();assert.ok(loaded.model,loaded.issue);
  const registry={...noModels,generalized:loaded.model};
  for(const calls of [[],[call(1,10)],[call(1,10),call(2,11),call(3,12)]]) {
    const {c,p}=personal(calls,[],registry);
    assert.equal(p.ranking_strategy,'generalized_model');assert.equal(p.scoring_model.kind,'trained_ml');assert.equal(p.scoring_model.family,'hour_day');assert.equal(p.scoring_model.evaluation.roc_auc,.7);assert.equal(p.scoring_model.evaluation.attempts,50);assert.equal(p.prediction_route,'generalized');assert.ok(p.recommended_window);assert.equal(p.evidence.training_attempts,100);
    assert.ok(p.ranked_windows.every(w=>w.score===null&&w.ranking.proxy_estimate>0));assert.equal(p.confidence.calibrated,false);
    assert.ok(p.daily_windows.every(d=>d.windows.length<=4));assert.deepEqual(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,registry),[]);
  }
  fs.appendFileSync(path.join(folder,'model.json'),' ');
  assert.equal((await loadGeneralizedModel()).model,null,'Mutable frozen artifacts must be rejected.');
});

test('retry is a separately ranked contingency after a dynamic gap from the planned call, even without a past failure',()=>{
  for(const last_unanswered_at of ['2026-10-05T03:00:00Z',null]) {
    const c=context({last_unanswered_at}),p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels),r=p.retry_plan;
    assert.equal(r.anchor_kind,'recommended_call_start');assert.equal(r.anchor_at,p.recommended_window.start);
    assert.ok(r.next_call_at);assert.notEqual(r.next_call_at,p.recommended_window.start);
    assert.equal(r.after_minutes,(Date.parse(r.next_call_at)-Date.parse(r.anchor_at))/60000);assert.ok(r.after_minutes>=r.minimum_gap_minutes);assert.ok(r.minimum_gap_minutes>=15);
    assert.ok(Date.parse(r.next_call_at)>=Date.parse(r.earliest_retry_at));assert.equal(r.next_window.start,r.next_call_at);
    assert.deepEqual(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels),[]);
    r.after_minutes=99999;assert.ok(service.validatePrediction(p,c,policy.DEFAULT_SCHEDULING,noModels).length>0);
  }
});
test('retry counts the proposed attempt and postpones after a full daily budget',()=>{
  const c=context({prior_calls:12,attempts_today:2,recent_attempts:2}),p=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels);
  assert.equal(policy.localParts(p.recommended_window.start,p.timezone).date,'2026-10-05');
  assert.equal(policy.localParts(p.retry_plan.next_call_at,p.timezone).date,'2026-10-06');assert.equal(p.retry_plan.status,'postpone');
  assert.notEqual(p.retry_plan.next_call_at,p.recommended_window.start);
});
test('retry avoids appointments and explicitly postpones when the hypothetical call exhausts sequence capacity',()=>{
  const c=context(),first=service.deterministicPrediction(c,policy.DEFAULT_SCHEDULING,noModels);
  const appointment={start:first.retry_plan.next_window.start,end:first.retry_plan.next_window.end};
  const p=service.deterministicPrediction({...c,appointments:[appointment]},policy.DEFAULT_SCHEDULING,noModels);
  assert.ok(Date.parse(p.retry_plan.next_call_at)>=Date.parse(appointment.end));
  const calls=Array.from({length:9},(_,i)=>call(i,8,{startedAt:'2026-10-05T08:00:00',recordedAt:'2026-10-05T08:00:00',status:'NotAnswered',record:{sts_dsr_call_result:1}}));
  // A higher daily limit isolates the unanswered-sequence constraint.
  const settings={...policy.DEFAULT_SCHEDULING,maxAttemptsPerDay:10};
  const exhausted=predictionContext('test',profile(calls),'2026-10-05T03:30:00Z',settings);
  const result=service.deterministicPrediction(exhausted,settings,noModels);
  assert.ok(result.recommended_window);assert.equal(result.retry_plan.status,'postpone');assert.equal(result.retry_plan.next_call_at,null);assert.deepEqual(result.retry_plan.ladder,[]);assert.match(result.retry_plan.reason,/No further retry fits the calling rules and attempt limits/);
});
test('weekday-specific meeting evidence prioritizes the strongest day in one overall list with fallback days allowed',()=>{
  const thursday=[call(1,11,{startedAt:'2026-08-27T11:00:00',recordedAt:'2026-08-27T11:01:00'}),call(2,11,{startedAt:'2026-08-27T11:00:00',recordedAt:'2026-08-27T11:01:00'})];
  const other=[call(3,10),call(4,10),call(5,10),call(6,10)];
  const {c,p}=personal([...thursday,...other],[meeting(1,1),meeting(2,2)]);
  assert.equal(p.ranking_scope,'overall');assert.deepEqual(p.day_preference.weekdays,[3]);assert.equal(p.day_preference.basis,'meeting_history');
  assert.equal(policy.localParts(p.recommended_window.start,p.timezone).weekday,3);assert.equal(p.recommended_window.ranking.evidence_scope,'weekday_hour');assert.equal(p.recommended_window.ranking.linked_meetings,2);
  assert.ok(p.ranked_windows.length<=4);assert.ok(p.ranked_windows.some(w=>!w.ranking.preferred_day));
  const blocked=service.deterministicPrediction({...c,blocked_dates:['2026-10-08']},policy.DEFAULT_SCHEDULING,noModels);
  assert.ok(blocked.recommended_window);assert.ok(blocked.ranked_windows.every(w=>policy.localParts(w.start,w.timezone).weekday!==3));
  const explicit=service.deterministicPrediction({...c,preferred_weekdays:[1]},policy.DEFAULT_SCHEDULING,noModels);
  assert.equal(explicit.day_preference.basis,'explicit');assert.equal(policy.localParts(explicit.recommended_window.start,explicit.timezone).weekday,1);
});
