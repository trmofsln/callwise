EXPLAIN SELECT click_to_call_id,call_start_time,ucid
FROM redash.click_to_call WHERE call_start_time >= TIMESTAMP '2024-06-01'
AND call_start_time < TIMESTAMP '2024-06-02' AND lower(flag_in_out)='outgoing'
LIMIT 5000
