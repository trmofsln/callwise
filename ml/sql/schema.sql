SELECT table_name, column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'redash' AND table_name IN
('data_hotlead_disposition_dtl','hot_leads_types','hot_leads','hot_leads_assign','click_to_call','sts_dsr_call','sts_dsr_meeting','glusr_usr','pc_item_to_glcat_mcat')
ORDER BY table_name, ordinal_position
