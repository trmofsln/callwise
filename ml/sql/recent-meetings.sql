SELECT sts_dsr_meeting_id::text AS meeting_id,
 fk_sts_dsr_call_id::text AS call_id,fk_sts_company_id::text AS company_id,
 sts_dsr_meeting_mode AS mode,sts_dsr_meeting_result AS result,
 sts_dsr_meeting_entrydate AS recorded_at,sts_dsr_meeting_date AS declared_date,
 sts_dsr_meeting_verify_status AS verify_status
FROM redash.sts_dsr_meeting ORDER BY sts_dsr_meeting_id DESC LIMIT 200
