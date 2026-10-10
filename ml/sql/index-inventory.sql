SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
WHERE tablename IN ('click_to_call_mvw','click_to_call','sts_dsr_call','sts_dsr_meeting')
ORDER BY tablename,indexname LIMIT 100
