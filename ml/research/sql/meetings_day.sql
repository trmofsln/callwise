-- Research v4: DSR meetings entered on one date whose company maps to a sampled seller, with the
-- forward-linked DSR call's UCID/entry time/seller. Identifiers pseudonymized with local salt ({salt}).
-- {part}/{parts} split by company id when one date exceeds the 5 s statement timeout. Read-only.
SELECT md5('{salt}m' || m.sts_dsr_meeting_id::bigint::text) AS meeting_key,
       md5('{salt}s' || sc.sts_fk_glusr_id::bigint::text) AS seller_key,
       m.sts_dsr_meeting_entrydate AS entered_at, m.sts_dsr_meeting_date AS meeting_date,
       m.sts_dsr_meeting_mode AS mode, m.sts_dsr_meeting_result AS result,
       m.sts_dsr_meeting_verify_status AS verify_status, m.sts_dsr_meeting_verify_date AS verify_date,
       m.sts_dsr_meeting_purpose AS purpose,
       md5('{salt}d' || m.fk_sts_dsr_call_id::bigint::text) AS dsr_call_key,
       md5('{salt}u' || nullif(lower(trim(s.ucid)), '')) AS dsr_ucid_key,
       s.sts_dsr_call_entrydate AS dsr_entered_at, s.sts_dsr_app_date AS dsr_app_date,
       md5('{salt}s' || sc2.sts_fk_glusr_id::bigint::text) AS dsr_seller_key
FROM redash.sts_dsr_meeting m
JOIN redash.sts_company sc ON sc.companyid = m.fk_sts_company_id
LEFT JOIN redash.sts_dsr_call s ON s.sts_dsr_call_id = m.fk_sts_dsr_call_id
LEFT JOIN redash.sts_company sc2 ON sc2.companyid = s.fk_sts_company_id
WHERE date(m.sts_dsr_meeting_entrydate) = DATE '{day}'
  AND mod(m.fk_sts_company_id::bigint, {parts}) = {part}
  AND mod((('x' || left(md5(sc.sts_fk_glusr_id::bigint::text), 7))::bit(28)::int), {mod}) < {keep}
