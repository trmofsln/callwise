WITH attempts AS (
 SELECT d.* FROM redash.data_hotlead_disposition_dtl d
 WHERE d.call_start_time >= TIMESTAMP '2026-09-01' AND d.call_start_time < TIMESTAMP '2026-09-08'
 ORDER BY d.call_start_time, d.data_hotlead_disposition_dtlid LIMIT 500
)
SELECT d.data_hotlead_disposition_dtlid::text AS attempt_id,
 d.fk_glusr_usr_id::text AS seller_id, d.fk_data_hot_lead_type_id::text AS lead_type_reference,
 d.call_start_time, d.lead_sent_time, d.last_updated_on, d.call_attempt_count,
 d.lead_call_status, d.lead_disposition_id, d.lead_call_duration,
 d.fk_click_to_call_id::text AS click_id, d.fk_sts_dsr_call_id::text AS dsr_id,
 h.hot_leads_types_id::text AS matched_lead_type_id, h.fk_hot_leads_id::text AS lead_id,
 h.hot_leads_types_glusr_id::text AS lead_seller_id, h.hot_leads_date AS lead_created_at,
 h.activity, h.hot_leads_data_type,
 c.ucid AS click_ucid, c.fk_glusr_usr_id::text AS click_seller_id, c.call_start_time AS click_start_time,
 c.fk_employeeid::text AS click_employee_id, c.status AS click_status,
 s.ucid AS dsr_ucid, s.sts_dsr_call_by::text AS dsr_employee_id,
 s.sts_dsr_call_entrydate AS dsr_recorded_at, s.sts_dsr_app_date, s.sts_dsr_call_result,
 s.fk_sts_dsr_meeting_id::text AS reverse_meeting_id,
 sc.sts_fk_glusr_id::text AS dsr_seller_id,
 COALESCE(ms.meetings, '[]'::jsonb) AS meetings
FROM attempts d
LEFT JOIN redash.hot_leads_types h ON h.hot_leads_types_id = d.fk_data_hot_lead_type_id
LEFT JOIN redash.click_to_call c ON c.click_to_call_id = d.fk_click_to_call_id
LEFT JOIN redash.sts_dsr_call s ON s.sts_dsr_call_id = d.fk_sts_dsr_call_id
LEFT JOIN redash.sts_company sc ON sc.companyid = s.fk_sts_company_id
LEFT JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object('meeting_id',m.sts_dsr_meeting_id::text,
 'call_id',m.fk_sts_dsr_call_id::text,'mode',m.sts_dsr_meeting_mode,'result',m.sts_dsr_meeting_result,
 'verify_status',m.sts_dsr_meeting_verify_status,'meeting_at',m.sts_dsr_meeting_date,
 'entry_at',m.sts_dsr_meeting_entrydate,'verify_at',m.sts_dsr_meeting_verify_date,
 'modified_at',m.sts_dsr_meet_mod_date,'end_at',m.virtual_meet_end_time)) AS meetings
 FROM redash.sts_dsr_meeting m WHERE m.fk_sts_dsr_call_id = d.fk_sts_dsr_call_id
 OR (m.sts_dsr_meeting_id = s.fk_sts_dsr_meeting_id AND (m.fk_sts_dsr_call_id IS NULL OR m.fk_sts_dsr_call_id = d.fk_sts_dsr_call_id))
) ms ON TRUE
