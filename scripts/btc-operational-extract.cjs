/* eslint-disable @typescript-eslint/no-require-imports -- Indexed, bounded operational proxy experiment. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {loadServer}=require('./server-loader.cjs');
const {runQuery}=loadServer('lib/redash.ts');
const dates=['2026-05-04','2026-05-09','2026-05-14','2026-05-19','2026-05-24','2026-05-29','2026-06-03','2026-06-08','2026-06-13','2026-06-18','2026-06-23','2026-07-15','2026-07-20','2026-07-25','2026-07-30','2026-08-04','2026-08-27','2026-09-01','2026-09-06','2026-09-11','2026-09-16'];
const root='.data/btc-operational';
function query(date,limit=600) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isInteger(limit)||limit<1||limit>600)throw Error('Invalid bounded cohort.');
  return `WITH c AS (SELECT click_to_call_id,ucid,fk_glusr_usr_id,fk_employeeid,call_start_time,entered_on,status,module
    FROM redash.click_to_call WHERE date(entered_on)=DATE '${date}' AND upper(flag_in_out)='OUTGOING'
      AND fk_employeeid IS NOT NULL AND fk_glusr_usr_id IS NOT NULL
      AND call_start_time>=TIMESTAMP '${date}' AND call_start_time<TIMESTAMP '${date}'+INTERVAL '1 day'
      AND lower(status) IN ('answered','notanswered')
    ORDER BY md5(click_to_call_id::text||'erp-pilot-43') LIMIT ${limit})
  SELECT c.click_to_call_id::text AS attempt_id,c.fk_glusr_usr_id::text AS seller_id,c.fk_employeeid::text AS employee_id,
    c.ucid,c.call_start_time,c.entered_on,c.status,c.module,
    COALESCE(dsr.calls,'[]'::jsonb) AS dsr_calls,COALESCE(dsr.meetings,'[]'::jsonb) AS meetings,
    previous.prior_count,previous.previous_call_at
  FROM c
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(DISTINCT jsonb_build_object('call_id',s.sts_dsr_call_id::text,'seller_id',sc.sts_fk_glusr_id::text,
      'recorded_at',s.sts_dsr_call_entrydate,'appointment_at',s.sts_dsr_app_date,'reverse_meeting_id',s.fk_sts_dsr_meeting_id::text)) AS calls,
      jsonb_agg(DISTINCT jsonb_build_object('meeting_id',m.sts_dsr_meeting_id::text,'call_id',m.fk_sts_dsr_call_id::text,
        'seller_id',mc.sts_fk_glusr_id::text,'mode',m.sts_dsr_meeting_mode,'result',m.sts_dsr_meeting_result,
        'recorded_at',m.sts_dsr_meeting_entrydate,'declared_at',m.sts_dsr_meeting_date,
        'verify_status',m.sts_dsr_meeting_verify_status)) FILTER(WHERE m.sts_dsr_meeting_id IS NOT NULL) AS meetings
    FROM redash.sts_dsr_call s
    LEFT JOIN redash.sts_company sc ON sc.companyid=s.fk_sts_company_id
    LEFT JOIN redash.sts_dsr_meeting m ON m.fk_sts_dsr_call_id=s.sts_dsr_call_id
    LEFT JOIN redash.sts_company mc ON mc.companyid=m.fk_sts_company_id
    WHERE s.ucid=c.ucid AND c.ucid IS NOT NULL AND lower(trim(c.ucid)) NOT IN ('','0','null','na','n/a')
  ) dsr ON TRUE
  LEFT JOIN LATERAL (
    SELECT count(DISTINCT CASE WHEN p.ucid IS NOT NULL AND lower(trim(p.ucid)) NOT IN ('','0','null','na','n/a')
      THEN 'ucid:'||p.ucid ELSE 'c2c:'||p.click_to_call_id::text END) AS prior_count,max(p.call_start_time) AS previous_call_at
    FROM redash.click_to_call p WHERE p.fk_glusr_usr_id=c.fk_glusr_usr_id AND upper(p.flag_in_out)='OUTGOING'
      AND p.fk_employeeid IS NOT NULL AND p.call_start_time>=TIMESTAMP '2026-05-01' AND p.call_start_time<c.call_start_time
  ) previous ON TRUE`;
}
async function main() {
  fs.mkdirSync(path.join(root,'raw'),{recursive:true});
  const plan={dates,per_day_cap:600,seed:43,source:13,scope_start:'2026-05-01',target:'observed_linked_physical_met_record_within14d',canonical_label_verified:false,availability_verified:false,query_sha256:Object.fromEntries(dates.map(d=>[d,crypto.createHash('sha256').update(query(d)).digest('hex')]))};
  const planFile=path.join(root,'plan.json'),encoded=JSON.stringify(plan,null,2);
  if(fs.existsSync(planFile)&&fs.readFileSync(planFile,'utf8')!==encoded)throw Error('Frozen extraction plan changed.');
  if(!fs.existsSync(planFile))fs.writeFileSync(planFile,encoded,{flag:'wx'});
  for(const date of dates) {
    const file=path.join(root,'raw',`${date}.json`);
    if(fs.existsSync(file)){console.log(JSON.stringify({date,status:'checkpoint'}));continue;}
    const sql=query(date),start=Date.now();
    const result=await runQuery({query:sql,dataSourceId:13,queryIdEnv:'REDDASH_TRAINING_QUERY_ID'});
    fs.writeFileSync(file,JSON.stringify({source:13,query:sql,query_sha256:plan.query_sha256[date],extracted_at:new Date().toISOString(),rows:result.rows}),{mode:0o600});
    console.log(JSON.stringify({date,rows:result.rows.length,elapsed_ms:Date.now()-start}));
  }
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={query,dates};
