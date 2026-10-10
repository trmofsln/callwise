-- Research v4: outbound click-to-call rows for an md5 seller-hash cluster sample within one
-- entered_on block [{start}, {end}). Identifiers are pseudonymized server-side with a local salt
-- ({salt}); no raw IDs, phone numbers, names or recordings are returned. Read-only; chunked for
-- the replica's 5 s statement timeout.
SELECT md5('{salt}c' || click_to_call_id::bigint::text) AS call_key,
       md5('{salt}u' || nullif(lower(trim(ucid)), '')) AS ucid_key,
       md5('{salt}s' || fk_glusr_usr_id::bigint::text) AS seller_key,
       md5('{salt}e' || fk_employeeid::bigint::text) AS employee_key,
       md5('{salt}k' || fk_sts_companyid::bigint::text) AS company_key,
       lower(trim(ucid)) IN ('0', 'null', 'na', 'n/a') AS ucid_placeholder,
       call_start_time, call_end_time, entered_on, last_modified_date, lower(status) AS status, module,
       call_duration, ring_duration, custtype_id, vertical_id, is_sts_assigned, flag_call_type, vendor
FROM redash.click_to_call
WHERE entered_on >= TIMESTAMP '{start}' AND entered_on < TIMESTAMP '{end}'
  AND upper(flag_in_out) = 'OUTGOING' AND fk_glusr_usr_id > 0
  AND mod((('x' || left(md5(fk_glusr_usr_id::bigint::text), 7))::bit(28)::int), {mod}) < {keep}
