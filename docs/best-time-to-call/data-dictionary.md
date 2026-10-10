# Data dictionary and attribution contract

Audit date: 10 October 2026. The application objective is **completed meetings attributable to calls (`meeting_done`)**. PS03 instead makes `meeting_fixed` primary (problem PDF, page 1, section 3.4); the user override in [prompt.md](../../prompt.md) governs this implementation.

This document separates source-backed semantics from candidate mappings and experiment assumptions. A schema column being exposed is not proof of its meaning, freshness, historical availability, or completeness. A fresh live schema audit at `2026-10-09T19:18:51.964Z` (10 October locally) lists sources 70, 55, 10, 11, 8, 13, 21 and 4; none exposes a table with basename `call_master` or an exact column named `meeting_done` / `meeting_fixed`. Evidence: ignored `.data/best-time-to-call/live-schema-report.json` and `schema-{id}.json`; the earlier `.data/schema-audit.json` inventory agrees. Live extraction must record its own counts and timestamps.

## Label status

| Field / target | Evidence | Allowed use |
|---|---|---|
| `call_master.meeting_done` | Named by PS03 page 2, section 4; inaccessible in refreshed live schema exposure and absent from the inspected first-party ERP definitions | Intended canonical primary label; no verified training/evaluation claim until the source, linkage, semantics and maturity are provided |
| `call_master.meeting_fixed` | Named by the same PDF | Secondary canonical diagnostic; unavailable |
| `dsr_successful_meeting_proxy` | ERP `nsdTaskTracker/getMeetingData.go:114-121`, mirrored in `lib/user-activity.ts:27` | Explicitly named exploratory proxy, never renamed to canonical `meeting_done` |
| `sts_dsr_call.sts_dsr_app_status` | ERP `getAppointmentData.go:36-43`: 0 scheduled, 1 done and met, 2 done and not met, 3 cancelled, 4 rescheduled | Appointment state / reconciliation; status 1 alone does not establish verified video completion |
| `hot_leads_assign.meeting_fixed_date` | Source-13 column exposure only | Candidate secondary appointment timestamp; business/event definition still pending |
| `hot_leads_assign.first_sts_meet_date` | Source-13 column exposure only | Candidate lead-level reconciliation timestamp; not verified completion or attempt attribution |
| Warehouse `meeting_done_with`, `meeting_done_with_email` | ERP `ApiDsrForm.php:39-43` derives the first from the person met; verifier `gmeet_data.py:20-22` reads participant email | Contact/participant details; exclude from model inputs and never interpret as binary completion |
| Mart `meeting_*`, `l2_above_meeting_*`, `l2_above_vc_*` | Source 55 / 10 column exposure; no matching ETL definition discovered | Aggregate reconciliation only until row grain, windows, denominators and completion semantics are verified |

Proxy predicate, matching SQL null semantics:

```sql
sts_dsr_meeting_result IS NOT NULL
AND sts_dsr_meeting_result <> 9
AND (
  sts_dsr_meeting_mode = 0
  OR (sts_dsr_meeting_mode = 1 AND sts_dsr_meeting_verify_status = 9)
)
```

The source explicitly distinguishes physical mode 0 and video mode 1. Null/unknown modes, null results and result 9 are not positives. Do not copy alternative ERP reports' `COALESCE(result, 0) <> 9` into this contract: it counts null results differently. The physical predicate is employee-entered evidence and does not itself prove attendance, duration, signoff or organizer equivalence to `meeting_done`. Video status 9 has stronger operational verification evidence, still without canonical label reconciliation.

## Attempt spine and joins

| Source / entity | Grain / keys | Candidate linkage and checks |
|---|---|---|
| 13 `redash.data_hotlead_disposition_dtl` | Candidate attempt row; `data_hotlead_disposition_dtlid`, `fk_glusr_usr_id`, `call_start_time` | Preserve every eligible disposition row, including null call links and unmatched lead references. Verify whether updates replace attempt state and whether IDs correspond one-to-one to physical calls |
| 13 `redash.click_to_call` | Call record; `click_to_call_id`, `fk_glusr_usr_id`, `ucid` | Disposition `fk_click_to_call_id` -> call ID; require seller agreement. `call_start_time` is candidate actual call start, `entered_on` is entry/log time. `flag_in_out`: explicit `Incoming` / `Outgoing`; `status`: `Answered` / `NotAnswered` supported in feedback API. Normalize case, preserve unknown/nonterminal states |
| 13 `redash.sts_dsr_call` | Employee DSR call entry; `sts_dsr_call_id`, `fk_sts_company_id`, `ucid` | Disposition `fk_sts_dsr_call_id` -> DSR call ID; company -> seller. `sts_dsr_call_entrydate` can be manually entered/logged and is not automatically actual dial time |
| 13 `redash.sts_company` | Company/assignment record; `companyid`, `sts_fk_glusr_id` | DSR `fk_sts_company_id` -> company ID -> GLID. Validate uniqueness and seller agreement against direct attempt/click seller IDs |
| 13 `redash.sts_dsr_meeting` | Operational meeting record; `sts_dsr_meeting_id`, `fk_sts_dsr_call_id`, `fk_sts_company_id` | Forward meeting call FK -> DSR call ID is source-backed (`getMeetingData.go:167-168`). Count each distinct meeting ID once, aggregate to the attempt rather than expanding attempts |
| DSR reverse link | `sts_dsr_call.fk_sts_dsr_meeting_id` | ERP `ApiDsrForm.php:1230-1234` writes the link alongside app status. Use as a separately audited recovery route; conflict with forward FK -> quarantine, not duplicate credit |
| 13 `redash.sts_dsr_auth` | Multiple auth records per call; `sts_dsr_auth_id`, call FK | ERP ranks latest auth ID per meeting (`getMeetingData.go:154-181`); for historical features choose only auth records actually available at the decision, not today's latest record |
| 13 `redash.hot_leads_types` | Lead-origin/activity record; `hot_leads_types_id`, `fk_hot_leads_id`, `hot_leads_types_glusr_id` | Disposition's misleading `fk_data_hot_lead_type_id` is a **candidate** link to this table. Prompt's old bounded 200-row sample: 178 matches here, 0 to `data_hot_lead_type`, 22 unmatched. Revalidate over dated samples; no inferred FK constraint |
| 13 `redash.hot_leads` | Lead record; `hot_leads_id`, `fk_glusr_usr_id` | `hot_leads_types.fk_hot_leads_id` -> lead ID; require disposition seller = lead seller = type seller wherever populated |
| 13 `redash.hot_leads_assign` | Assignment event; `hot_leads_assign_id`, lead/type/seller FKs, `hot_leads_assign_date` | ERP inserts lead + GLID + employee + current assignment time (`HotLeadFunctions.php:2264-2282`). Use intervals ending at next assignment, with deterministic tie handling; never join all assignment rows to each call |
| 13 `redash.data_hot_lead_type` | Separate metadata entity; `data_hot_leads_types_id`, seller/activity IDs | Correct lead/event relationship not established. Never salvage an ID mismatch using a seller-only many-to-many join |
| 8 warehouse facts | Replicas with original call/meeting IDs and refresh dates | Choose one canonical event source and reconcile replicas by original ID. Source 8 alternatives are not extra independent examples |
| 55 / 10 `gl_hotlead` marts | Unknown aggregate grain; GLID + lead/activity/date fields | Fetch separately and compare grain/key uniqueness; never concatenate replicas or expose future attempt/meeting counts as pre-call inputs |

ERP `HotLeadFunctions.php:1338-1348` binds `hot_leads_types_glusr_id` from the GLID parameter and `fk_hot_leads_id` from the lead ID. This supports identity meanings, **not** disposition-FK equivalence. Fresh source-13 `information_schema.columns` results at `2026-10-09T19:15:59.077Z`, in `.data/best-time-to-call/column-types.json`, verify IDs and attempt counters as `numeric`, attempt/click statuses as `character varying`, DSR mode/result/status codes as `numeric`, and all listed event/update timestamp fields as `timestamp without time zone`. Preserve IDs as strings; do not round them through floating-point values. FK constraints, enum value meanings and temporal overwrite behavior still require data checks.

Deduplicate meaningful UCIDs only when records agree on seller, direction/campaign and actual call time within a declared tolerance. Ignore placeholder UCIDs (`0`, `null`, `na`, `n/a`, empty). Missing UCIDs retain source-specific IDs; a UCID collision with conflicting sellers must be quarantined. Multiple disposition rows linked to one physical call become one attempt only after measuring and documenting the relationship. Keep original IDs, source provenance and merge reason in the ignored audit data.

Do not credit a call based only on GLID and a later meeting or the nearest preceding call. Reschedule IDs need explicit chain semantics before use; ERP displays non-null values as call rescheduled (`callPurpose.go:350-357`), but that does not prove which call should receive completion credit.

## Timestamp and feature eligibility

| Timestamp / field family | Semantics and safe treatment |
|---|---|
| Attempt `call_start_time`, click `call_start_time` | Candidate actual attempt event time. Cross-check direct-linked records, types, offset handling, missingness and chronology. Preserve raw value and normalized UTC/local timestamps |
| DSR entry, click `entered_on` | Entry/log time. Used as availability lower-bound evidence when trustworthy, not silently substituted for dial time in hour/day training |
| `lead_sent_time`, `vendor_response_time`, `last_updated_on` | Dispatch, response, update candidates. Meanings and overwrite behavior pending. The current call status/summary/duration/disposition are post-attempt and barred from its pre-call features |
| `sts_dsr_app_date` + `sts_dsr_app_time` | Scheduled appointment date/time; not completion time |
| `sts_dsr_meeting_date` | User-entered `meetingdate` in ERP `ApiDsrForm.php:166`, inserted with `TO_DATE(...,'DD-MM-YY')` at 959; legacy physical workflow records the day at midnight, not an actual completion hour |
| `virtual_meet_start_time`, `virtual_meet_end_time` | Verifier-derived video event times; API writes them with status 9 (`CSDdata.php:7955-7984`). End time can support video completion occurrence when sane; verification becomes known later |
| `sts_dsr_meeting_entrydate` | Operational entry time, set to insertion `SYSDATE` in `ApiDsrForm.php:933-959`. Physical proxy recording/observation time, not measured physical end time |
| `auth_verification_time` | Authentication event; ERP duration proxy is meeting entry minus this value (`getMeetingData.go:147-153`). This is not an independently measured physical meeting duration |
| `sts_dsr_meeting_verify_date`, `sts_dsr_meet_mod_date` | Columns exposed, but API code inspected does not set them when confirming status 9. Do not assume either is reliable availability time without trigger/CDC/audit evidence |
| Warehouse `data_refresh_date`, mart `refresh_date` | Replication/refresh observation candidates; do not backdate availability to original event time |
| Current counters, profile, customer type, assignment, lead last-activity, Global Context snapshot | Mutable current state. Eligible at current inference if timely and relevant; excluded from historical training unless reconstructed as of the decision |
| Global Context `video_verified_date` | Reference PDF page 5 footnote 1 explicitly defaults to VM date + 1 day. It is derived, not a trusted verification audit timestamp |
| `glusr_usr_lastlogin` | User flagged unreliability; excluded unless independently verified |

Store both `event_at` (when the event occurred) and `available_at` (when the system could know it). Prior features require **both** to be strictly before `decision_at`. For each label store `completion_event_at`, `label_observed_at`, `label_mature_at`, `extracted_at`, source/version, outcome horizon and whether availability is verified or conservative. Any confirmation lacking proven historical availability uses extraction/first-observation time for features; it cannot be retroactively injected into earlier histories. **Historical video-success/meeting-yield features are disabled until that availability is established.** Later labels may train a forward outcome target after maturity, but do not make an earlier decision's features more informed.

Timezone evidence: calendar creation sets `Asia/Kolkata` (`calendarAPI.py:183-192`), and verifier transforms external report timestamps by +05:30 (`utils.py:4-10`). This supports that workflow only. It does not establish every PostgreSQL call timestamp's storage convention or every seller's timezone. Check `information_schema.columns` timestamp types, `current_setting('TimeZone')`, and an actual known event against provider and ERP time. Never append `Z` to timezone-naive strings. An India-only fallback must be recorded as `timezone_provenance=assumed_Asia_Kolkata`; overseas/unknown-country sellers require a verified mapping or an insufficient-data result.

## Exploratory proxy target contract

The following is an experiment definition, **not** an organizer-verified completion contract:

1. Unit: one deduplicated target-campaign/outbound physical call attempt, prediction time immediately before the actual call start. If actual call time, seller identity or eligible campaign cannot be established, exclude with a reason. Unlinked attempts remain in coverage diagnostics; they are not automatically known negatives.
2. Attribution: unique audited direct disposition -> DSR -> meeting FK path, with a separate reverse-FK recovery count. Require seller agreement and no conflicting links. A meeting ID receives credit once. Ambiguous/repeated call paths are quarantined, not assigned to every attempt.
3. Target name: `dsr_successful_meeting_proxy`; binary positive if at least one source-predicate-successful attributed meeting occurs after the attempt and inside a preregistered horizon. Count distinct meetings separately. Video occurrence uses sane virtual end time where supplied; physical occurrence uses DSR entry as an explicitly declared **recording-time proxy**. Cross-source chronological inconsistencies are excluded.
4. Horizon: configurable and preregistered before inspecting final test outcomes. A 14-day pilot horizon may be used as an engineering assumption, with 7/14/30-day development sensitivity checks. No ERP/PDF evidence verifies a canonical 14-day horizon. Preserve horizons in the manifest/model card and label name/version.
5. Observation: successful video confirmation may arrive later than its end/entry time. Require verified availability metadata, or conservatively mark it known at extraction/first observation. A video confirmation API not writing verify date makes blanket "available one day later" reconstruction unsafe.
6. Maturity: let `H` be the horizon and `L` a source-specific verified observation/replication grace period. Exclude ordinary-classification attempts until the full `[attempt_at, attempt_at + H]` outcome window plus `L` is covered by a source watermark. Pending unverified meetings or incomplete linkage make the label unknown/censored. Do not set recent or inaccessible outcomes to 0. Derive `L` from measured lag; an assumed grace must be disclosed and tested, not presented as verified.
7. Negative: no qualifying meeting within `H` **and** complete mature outcome coverage plus reliable attribution. For disposition-only records without DSR linkage, absent completion cannot establish a negative until canonical call-level labels or validated missing-link coverage are provided. Report exclusion/selection bias and coverage by unanswered/answered cohort.
8. Splits: chronology with embargo at least `H + L`; train-history features use only outcomes known before each decision. First-contact/cold-start uses verified zero preceding target-campaign history over known coverage, distinct from a failed fetch or truncated history.

This proxy can support implementation tests and a clearly marked exploratory experiment. It cannot support a claim of canonical `meeting_done` accuracy, causal schedule improvement or achievement of the completed-meeting policy acceptance goal. Scored-model deployment for the canonical objective remains blocked even if a proxy model is trained; informational scheduling with null unsupported probabilities can continue.

## Separate general-ERP exploratory cohort

If the hotlead attempt extraction has no usable linked positive labels, a separate ERP experiment may inspect `click_to_call` -> meaningful UCID -> `sts_dsr_call` -> direct `sts_dsr_meeting` links. ERP `recentConnectModel/outboundHistory.go:47-50` uses that UCID join and line 69 explicitly filters `flag_in_out='Outgoing'`. The feedback schema validates `Incoming`/`Outgoing` at `schemas/c2c/callFeedback.go:11`, `Answered`/`NotAnswered` at line 6, and actual start/end arguments at 12-13. Require explicit outgoing, valid actual start, seller/company consistency, UCID uniqueness and source-specific availability checks; do not default a null direction to outgoing. `Initiated` is nonterminal (`callJourneyDecider/singleLegCalling.go:65-70`), so all non-answered statuses must not be classified as unanswered.

For a physical-only provisional target, name it `erp_recorded_physical_meeting_proxy_within_H`: mode 0, non-null result other than 9, direct verified call linkage, and **recording-time** occurrence from DSR entry in the preregistered horizon. The declared meeting day is a date-only manual input, and entry time is the insertion clock. This experiment measures recorded physical-meeting associations in general employee outbound calls; it is not actual end-time verification, canonical `meeting_done`, or a claim about the bot/hotlead campaign. Label/history availability of physical results still needs update/audit checks; current mutable final records may not be backdated into historical yield features.

The older hotlead auto-dialler writes `click_to_call.module='C2CAutoHotDialer'` (`WeberpAutoDailer.php:223,384`) and its report filters that value (`HotLeadAutoDialerReport.aspx.vb:590,902,1247,1641`). Its `ref_no` is opportunity ID **or GLID** (`WeberpAutoDailer.php:224,385`), so it is not automatically a lead/campaign key. Module values can identify an inspected channel cohort, but do not establish that every disposition row shares it. Other module values are supplied by screens/workflows, including employee/empconnect/joboffer (`clicktocall_helper.go:185-190`); restrict and validate seller-directed employee calls deliberately.

## Retry and eligibility fields

`call_attempt_count` is not a trusted as-of ordinal until its overwrite behavior and campaign grain are verified. Derive attempt order and actual gaps from unique event times within a validated seller/lead/campaign chain, with deterministic ID ties. Missing/partial earlier history produces an unknown ordinal, not attempt 1. Count previous *available* unanswered statuses only after authoritative status mapping.

Apply DNC/wrong-number/not-interested/non-prospective timestamps only once they were known; a mutable row's later stop marker cannot remove earlier eligible attempts retroactively. Configure conservative calling hours, max retries, cooldown and pending-appointment stops as assumptions until business policy is supplied. PNS preferences require decoding and scope verification before enforcing them on employee outbound calls.

The ERP opportunity report's 15-minute interval is from **lead creation** to activity (`osreport.go:4231-4236`), whereas PS03 describes a retry 15 minutes after an unanswered call. The exposed mart field `attempt_15_mins` establishes neither that retry gap nor its effectiveness. Rule evaluation must compute attempt-to-attempt gaps in verified retry chains and compare mature completion outcomes with comparable support, not label lead-response aggregates as retry experiments.

## Source references

ERP references are relative to `C:\Users\imart\Pictures\No work\Repository`:

- `merp-go/src/cluster/multiModules/app/models/nsdTaskTracker/getMeetingData.go`: mode 90-92, predicate 114-121, physical-duration proxy 147-153, dedup/auth 154-181, call/company joins 162-171.
- `merp-go/src/cluster/multiModules/app/models/nsdTaskTracker/getAppointmentData.go`: appointment codes 36-43, scheduled appointment fields 45-46, call result filter 54.
- `mrp/protected/models/ApiDsrForm.php`: person-met value 39-43, reverse call/meeting link and state 1230-1234.
- `mrp/protected/models/ApiDsrForm.php`: declared meeting date input 166, entry/declared-date insertion 933-959; `ApiDsrFormNative.php`: same date semantics 303-304, 962-989.
- `merp-go/src/gin-api/app/models/recentConnectModel/outboundHistory.go`: UCID join 47-50, outgoing filter 69; `schemas/c2c/callFeedback.go`: terminal feedback statuses 6, direction 11, start/end 12-13; `services/callJourneyDecider/singleLegCalling.go`: initiated state 65-70.
- `mrp/protected/models/WeberpAutoDailer.php`: hotlead module/ref-no/UCID 223-227, 384-388; `weberp/company/HotLeadAutoDialerReport.aspx.vb`: module filters 590, 902, 1247, 1641.
- `merp-go/src/gin-api/app/services/clicktocall/clicktocall_helper.go`: module distinctions 185-190.
- `mrp/protected/components/HotLeadFunctions.php`: lead-type GLID/lead bindings 1338-1348, assignment events 2264-2282.
- `mrp/protected/modules/csd/models/CSDdata.php`: video confirmation writes 6740-6752, 6794-6824 and 7955-7984.
- `mrp/protected/modules/csd/controllers/CSDMeetingController.php`: video confirmation dispatch 4795-4824, verification history comment and queue 4863-4889.
- `erp_bg_process/py_app/models/gmeet_data.py`: meeting/call/company join 25-30 and unverified prior/current-day selection 32-36.
- `erp_bg_process/py_app/services/gmeet_helper.py`: derives start/end and posts verifier fields 92-150.
- `erp_bg_process/py_app/calendarAPI.py`: timezone 183-192; `utils/utils.py`: report conversion 4-10.
- `merp-go/src/merp/models/reportmodel/osreport.go`: company-based call/report joins 4181-4206, lead-response interval 4231-4236, meeting joins 4252-4267.
- `merp-go/src/gin-api/app/models/call_purpose/callPurpose.go`: reschedule display 350-357.

Local references: `Copy of PS03_Best_Time_to_Call.docx.pdf` pages 1-3 and `Global Context Master sheet - Global Context Keys.pdf` pages 2 and 5, both in `C:\Users\imart\Downloads`; `lib/user-activity.ts:27`, `:67`, `:83`, `:99`, `:117`; `.data/schema-audit.json`; `.data/best-time-to-call/live-schema-report.json`, `schema-{id}.json`, `column-types.json` (ignored audit artifacts).
