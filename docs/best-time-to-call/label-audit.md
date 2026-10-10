# Label, attribution and timing audit

Audit date: 10 October 2026. Outcome: **canonical `meeting_done` access and equivalence remain unverified**. Source inspection establishes the existing DSR dashboard proxy and several safer linking/availability rules. Independent extraction, implementation and proxy experiments may continue, but the canonical accuracy and completed-meeting improvement acceptance stages must remain pending.

## What was actually checked

- Read `D:\Hackathon\prompt.md` and `lib/user-activity.ts`.
- Read the scoped ERP `merp-go/AGENTS.md` and `weberp/AGENTS.md`; inspected business source without executing ERP workflows.
- Parsed all three pages of the problem PDF and all five pages of the Global Context reference with `pypdf`.
- Inspected refreshed live schema metadata for all eight audited sources at `2026-10-09T19:18:51.964Z`: source 70 exposes 17 tables; 55 605; 10 140; 11 38; 8 301; 13 256; 21 351; 4 20. No table basename `call_master` or exact `meeting_done` / `meeting_fixed` columns were present. Evidence is in ignored `.data/best-time-to-call/live-schema-report.json` and `schema-{id}.json`; the prior inventory agrees. This is bounded exposure evidence, not a proof that the labels do not exist elsewhere.
- Inspected source-13 PostgreSQL type metadata extracted at `2026-10-09T19:15:59.077Z` in `column-types.json`: relevant call/meeting/assignment event and update fields are `timestamp without time zone`; IDs/counters and DSR code fields are `numeric`, attempt/click statuses are text. The field timezone still requires verification.
- Searched ERP first-party Go, SQL, PHP, Python, JavaScript, TypeScript, Java, VB and other text source for the exact canonical label/table names, disposition table/FK and hotlead mart interval fields. No matching canonical implementation or disposition-to-type FK definition was found. Broader `meeting_done` substring hits were participant/contact fields, which are not labels.
- Inspected operational meeting success SQL, appointment state SQL, reverse call links, assignment creation, Google Meet verification selection/writes and timezone conversion. Did not invoke an ERP API, launch calls/meetings, send messages, or write to a production database.

Live row counts, freshness and statistical reconciliation are owned by extraction reports. This source audit reviewed their persisted metadata and does not claim to have independently run production queries. The lead reported an initial 500-row pilot from 1 September 09:01-09:24 local assumption: 498 type/lead joins, 500 click references, 274 DSR references and no joined DSR meetings. The broader predefined sample contains 4,978 attempts / 4,706 sellers, 5 May-23 September, with 2,687 non-null DSR references, 2,701 non-null click references, 2,381 hot-lead-type matches, and no linked meetings or reverse-meeting references. Non-null references are **not proof of matched records**; the matched-ID audit is pending. Neither pilot supports canonical negatives or a completion classifier. The prompt's older 200-row samples remain inherited observations, not remeasured results.

## Findings and implications

| Finding | Exact evidence | Implication |
|---|---|---|
| PDF target differs from implementation objective | PS03 p1 section 3.4; `prompt.md` section 1 | Keep `meeting_done` primary and disclose the override; do not substitute fixed meetings |
| PDF gives outcome table but leaves access/time policy unresolved | PS03 p2 section 4: call_master outcomes; attempt times, retry configuration and timezone to be confirmed | Organizer must supply the canonical source, keys and semantics |
| Existing predicate is ERP-defined dashboard success | `getMeetingData.go:114-121`; app `lib/user-activity.ts:27` | Strong candidate proxy, not proof of exact canonical completion |
| Physical and video evidence differ | Same source, modes 90-92; physical duration 147-153; verifier selection `gmeet_data.py:32-36` | Report physical/video coverage and sensitivity separately |
| Forward call attribution exists | `getMeetingData.go:167-168` | Prefer direct DSR meeting -> call ID with seller validation |
| Reverse call -> meeting FK also exists | `ApiDsrForm.php:1230-1234` | Audit as recovery route; forward/reverse disagreements need quarantine |
| Appointment status 1 is written from meeting result | `ApiDsrForm.php:1231-1234`; `getAppointmentData.go:36-43` | It represents recorded met state; does not replace verified video outcome |
| Physical declared date differs from recorded time | `ApiDsrForm.php:166,933-959` reads posted meeting date and inserts entry as SYSDATE, date via date-only parsing | No measured physical end timestamp; recording-time proxy must be named explicitly |
| ERP outgoing status values are supported by API and report | `callFeedback.go:6,11-13`; `outboundHistory.go:47-50,69`; `singleLegCalling.go:65-70` | Require explicit Outgoing; Answered/NotAnswered are feedback states, Initiated remains unknown |
| Older hotlead auto-dialler module is source-backed | `WeberpAutoDailer.php:223-227,384-388`; `HotLeadAutoDialerReport.aspx.vb:590,902` | C2CAutoHotDialer identifies that cohort; ref_no can be GLID, and general ERP results do not transfer to the bot-disposition campaign |
| Person-met / email fields are contact details | `ApiDsrForm.php:39-43`; `gmeet_data.py:20-22` | Never treat `meeting_done_with` as binary label or transmit contact values to LLM |
| Video verification is delayed and mutable | `gmeet_data.py:32-36` selects prior/current-day unverified records; `gmeet_helper.py:92-150` calculates event times and posts updates | Completion event time and confirmation availability are distinct |
| Verification writer does not explicitly populate verify date | `CSDdata.php:7955-7984` (also 6740-6752 and 6794-6824) sets status 9 and event fields | Inspect database triggers/audit log before trusting verify date; otherwise first observed/extraction time is conservative availability |
| Global Context verified date can be invented by a documented default | Global Context reference p5 footnote 1: VM date + 1 day | Derived date cannot reconstruct when confirmation became known |
| Seller ID and lead ID are separate, supported type bindings | `HotLeadFunctions.php:1338-1348` | Check disposition/type/lead seller agreement; no seller-only join repair |
| Assignment records are created as events | `HotLeadFunctions.php:2264-2282` | Build effective intervals and avoid join fanout; outcomes on assignment snapshots need as-of treatment |
| Calendar/verifier uses Indian local time | `calendarAPI.py:183-192`; `utils.py:4-10` | Evidence for this workflow, not every call timestamp or seller; retain provenance |
| A 15-minute report is lead response, including meetings | `osreport.go:4231-4236` compares meeting entry to hot lead creation; report meeting join 4252-4267 | Not the PS03 unanswered-call retry delay; `attempt_15_mins` cannot establish causal retry effectiveness |
| Some ERP reports coalesce unknown values | `osreport.go:4232`; verifier `gmeet_data.py:34-36` | Match the strict dashboard predicate rather than silently counting null results/modes as success |

ERP paths in this table are relative to `C:\Users\imart\Pictures\No work\Repository`; full paths and field contract are in [data-dictionary.md](./data-dictionary.md).

## Verification gates for extraction

Before accepting a dataset:

1. Recheck source IDs and schemas; extract only needed fields and retain source/query version, observed freshness, date coverage and immutable checksums. Preserve source 70 call insights separately from source 13 ERP.
2. Measure by time slice: disposition IDs and physical calls per ID; null/duplicate UCIDs; direct FK coverage; seller disagreements; forward/reverse meeting link disagreements; meetings per call; attempts without links. Reconcile before deduplication and record every exclusion.
3. Specifically measure `fk_data_hot_lead_type_id` -> `hot_leads_types_id` and alternative `data_hot_leads_types_id` coverage/cardinality. Preserve unmatched type IDs and compare seller identities. The old 178/200 matching sample does not verify global referential integrity.
4. Establish actual call timestamp provenance and status mappings. DSR entry time, current cumulative attempt counts and AI summaries are not ready-made pre-call features.
5. Profile meeting entry/event/end/verify/modification/refresh timestamps, future dates, chronology and lag by mode. Inspect audit/CDC/triggers if available; direct API writes do not establish reliable verification timestamps.
6. Reconcile available DSR positives with the canonical label on a stratified same-call sample when access arrives. Report disagreement by physical/video/cancelled/Not-Met/pending/delayed-verification/duplicate/rescheduled cases. Without this, the proxy remains separately named.
7. Preregister outcome horizon, completion-event definition, lag/grace and split embargo before final test. Exclude unknown/unmatured labels and report linkage selection bias, especially unanswered attempts.
8. Derive real retry gaps within validated lead/campaign chains. Compare against rule configuration/audit data, not lead-response mart buckets. Use reporting marts only after obtaining their ETL/grain/window definitions.

## Organizer clarification required for the canonical stage

The precise missing inputs are:

- Read-only Redash source ID + schema/table/view (or authorized dated export) for `call_master`; original call ID / UCID / disposition linkage keys and row grain.
- Definitions and value domains for `meeting_done` and `meeting_fixed`; treatment of cancelled, rescheduled, duplicate, physical, video, Not-Met and later-reversed records.
- Which attempt receives credit, handling of repeated calls/appointments, and the allowed attribution horizon.
- Actual completion time, label observation/update time, revision history/CDC and expected observation/replication lag; whether zero is a final negative or pending/unknown state.
- Production unanswered status mapping, active 15-minute retry rule configuration and exceptions, campaign/lead retry-chain keys and maximum-attempt/contact-hour/DNC policy.
- Source timestamp storage timezone, seller timezone/country mapping and expected historical data coverage.

Suggested concise clarification: “Please provide read-only access or a dated export for the canonical `call_master.meeting_done` / `meeting_fixed` outcomes, with call/disposition join keys, completion and update timestamps, attribution horizon, and pending/cancelled definitions. Please also identify the actual unanswered-call 15-minute retry configuration and timestamp timezone; accessible DSR records currently establish only a separately named success proxy.”

The task permits a clearly labeled proxy experiment while this input is pending (`prompt.md:186`). It does not authorize describing it as verified `meeting_done` accuracy. An assumed 14-day horizon or one-day verification grace must be disclosed as an experiment assumption, not organizational policy. No schedule policy change is justified solely by a proxy classifier's test discrimination; a supported randomized/shadow evaluation is required when off-policy identification is unavailable.

## Safe continuation

The backend can return future eligible windows with null unsupported scores, declared constraint/timezone assumptions and an explicit canonical-label-blocked status. Extraction and model artifacts may be developed against the versioned DSR proxy contract in the dictionary, with proxy provenance in every manifest/model card/API evidence object. A zero-positive hotlead pilot must not train a completion classifier from inferred unlinked negatives. A separately named general-ERP physical recording-time proxy experiment can continue if representative positive/negative support and safe UCID/call joins are established, without transferring its results to the bot/hotlead objective. Historical video-success/yield features remain disabled because historical availability is unverified; mutable physical outcome history likewise needs actual update availability. Canonical scored-model deployment remains blocked even after exploratory proxy training. Continue architecture, tests, deterministic scheduling, LLM grounding and frontend integration without claiming unavailable training data or canonical results.
