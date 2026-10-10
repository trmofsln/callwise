/* eslint-disable @typescript-eslint/no-require-imports -- User-authorized reference key audit; secrets never printed. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const reference='C:\\Users\\imart\\Pictures\\openrouter key.txt';
async function check(key) {
  if(!key) return {configured:false,authenticated:false};
  try {
    const r=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(20000),redirect:'error'});
    return {configured:true,http_status:r.status,authenticated:r.ok};
  } catch {return {configured:true,authenticated:false,network_failure:true};}
}
async function checkModel(key) {
  if(!key)return {passed:false};
  try {
    const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'openai/gpt-6-luna',messages:[{role:'user',content:'Reply with the word ready.'}],reasoning:{enabled:true},max_tokens:1024}),signal:AbortSignal.timeout(40000),redirect:'error'});
    const b=await r.json();
    return {http_status:r.status,passed:r.ok&&b.model==='openai/gpt-6-luna'&&!!b.choices?.[0]?.message?.content,returned_model:b.model||null,finish_reason:b.choices?.[0]?.finish_reason||null,error:r.ok?null:String(b.error?.message||'Provider rejected request.').replaceAll(key,'[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g,'[REDACTED]').replace(/https?:\/\/\S+/g,'[ACCOUNT_LINK_REDACTED]').slice(0,500)};
  } catch {return {passed:false,network_failure:true};}
}
async function main() {
  const raw=fs.readFileSync(reference,'utf8').replace(/^\uFEFF/,'').trim();
  const keys=[...new Set(raw.match(/sk-[A-Za-z0-9_-]+/g)||[])];
  const referenceKey=keys.length===1?keys[0]:keys.length===0&&!/[\r\n]/.test(raw)?raw.replace(/^["']|["']$/g,''):null;
  if(!referenceKey)throw Error('Reference file does not contain one unambiguous key.');
  const current=process.env.OPENROUTER_API_KEY?.trim();
  const currentStatus=await check(current);
  const referenceStatus=current===referenceKey?currentStatus:await check(referenceKey);
  const currentModel=await checkModel(current),referenceModel=current===referenceKey?currentModel:await checkModel(referenceKey);
  const report={same_key:current===referenceKey,current:currentStatus,reference:referenceStatus,current_model:currentModel,reference_model:referenceModel,environment_updated:false};
  if(!currentModel.passed&&referenceModel.passed&&process.argv.includes('--repair-env')) {
    const filename='.env',existing=fs.readFileSync(filename,'utf8');
    const line=`OPENROUTER_API_KEY=${referenceKey}`;
    const updated=/^OPENROUTER_API_KEY=.*$/m.test(existing)?existing.replace(/^OPENROUTER_API_KEY=.*$/m,line):`${existing.trimEnd()}\n${line}\n`;
    fs.writeFileSync(filename,updated,{mode:0o600});report.environment_updated=true;
  }
  fs.mkdirSync('.data/best-time-to-call',{recursive:true});
  fs.writeFileSync('.data/best-time-to-call/openrouter-key-check.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch(()=>{console.error('Reference key check could not complete. No secret values were logged.');process.exitCode=1;});
