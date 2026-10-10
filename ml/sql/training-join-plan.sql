EXPLAIN WITH c AS (SELECT click_to_call_id,ucid,fk_glusr_usr_id,call_start_time,entered_on
 FROM redash.click_to_call WHERE date(entered_on)=DATE '2026-07-15'
 AND upper(flag_in_out)='OUTGOING' AND fk_employeeid IS NOT NULL
 AND call_start_time IS NOT NULL AND fk_glusr_usr_id IS NOT NULL
 ORDER BY md5(click_to_call_id::text || 'erp-pilot-43') LIMIT 400)
SELECT c.*,s.sts_dsr_call_id,m.sts_dsr_meeting_id
FROM c LEFT JOIN redash.sts_dsr_call s ON s.ucid=c.ucid
LEFT JOIN redash.sts_dsr_meeting m ON m.fk_sts_dsr_call_id=s.sts_dsr_call_id
