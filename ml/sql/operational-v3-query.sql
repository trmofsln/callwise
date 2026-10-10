-- Example exact bounded query; actual fixed-date/chunk plans and hashes are in ignored extraction manifests.
WITH c AS MATERIALIZED (SELECT click_to_call_id,ucid,fk_glusr_usr_id,fk_employeeid,call_start_time,entered_on,status,module,last_modified_date
FROM redash.click_to_call WHERE date(entered_on)=DATE '2026-08-12' AND upper(flag_in_out)='OUTGOING'
AND fk_employeeid IS NOT NULL AND fk_glusr_usr_id IS NOT NULL AND fk_glusr_usr_id>0
AND call_start_time>=TIMESTAMP '2026-08-12' AND call_start_time<TIMESTAMP '2026-08-12'+INTERVAL '1 day'
AND lower(status) IN ('answered','notanswered')
ORDER BY md5(click_to_call_id::text||'erp-observed-v2-71'),click_to_call_id LIMIT 50 OFFSET 0)
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
) dsr ON TRUE;
