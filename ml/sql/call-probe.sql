SELECT sts_dsr_call_id::text AS call_id, ucid, fk_sts_company_id::text AS company_id,
 sts_dsr_call_entrydate AS recorded_at, sts_dsr_call_result AS result,
 fk_sts_dsr_meeting_id::text AS reverse_meeting_id, sts_dsr_call_by::text AS employee_id
FROM redash.sts_dsr_call
LIMIT 300
