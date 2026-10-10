/* eslint-disable @typescript-eslint/no-require-imports -- Bounded cross-source metadata/outcome inspection. */
require('@next/env').loadEnvConfig(process.cwd());
const fs=require('node:fs');
const {loadServer}=require('./server-loader.cjs');
const {runQuery}=loadServer('lib/redash.ts');
const inspections=[
  {id:8,name:'warehouse_meetings',grain:'DSR meeting replica; reconcile original meeting ID',role:'outcome reconciliation only',query:'SELECT sts_dsr_meeting_id,fk_glusr_usr_id,fk_sts_dsr_call_id,sts_dsr_meeting_mode,sts_dsr_meeting_result,sts_dsr_meeting_verify_status,sts_dsr_meeting_entrydate,sts_dsr_meeting_date,sts_dsr_meeting_verify_date,data_refresh_date FROM im_dwh_rpt.fact_sts_dsr_meeting LIMIT 200'},
  {id:55,name:'clickhouse_hotlead_mart',grain:'Reporting lead aggregate; key uniqueness unverified',role:'future outcome aggregates excluded from features',query:'SELECT fk_glusr_usr_id,fk_hot_leads_id,activity_id,hot_leads_date,hot_leads_time,attempt_15_mins,talked_15_mins,meeting_14,refresh_date FROM bi_reporting_mart_read.gl_hotlead LIMIT 200'},
  {id:10,name:'daily_hotlead_mart',grain:'Reporting lead aggregate replica, not independent training rows',role:'reconciliation only',query:'SELECT fk_glusr_usr_id,fk_hot_leads_id,activity_id,hot_leads_date,hot_leads_time,attempt_15_mins,talked_15_mins,meeting_14,refresh_date FROM im_datamart_rpt.gl_hotlead LIMIT 200'},
  {id:21,name:'contact_preferences',grain:'Seller/contact/type setting snapshot; semantics unverified',role:'no automatic ERP outbound restriction until type/flag meaning verified',query:'SELECT fk_glusr_usr_id,iil_pns_setting_type,iil_pns_setting_offhrs_flag,iil_pns_setting_last_update FROM mesh_report.iil_pns_setting LIMIT 200'},
  {id:13,name:'lead_assignments',grain:'Assignment event/current markers; effective intervals unverified',role:'current DNC safety marker; outcome dates not completion labels',query:'SELECT hot_leads_assign_id,fk_hot_leads_id,fk_hot_leads_types_id,fk_glusr_usr_id,hot_leads_assign_date,meeting_fixed_date,first_sts_meet_date,do_not_call_mark_date FROM redash.hot_leads_assign LIMIT 200'},
  {id:13,name:'category_mapping',grain:'Seller/product/category mapping; many to many',role:'snapshot excluded unless as-of membership reconstructed',query:'SELECT fk_glusr_usr_id,fk_glcat_mcat_id,fk_pc_item_id,item_mapping_isprime,map_date FROM redash.pc_item_to_glcat_mcat LIMIT 200'},
];
async function main() {
  const dir='.data/best-time-to-call/source-checks';fs.mkdirSync(dir,{recursive:true});
  const report=[];
  for(const source of inspections) {
    try {
      const result=await runQuery({query:source.query,dataSourceId:source.id,queryIdEnv:'REDDASH_TRAINING_QUERY_ID'});
      fs.writeFileSync(`${dir}/${source.name}.json`,JSON.stringify({extracted_at:new Date().toISOString(),source:source.id,query:source.query,rows:result.rows}),{mode:0o600});
      const columns=[...new Set(result.rows.flatMap(r=>Object.keys(r)))];
      const missingness=Object.fromEntries(columns.map(c=>[c,result.rows.length?result.rows.filter(r=>r[c]===null||r[c]===undefined).length/result.rows.length:null]));
      const dates=columns.filter(c=>/date|update/.test(c));
      const date_ranges=Object.fromEntries(dates.map(c=>{const values=result.rows.map(r=>r[c]).filter(Boolean).map(String).sort();return [c,values.length?[values[0],values.at(-1)]:null];}));
      report.push({source:source.id,name:source.name,status:'sampled',sample_rows:result.rows.length,grain:source.grain,role:source.role,missingness,date_ranges,event_time_verified:false,availability_time_verified:false,refresh_lag_verified:false,sampling:'unordered LIMIT200; not population statistics'});
    } catch(e) {report.push({source:source.id,name:source.name,status:'failed',reason:e.message,grain:source.grain,role:source.role});}
    console.log(JSON.stringify(report.at(-1)));
  }
  fs.writeFileSync(`${dir}/report.json`,JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
