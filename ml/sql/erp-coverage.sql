WITH m AS (
 SELECT * FROM redash.sts_dsr_meeting
 WHERE sts_dsr_meeting_entrydate >= TIMESTAMP '2026-09-01'
   AND sts_dsr_meeting_entrydate < TIMESTAMP '2026-09-08'
 ORDER BY sts_dsr_meeting_entrydate LIMIT 500
)
SELECT COUNT(*) AS sample_meetings, COUNT(s.sts_dsr_call_id) AS call_links,
 COUNT(c.click_to_call_id) AS click_ucid_links,
 COUNT(CASE WHEN m.sts_dsr_meeting_result IS NOT NULL AND m.sts_dsr_meeting_result <> 9
 AND (m.sts_dsr_meeting_mode = 0 OR (m.sts_dsr_meeting_mode = 1 AND m.sts_dsr_meeting_verify_status = 9)) THEN 1 END) AS proxy_success,
 MIN(m.sts_dsr_meeting_entrydate) AS oldest, MAX(m.sts_dsr_meeting_entrydate) AS newest
FROM m LEFT JOIN redash.sts_dsr_call s ON s.sts_dsr_call_id = m.fk_sts_dsr_call_id
LEFT JOIN LATERAL (SELECT click_to_call_id FROM redash.click_to_call
WHERE ucid = s.ucid AND ucid IS NOT NULL AND ucid NOT IN ('','0','null','NA','na') LIMIT 1) c ON TRUE
