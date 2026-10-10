WITH d AS (
 SELECT * FROM redash.data_hotlead_disposition_dtl
 WHERE call_start_time >= TIMESTAMP '2026-09-01' AND call_start_time < TIMESTAMP '2026-09-03'
 ORDER BY data_hotlead_disposition_dtlid LIMIT 1000
)
SELECT COUNT(*) AS sampled_attempts,
 COUNT(c.click_to_call_id) AS matched_clicks, COUNT(s.sts_dsr_call_id) AS matched_dsr,
 COUNT(h.hot_leads_types_id) AS matched_lead_types,
 COUNT(CASE WHEN c.fk_glusr_usr_id <> d.fk_glusr_usr_id THEN 1 END) AS click_seller_conflicts,
 COUNT(CASE WHEN h.hot_leads_types_glusr_id <> d.fk_glusr_usr_id THEN 1 END) AS lead_seller_conflicts,
 COUNT(CASE WHEN s.fk_sts_dsr_meeting_id IS NOT NULL THEN 1 END) AS reverse_links
FROM d LEFT JOIN redash.click_to_call c ON c.click_to_call_id = d.fk_click_to_call_id
LEFT JOIN redash.sts_dsr_call s ON s.sts_dsr_call_id = d.fk_sts_dsr_call_id
LEFT JOIN redash.hot_leads_types h ON h.hot_leads_types_id = d.fk_data_hot_lead_type_id
