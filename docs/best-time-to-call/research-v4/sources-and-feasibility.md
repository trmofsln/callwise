# Research v4: source inventory and feature feasibility

**Verification scope.** Everything here was verified on 2026-10-10 with bounded, read-only Redash queries. The queries ran through a dedicated research query id, `hackathon-btc-research-2026-10-10`. The interactive adhoc, user and training query ids were not read or modified.

**Audit log.** Each statement is recorded with its SQL hash, source, row count and duration in the ignored file `.data/btc-research-v4/query-audit.jsonl`. The pseudonymization salt is redacted in that log.

**Reference code.** The reference source tree named in the brief, `C:\Users\imart\Pictures\No work\Repository`, is not on this Linux machine. Business rules therefore could not be traced to reference-code symbols. Where this document gives a business meaning, it comes from:
- the existing project contract (`label-audit.md`, `data-dictionary.md`, `lib/user-activity.ts`), or
- the database itself.

Each such meaning is labelled with its origin.

## Source access (verified)

| Redash source | Engine | Query access | Notes |
|---|---|---|---|
| 13 `pg-main-prod-live` | PostgreSQL 15.13 (read replica: `pg_is_in_recovery() = true`) | **yes** | User `redash_usr`. `statement_timeout = 5s`. The `redash.*` objects are views over `public.*_mw` / `*_mvv` tables. |
| 21 | PostgreSQL (mesh) | yes | Not used. Its contact-preference semantics are unverified (see `label-audit.md`). |
| 55 | ClickHouse 26.1 (BI marts) | yes | Reporting marts (`bi_reporting_mart_read.*`). See "Label leads not pursued". |
| 70 | ClickHouse (call insights / PNS) | yes | Buyer enquiry calls, which are a different population from ERP outbound calls. Not used. |
| 4, 8, 10, 11 | Redshift and others | **no** (HTTP 403: "You do not have permission to run queries with this data source.") | Their schemas are visible, but queries are not permitted. |

## Tables used and inspected (source 13)

| Table (view → base) | Grain / size | Key columns | Event time | Coverage / notes |
|---|---|---|---|---|
| `redash.click_to_call` → `public.click_to_call_mw` | One dial attempt | `click_to_call_id`, `ucid`, `fk_glusr_usr_id`, `fk_employeeid`, `fk_sts_companyid` | `call_start_time` (dial), `entered_on` (row insert) | **Retention from 2026-08-11.** Aug 1–10 have 7–41 stray rows per day. 2026-08-12: 347,428 rows, 327,624 outgoing, 324,006 eligible, 218,053 sellers, 6,369 employees. Statuses are only answered/notanswered. 28 module values. |
| `redash.sts_dsr_call` → `public.sts_dsr_call_mvv` | Employee-logged call / appointment record (~100M rows, 112 GB) | `sts_dsr_call_id`, `ucid`, `fk_sts_company_id`, `fk_sts_dsr_meeting_id` | `sts_dsr_call_entrydate` | 2026-08-12: 194,632 rows, 96,845 with a UCID. Indexed on `ucid`, id, `date(entrydate)`, company. |
| `redash.sts_dsr_meeting` → `public.sts_dsr_meeting` | Meeting record (4.6M rows) | `sts_dsr_meeting_id`, `fk_sts_dsr_call_id`, `fk_sts_company_id` | `sts_dsr_meeting_entrydate` (recorded), `sts_dsr_meeting_date` (meeting date) | About 45k rows per week (week of Aug 3–9). In that week every row has `fk_sts_dsr_call_id > 0`. The median of entry minus meeting date is about 16 h, consistent with a date-only meeting date. |
| `redash.sts_company` → `public.sts_company_mw` | Company ↔ seller map (53M rows, 89 GB) | `companyid`, `sts_fk_glusr_id` | `creationdate` | Joined per row through its primary key. Hash-filtering on it requires a full scan, which is infeasible under the 5 s timeout. |
| `redash.pre_click_to_call` | Pre-dial log (17M rows) | `ucid` | `entered_on` (not indexed) | A one-day count timed out. **Infeasible.** |
| `redash.hot_leads_assign`, `hot_leads_types`, `data_hotlead_disposition_dtl` | Lead assignment / lead rows | lead id, glusr | assignment and outcome dates | Lead-level dates are not call-level labels (see `label-audit.md`). Not used. |
| `redash.meeting_trust_score`, `nsd_sales_welcome_meeting`, `sts_dsr_sales` | Field-sales visit (`sts_dsr_sales`) grain | `fk_sts_dsr_sales_id`, glusr | entry dates | These form a separate visit system with no call link. See "Label leads not pursued". |
| `redash.iil_dispositions_master`, `meeting_purpose` | Lookups | — | — | Lead dispositions and meeting-purpose names exist. **No lookup exists for `sts_dsr_meeting_result`, `sts_dsr_meeting_mode` or `verify_status` codes.** |

## How a call links to a meeting (verified on the 2026-08-05 sample)

- A meeting's forward-linked DSR call (`fk_sts_dsr_call_id`) is almost always an appointment record:
  - it has an `sts_dsr_app_date`;
  - it was entered less than 1 day before the meeting;
  - its `sts_dsr_call_purpose` is 58, 59 or 60 (physical) or 30 or 6 (video).
- About 35% of those DSR records carry a UCID. The UCID is the only join to a click-to-call row.
- The reverse link (`sts_dsr_call.fk_sts_dsr_meeting_id`) agrees with the forward link in more than 97% of sampled meetings. No meeting with an empty forward link was observed.
- **Attribution is therefore "the outbound call whose UCID the appointment record carries".** Meetings booked through calls without a UCID cannot be attributed. Such calls appear as negatives, and this is a known source of label noise. In the dev week roughly 65% of appointment records had no UCID.

## Label leads not pursued (open questions for the business)

- **Meeting result codes.** `sts_dsr_meeting_result` takes the codes 1, 2, 4, 5, 9 and 19–25. `verify_status` takes 0, 1, 2 and 9.
  - The existing contract treats result 9 as "not met" and verify 9 as "verified video". Neither reading is confirmed by a lookup table or by reference code.
  - Rows with result 25 or 20, for example, are common (2,554 and 1,709 physical rows in the dev week). If those codes mean "rescheduled" or "cancelled", the proxy over-counts.
- **`sts_dsr_sales` / `bi_reporting_mart_read.unified_tp_mart`** (source 55). These are visit records with `approved_score`, `manager_review` and trust-score inputs. Separately, `emp_meeting_payout` holds `valid_meets` and `payout_eligible_meets` per employee per day. Together they suggest an organisation-level notion of a **validated** meeting.
  - They carry no call link, so attribution would have to be a seller-and-time window.
  - Aggregate inspection of these marts was stopped by this session's data-handling permission policy before any result returned.
  - They are the most promising route to a canonical "meeting done" label, but they need business confirmation and explicit approval to inspect.
- **Meeting booked / fixed per call.** This can come from DSR appointment records (`sts_dsr_app_date`), which are linked by UCID. Joining them in bulk to the seller sample timed out at 1/8 partitions, so this outcome is not in dataset v4.

## Feature feasibility matrix

| Feature | Source / column | Event time ≤ decision? | Availability verified? | Mutability / leakage risk | Used in v4 |
|---|---|---|---|---|---|
| hour, weekday | `click_to_call.call_start_time` | yes | yes (the dial time itself) | none | **yes** |
| module (calling channel/team) | `click_to_call.module` | set when the row is inserted | partially | Low. The row's `last_modified_date` lag is reported in the manifest. | yes (with ablation) |
| custtype_id, vertical_id, is_sts_assigned, flag_call_type, vendor | `click_to_call` row | row values | **no** (could be rewritten when the row is modified) | Medium. These may reflect the post-call row state. | yes, in `*_context` sets only, with ablation |
| prior calls (24 h / 7 d / same hour), prior answered, last answered, hours since last call, calls today | earlier `click_to_call` rows of the same seller | yes (strictly earlier start; outcome only once the earlier call has ended) | yes, within retention | History before 2026-08-11 is unavailable. Windows are capped at 7 d so every decision from Aug 18 has a full window. | **yes** |
| prior meetings (30 d), days since meeting | `sts_dsr_meeting.entrydate` < decision | yes (entry time, not meeting date) | yes (entry is the recording time) | Late entries only reduce the counts. They cannot leak. | **yes** |
| account age, city, state, industry, segment | `sts_company`, `glusr_usr` | snapshot only | **no** history | Present-day values could leak later changes. | **no** |
| employee / team performance | `click_to_call` (sample only) | — | — | An 8% seller sample gives biased, noisy employee rates. Raw ids are not transferable. | **no** |
| contact preferences / DNC | `hot_leads_assign.do_not_call_mark_date`, `iil_pns_setting` | mark date | semantics unverified | These are policy constraints, not predictors. They remain in the app's eligibility rules. | no (policy only) |
| prehistory before 2026-08-11 | `sts_dsr_call` (long history) | yes | — | Pulling it in bulk for the sample exceeds the timeout. Retrieving it per seller would require raw identifiers. | **no** |
| verified first contact | — | — | **cannot be established** | Call retention starts on Aug 11. | no |
