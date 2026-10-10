/* eslint-disable @typescript-eslint/no-require-imports -- Read-only, serial, bounded ERP proxy extraction. */
require('@next/env').loadEnvConfig(process.cwd());
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {loadServer} = require('./server-loader.cjs');
const {runQuery} = loadServer('lib/redash.ts');
const root = process.env.BTC_OPERATIONAL_ROOT || '.data/btc-operational-v2';
if(!/^\.data\/btc-operational-v[23]$/.test(root))throw Error('Use a versioned workspace extraction root');
const seed = 'erp-observed-v2-71';
const dates = {train:['2026-08-12','2026-08-14','2026-08-16','2026-08-18'],validation:['2026-09-02','2026-09-04','2026-09-06'],test:['2026-09-21','2026-09-23','2026-09-25']};
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function validate(date,offset,cap){if(!/^2026-\d\d-\d\d$/.test(date)||!Number.isInteger(offset)||offset<0||!Number.isInteger(cap)||cap<1||cap>50)throw Error('Invalid bounded cohort');}
function spine(date,offset=0,cap=50){validate(date,offset,cap);return `SELECT click_to_call_id,ucid,fk_glusr_usr_id,fk_employeeid,call_start_time,entered_on,status,module,last_modified_date
FROM redash.click_to_call WHERE date(entered_on)=DATE '${date}' AND upper(flag_in_out)='OUTGOING'
AND fk_employeeid IS NOT NULL AND fk_glusr_usr_id IS NOT NULL AND fk_glusr_usr_id>0
AND call_start_time>=TIMESTAMP '${date}' AND call_start_time<TIMESTAMP '${date}'+INTERVAL '1 day'
AND lower(status) IN ('answered','notanswered')
ORDER BY md5(click_to_call_id::text||'${seed}'),click_to_call_id LIMIT ${cap} OFFSET ${offset}`;}
function query(date,offset=0,cap=50){return `WITH c AS MATERIALIZED (${spine(date,offset,cap)})
SELECT c.click_to_call_id::text AS attempt_id,c.fk_glusr_usr_id::text AS seller_id,c.fk_employeeid::text AS employee_id,
c.ucid,c.call_start_time,c.entered_on,c.last_modified_date,c.status,c.module,
COALESCE(dsr.calls,'[]'::jsonb) AS dsr_calls,COALESCE(dsr.meetings,'[]'::jsonb) AS meetings,
EXISTS(SELECT 1 FROM redash.click_to_call p WHERE p.fk_glusr_usr_id=c.fk_glusr_usr_id AND upper(p.flag_in_out)='OUTGOING'
AND p.fk_employeeid IS NOT NULL AND p.fk_glusr_usr_id>0 AND p.call_start_time>=TIMESTAMP '2026-05-01'
AND p.call_start_time<c.call_start_time) AS prior_call_exists
FROM c LEFT JOIN LATERAL (
SELECT jsonb_agg(DISTINCT jsonb_build_object('call_id',s.sts_dsr_call_id::text,'seller_id',sc.sts_fk_glusr_id::text,
'recorded_at',s.sts_dsr_call_entrydate,'reverse_meeting_id',s.fk_sts_dsr_meeting_id::text)) AS calls,
jsonb_agg(DISTINCT jsonb_build_object('meeting_id',m.sts_dsr_meeting_id::text,'call_id',m.fk_sts_dsr_call_id::text,
'seller_id',mc.sts_fk_glusr_id::text,'mode',m.sts_dsr_meeting_mode,'result',m.sts_dsr_meeting_result,
'recorded_at',m.sts_dsr_meeting_entrydate,'declared_at',m.sts_dsr_meeting_date,'verify_status',m.sts_dsr_meeting_verify_status,
'link_method',CASE WHEN m.fk_sts_dsr_call_id=s.sts_dsr_call_id THEN 'direct' ELSE 'reverse' END)) FILTER(WHERE m.sts_dsr_meeting_id IS NOT NULL) AS meetings
FROM redash.sts_dsr_call s JOIN redash.sts_company sc ON sc.companyid=s.fk_sts_company_id AND sc.sts_fk_glusr_id=c.fk_glusr_usr_id
LEFT JOIN redash.sts_dsr_meeting m ON m.fk_sts_dsr_call_id=s.sts_dsr_call_id
 OR (m.sts_dsr_meeting_id=s.fk_sts_dsr_meeting_id AND (m.fk_sts_dsr_call_id IS NULL OR m.fk_sts_dsr_call_id=s.sts_dsr_call_id))
LEFT JOIN redash.sts_company mc ON mc.companyid=m.fk_sts_company_id
WHERE s.ucid=c.ucid AND c.ucid IS NOT NULL AND lower(trim(c.ucid)) NOT IN ('','0','null','na','n/a')
) dsr ON TRUE`;}
async function execute(sql,file){const expected=hash(sql);if(fs.existsSync(file)){const checkpoint=JSON.parse(fs.readFileSync(file,'utf8'));if(checkpoint.source!==13||checkpoint.queryId!==47566||checkpoint.query!==sql||checkpoint.query_sha256!==expected||!Array.isArray(checkpoint.rows))throw Error('Checkpoint query/source provenance differs');return checkpoint;}if(process.env.REDDASH_TRAINING_QUERY_ID?.trim()!=='47566')throw Error('Operational experiment requires dedicated training query47566');const start=Date.now();const result=await runQuery({query:sql,dataSourceId:13,queryIdEnv:'REDDASH_TRAINING_QUERY_ID'});if(result.queryId!==47566)throw Error('Unexpected training query ID');const record={source:13,queryId:result.queryId,query:sql,query_sha256:expected,extracted_at:new Date().toISOString(),elapsed_ms:Date.now()-start,rows:result.rows};fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(record),{mode:0o600,flag:'wx'});return record;}
async function main(){const command=process.argv[2]||'probe';fs.mkdirSync(root,{recursive:true});if(command==='probe'){for(const date of Object.values(dates).flat()){const sql=`WITH c AS MATERIALIZED (${spine(date,0,50)}) SELECT COUNT(*) AS rows,MIN(call_start_time) AS earliest,MAX(call_start_time) AS latest FROM c`;const r=await execute(sql,path.join(root,'coverage',`${date}.json`));console.log(JSON.stringify({date,...r.rows[0],elapsed_ms:r.elapsed_ms}));}return;}
if(command==='extract'){const pages=Number(process.argv[3]||10);if(!Number.isInteger(pages)||pages<1||pages>80)throw Error('pages must be 1..80');const version=root.endsWith('v3')?3:2;const plan={version,seed,dates,source:13,query_id:47566,per_chunk_cap:50,chunks_per_day:pages,scope_start:'2026-05-01',target:'observed_linked_physical_recorded_met_within14days',label_kind:'proxy',canonical_label_verified:false,availability_verified:false,features:'time-only; bounded prior existence from current replica for observed-scope cohort definition',query_template_sha256:hash(query('2026-08-12',0,50))};const file=path.join(root,'plan.json');if(version===3){const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;plan.preregistered_at=previous?.preregistered_at||new Date().toISOString();plan.expansion_reason='Uniform larger quota on all identical frozen dates before any model fitting; sparse v2 label volume; no outcome balancing or date changes';plan.parent_dataset_sha256=JSON.parse(fs.readFileSync('.data/btc-operational-v2/dataset-manifest.json','utf8')).dataset_sha256;plan.parent_raw_checksums=JSON.parse(fs.readFileSync('.data/btc-operational-v2/dataset-manifest.json','utf8')).raw_file_checksums;}const encoded=JSON.stringify(plan,null,2);if(fs.existsSync(file)&&fs.readFileSync(file,'utf8')!==encoded)throw Error('Frozen extraction plan differs');if(!fs.existsSync(file))fs.writeFileSync(file,encoded,{flag:'wx'});if(version===3){for(const [relative,expected] of Object.entries(plan.parent_raw_checksums)){const source=path.join('.data/btc-operational-v2',relative),target=path.join(root,relative),bytes=fs.readFileSync(source);if(hash(bytes)!==expected)throw Error('Parent checkpoint checksum differs');fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)){if(hash(fs.readFileSync(target))!==expected)throw Error('Nested checkpoint differs');}else fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});}}for(const [split,values] of Object.entries(dates)){for(const date of values){for(let page=0;page<pages;page++){const file=path.join(root,'raw',`${date}-${page}.json`);const r=await execute(query(date,page*50,50),file);console.log(JSON.stringify({split,date,page,rows:r.rows.length,dsr_rows:r.rows.filter(x=>x.dsr_calls.length).length,meeting_rows:r.rows.filter(x=>x.meetings.length).length,elapsed_ms:r.elapsed_ms}));if(r.rows.length<50)break;}}}return;}
throw Error('Use probe or extract');}
if(require.main===module)main().catch(error=>{console.error(JSON.stringify({error:error.message}));process.exitCode=1;});
module.exports={query,spine,dates,execute,root};
