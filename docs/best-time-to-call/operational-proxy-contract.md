# Experimental operational proxy contract

Audit date: 10 October 2026. This contract defines a new, separately versioned database experiment named **`observed_linked_physical_recorded_met_within14days`**. It can train and compare models on real ERP records. It measures an observed recorded association, and does not establish canonical `meeting_done`, actual physical completion time, hotlead/bot performance, or improvement caused by calling at a different time. The existing [canonical audit](./label-audit.md) and [data dictionary](./data-dictionary.md) remain applicable.

## Unit, cohort and target

| Item | Experimental definition |
|---|---|
| Unit | One distinct seller-directed ERP outgoing call with valid `click_to_call.call_start_time`, positive seller GLID, and audited identity/deduplication |
| Source | Source 13 `redash.click_to_call`; UCID -> `redash.sts_dsr_call`; company -> seller; DSR direct/reverse meeting links |
| Cohort | General ERP employee outgoing calls during the preregistered 1 May-16 September 2026 extraction interval. Verify the actual sample interval in its manifest. It is a new dataset, separate from the disposition/hotlead sample |
| Direction | Case-normalized explicit `Outgoing`; exclude null/unknown, incoming and short-call values. Do not default missing direction to outgoing |
| Target 1 | At least one distinct seller-consistent linked physical meeting, mode 0, non-null result other than 9, with `call_start_time < sts_dsr_meeting_entrydate <= call_start_time + 14 days`, present in the frozen extraction snapshot |
| Target 0 | No such **observed linked recorded-met record** in that snapshot. This is an observed-absence class for this experiment; it is **not a canonical completed-meeting negative**. Missing linkage, later revisions and unrecorded meetings can produce false absence relative to actual completion |
| Target time | Meeting entry/recording time; physical end time is not available. Declared meeting date is a manually supplied day, parsed without an hour in the inspected workflow |
| As-of | Frozen extraction/observation time, included in the manifest; the positive predicate uses final values observed then |
| Maturity | Full nominal 14-day recording window before extraction plus a preregistered observation grace if used. This closes the experiment's timestamp window; it does not prove finality/completeness of canonical outcomes or replication |
| Outputs | Proxy discrimination/calibration/yield against observed labels, per-cohort coverage, actual sample prevalence and uncertainty. Report the target name and snapshot limitation beside each results table |

Direct link means `meeting.fk_sts_dsr_call_id = dsr.sts_dsr_call_id`; reverse link means `dsr.fk_sts_dsr_meeting_id = meeting.sts_dsr_meeting_id`. Require agreement where both exist. A reverse recovery with a contradictory forward call ID must be quarantined, not credited to both. Validate DSR company seller against click seller and meeting company seller against both. A matching UCID alone is insufficient if sellers, employees, times or call identity disagree. Aggregate distinct meetings to one binary attempt label; do not expand attempts through meeting, company, employee or category joins. Track missing, conflicting and recovered links separately.

Keep placeholders out of UCID matching and diagnose one UCID linking to multiple physical calls/DSR records. A meeting should receive one call credit under the selected deterministic attribution contract; ambiguous duplicate paths require exclusion/audit rather than multiplication. Forward/reverse ID references and **actually matched** records are different counts. Do not build the sampling frame only from positive meetings; sample eligible outgoing attempts across time/cohorts, then join labels independently.

## `entered_on` is mutable and cannot prove availability

The source disproves a blanket claim that `click_to_call.entered_on` is an immutable insert clock:

| Business source evidence | Finding |
|---|---|
| `models/click_to_call/insertC2C.go:109-112` | Insert accepts a caller-supplied `entered_on` |
| `models/click_to_call/updateC2C.go:125-131` | Update overwrites `entered_on` from a supplied value or `sysdate`; separately sets last-modified time |
| `mrp/protected/models/CallUpdate.php:468-472` | PostgreSQL update explicitly sets `ENTERED_ON` from supplied entry date |
| `services/dialerCalls/dialerCalls_helper.go:54` | Update maps supplied `entry_date` into `entered_on` |
| `mrp/protected/models/WeberpAutoDailer.php:1222` | One PostgreSQL initiation insert uses `LOCALTIMESTAMP(0)` |
| `models/preclicktocall/preClickToCall.go:118-125` | Pre-call insert accepts a supplied epoch or defaults to `current_timestamp` |
| `services/clicktocall/outgoingC2C.go:63-65` | One outgoing route copies entry time from `pre_click_to_call` into the later call record |

Therefore `entered_on <= call_start_time` can be a **consistency filter**, but does not establish that the row or its current employee/status/metadata values existed before the call. Restricting it can also select only initiated/captured workflows and exclude later-ingested calls; quantify its coverage and label-rate differences. Do not label this filter “caller known before” or claim it makes all features leakage-safe.

The refreshed source-13 schema exposes `redash.pre_click_to_call`: pre-call ID, UCID, seller/employee IDs, module, direction and `entered_on`. An audited unique pre-call record, whose creation provenance and time are verified, can support intended caller availability. It must be matched and checked, not assumed from a later C2C timestamp. The exposed column by itself is not proof of immutable history. No live query was issued as part of this source follow-up.

## Employee and call-state scope

`fk_employeeid` is the intended employee ID: `services/clicktocall/clicktocallInsert.go:34` names it `IntendedForEmpid`; `writeC2CService.go:99` logs “Intended for” separately from `esc_answered_by` (“Picked by”). Dialler input maps employee ID to this field (`dialerCalls_helper.go:18-20`). The outgoing pre-call route copies employee ID to both intended/picked fields (`outgoingC2C.go:77-79`), and the initiation route explicitly sets outgoing and initiated state after an employee lookup (`callJourneyDecider/singleLegCalling.go:58-70`). These paths support employee-origin semantics for that workflow, not a guarantee that every row represents the same employee or campaign.

The current employee FK can be filled or changed later (`models/click_to_call/updateC2C.go:51-54`; PostgreSQL `CallUpdate.php:480-483`). Use a consistent employee join for cohort/audit, retain missing/mismatch counts, and avoid filtering historical attempts by today's employment/working/assignment status. A current employee dimension is not effective-dated employee history. Caller ID should be omitted from the first model unless actual pre-call provenance is established; if used only under an assumption, name the feature `snapshot_intended_employee`, disclose it, and publish a no-employee ablation. Seller/caller ID memorization and employee scheduling effects cannot establish seller time preference.

Feedback schema `schemas/c2c/callFeedback.go:6,11-13` supports `Answered`/`NotAnswered`, `Incoming`/`Outgoing`, and start/end timestamps. Initiation writes `Initiated` (`singleLegCalling.go:69`), which remains nonterminal/unknown. Current call answer status/duration/disposition are post-call information and cannot predict that same call. Module can represent employee/empconnect/joboffer workflows (`clicktocall_helper.go:185-190`); require seller-directed identity and an inspected module cohort. Older `C2CAutoHotDialer` module evidence is in the dictionary; it does not equate general ERP to the new hotlead/bot sample.

## Feature and evaluation rules

- The first defensible baseline uses prospective candidate clock features (local hour, weekday and declared calendar terms), with timezone provenance. Source timestamps are naive; explicitly record the India `Asia/Kolkata` assumption unless actual storage timezone is verified. Exclude overseas/unknown scope or report it separately.
- Do not use current-call result, duration, recording, summary, meeting/appointment fields or final label components as features. Exclude current seller/employee snapshots unless independently known as of the decision. Raw GLID is an audit key, not a predictive input.
- With incomplete lifetime prehistory, call counts/recency are **bounded observed event history**, not lifetime history. Use only earlier unique event times within available coverage, preserve missing/truncation indicators, and explicitly declare any assumed ingest availability. A first observed seller in May is not a verified first-time customer. Seller-disjoint first-observed evaluation may train a separate limited-history artifact but must not be reported as true zero-prior-call validation.
- Prior answer/status and recorded-meeting-yield features need historical availability. Current mutable call status, `entered_on`, meeting result or verification date cannot reconstruct it. Exclude these features until a reliable predecision snapshot/audit/CDC/first-observation timestamp exists. Final-snapshot meeting positives are labels, never retroactively available historical features.
- Fix train/validation/test dates and seller exclusions before model selection. Embargo based on the full 14-day target window and disclosed observation grace. Fit preprocessing/calibration on development folds only and lock the test set. Report sparse-history and unseen seller support honestly.
- Zero under this observed-record target is trainable as an explicitly named observed-absence label, unlike an asserted canonical completion negative. Report matched-label coverage by answered/unanswered, module, seller/employee and date, with missing-link sensitivity and no-employee/no-history ablations. All-positive/all-zero or inadequate positive support must fail the classifier training gate.
- Model probabilities estimate the observed proxy under the sampled historical schedule. They are not canonical completion probabilities, guarantees, or causal effects. Do not claim the 15-minute rule was beaten without defensible policy evaluation. For deployment, keep scores in an explicit experimental/admin view; canonical model acceptance remains unresolved.

Required manifest fields: target/version, extraction time, query/hash, actual sample interval/grain, outgoing/module eligibility, timezone assumption, dedup/link/conflict counts, exclusions, distinct seller/attempt/meeting counts, class prevalence, nominal horizon/grace, final-snapshot revision limitation, feature availability assumptions, incomplete-prehistory definition, split dates and dataset checksum. Preserve a positive source-record audit sample locally with IDs only; no phone numbers, emails, tokens or raw recordings are necessary.

## Source paths

Unless a path starts with `mrp/`, references above are relative to `C:\Users\imart\Pictures\No work\Repository\merp-go\src\gin-api\app`; `mrp/` references are relative to the ERP repository root. Source inspection was read-only, used targeted business lines, and did not query the shared persistent Redash extraction while it was running. The physical-date/result/direct/reverse-link evidence remains sourced in [data-dictionary.md](./data-dictionary.md), especially `ApiDsrForm.php:166,933-959,1230-1234` and `getMeetingData.go:114-121,167-168`.
