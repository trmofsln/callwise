SELECT MIN(entered_on) AS oldest_normal, MAX(entered_on) AS newest_normal
FROM redash.click_to_call
WHERE entered_on>=TIMESTAMP '2026-01-01'
AND entered_on<TIMESTAMP '2026-10-11'
