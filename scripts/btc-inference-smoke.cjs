/* eslint-disable @typescript-eslint/no-require-imports -- Verify real frozen Python/Node artifact parity. */
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {loadServer}=require('./server-loader.cjs');
const {readExperimentReport}=loadServer('lib/best-time-experiments.ts');
const {DEFAULT_SCHEDULING}=loadServer('lib/best-time-policy.ts');
async function main() {
  const report=await readExperimentReport(DEFAULT_SCHEDULING),checks=[];
  for(const [index,folder] of ['general_erp','cold_start'].entries()) {
    const model=JSON.parse(fs.readFileSync(`.data/btc-operational-v3/models/${folder}/model.json`,'utf8'));
    const preview=report.models[index].preview;assert.ok(preview.length>0);
    const result=spawnSync('python',['-c',"import json,sys;from ml.cold_start.models import predict;v=json.load(sys.stdin);print(json.dumps([predict({'call_at':w['start'],'safe_metadata':{}},v['model']) for w in v['windows']]))"],{input:JSON.stringify({model,windows:preview}),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,result.stderr);const expected=JSON.parse(result.stdout);
    const maximum_difference=Math.max(...preview.map((row,i)=>Math.abs(row.proxy_score-expected[i])));
    assert.ok(maximum_difference<1e-12);checks.push({model_version:model.model_version,windows:preview.length,maximum_difference,status:'passed',experimental:true,canonical_label_verified:false});
  }
  const result={checked_at:new Date().toISOString(),kind:'actual_frozen_artifact_cross_runtime_parity',checks};
  fs.writeFileSync('.data/best-time-to-call/inference-smoke.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
