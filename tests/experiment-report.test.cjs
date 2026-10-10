/* eslint-disable @typescript-eslint/no-require-imports -- Cross-runtime experimental inference contract. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {loadServer}=require('../scripts/server-loader.cjs');
const {scoreExperimentalClock,reportMetrics,EXPERIMENT_TARGET}=loadServer('lib/best-time-experiments.ts');
const {validateArtifact}=loadServer('lib/best-time-models.ts');
function model(family='logistic',calibrated=true) {
  return {schema_version:1,experimental:true,route:'erp_outbound_observed_proxy',primary_target:'meeting_done',trained_target:EXPERIMENT_TARGET,label_kind:'proxy',timezone:'Asia/Kolkata',family,deployment:{approved:false},evidence:{training_attempts:1000,training_positives:15},smoothing:{strength:20,global:{count:1000,positive:15},bins:{'0:10':{count:50,positive:3},'0:11':{count:20,positive:0},'0:12':{count:4,positive:1}},cohorts:{}},feature_schema:{timezone:'Asia/Kolkata',feature_names:['hour_sin','hour_cos',...Array.from({length:7},(_,i)=>`weekday_${i}`)],categories:{},interaction_fields:[]},logistic:{intercept:-4,coefficients:[-.4,.2,.1,-.1,0,0,0,0,0]},calibration:calibrated?{kind:'platt',calibrated:true,slope:.85,intercept:-.3,clip:1e-8}:{kind:'none',calibrated:false}};
}
const windows=[10,11,12,13].map(hour=>({start:`2026-10-12T${String(hour).padStart(2,'0')}:00:00+05:30`,end:`2026-10-12T${hour+1}:00:00+05:30`,timezone:'Asia/Kolkata'}));
test('experimental portable inference matches Python and suppresses unseen/sparse slots',()=>{
  for(const family of ['logistic','hour_day'])for(const calibrated of [false,true]) {
    const artifact=model(family,calibrated),result=scoreExperimentalClock(artifact,windows);
    const python=spawnSync('python',['-c',"import json,sys;from ml.cold_start.models import predict;v=json.load(sys.stdin);print(json.dumps({w['start']:predict({'call_at':w['start'],'safe_metadata':{}},v['model']) for w in v['windows']}))"],{cwd:process.cwd(),input:JSON.stringify({model:artifact,windows}),encoding:'utf8',windowsHide:true});
    assert.equal(python.status,0,python.stderr);const expected=JSON.parse(python.stdout);
    assert.equal(result.length,2);
    for(const row of result)assert.ok(Math.abs(row.proxy_score-expected[row.start])<1e-12);
  }
});
test('experimental scoring cannot accept deployed/canonical artifacts or mutable features',()=>{
  assert.throws(()=>scoreExperimentalClock({...model(),label_kind:'canonical'},windows));
  assert.throws(()=>scoreExperimentalClock({...model(),deployment:{approved:true}},windows));
  assert.throws(()=>scoreExperimentalClock({...model(),feature_schema:{...model().feature_schema,feature_names:['status']}},windows));
  assert.throws(()=>scoreExperimentalClock(model(),[{...windows[0],end:'invalid'}]));
  assert.throws(()=>validateArtifact(model(),'history_aware'));
});
test('Admin metric response exposes aggregate proxy counts and omits raw records',()=>{
  const summary=reportMetrics({attempts:20,completed_meetings:2,class_prevalence:.1,average_precision:.2,roc_auc:.6,brier:.08,log_loss:.3,sellers:['sensitive'],token:'secret',raw_records:[{}]});
  assert.equal(summary.proxy_events,2);assert.equal(summary.average_precision,.2);
  assert.ok(!('sellers' in summary));assert.ok(!('token' in summary));assert.ok(!('raw_records' in summary));
});
