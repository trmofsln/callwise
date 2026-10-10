# Research v4 — experiment plan (pre-registered)

Branch `research/calling-time-models-2026-10-10`, forked from `53ae52f` on 2026-10-10.
I wrote this plan after the feasibility probes listed under "Evidence used" and before I fitted any model or read any final-test outcome. Changes are logged at the bottom, with the date and the stage reached when each one was made.

## Question

Can a different model, model combination, or decision policy improve the calling-time recommendation compared with the current Callwise baseline? The question covers customers with no observed history, sparse observed history, and substantial observed history.

## Evidence used to shape this plan (bounded probes, source 13)

* **`redash.click_to_call` retention.** The view (`public.click_to_call_mw`) holds outbound calls only from **2026-08-11**.
  * Earlier dates return between 7 and 41 stray rows per day.
  * On 2026-08-12 there were 347k rows in total and about 324k eligible outbound calls, covering 218k sellers.
  * Any history window therefore starts on 2026-08-11. Call history before that date can't be reconstructed from this source.
* **Statement timeout.** The replica enforces a 5 s `statement_timeout`. Extraction is split into 30-minute blocks of call entries and per-date meeting chunks.
* **Meeting-to-call links.** Every sampled `sts_dsr_meeting` row in the dev week 2026-08-03..09 carries a positive `fk_sts_dsr_call_id`.
  * The forward-linked DSR call is usually the appointment record: it has an `sts_dsr_app_date` and was entered less than one day before the meeting.
  * About 35% of these DSR calls carry a UCID, which is the only join to a click-to-call row.
  * A reverse link (`sts_dsr_call.fk_sts_dsr_meeting_id`) with an empty forward link was not observed.
* **Meeting codes.** No lookup table for `sts_dsr_meeting_result`, `sts_dsr_meeting_mode` or `sts_dsr_meeting_verify_status` codes exists in source 13. The reference source tree named in the brief (`C:\Users\imart\Pictures\No work\Repository`) is not present on this machine.
  * Code semantics are therefore taken from the existing contract (mode 0 = physical; result 9 = excluded; video counts when verify status is 9). They remain unverified.
* **Canonical labels.** No canonical `meeting_done` label was found. The earlier audit (`label-audit.md`) reached the same conclusion.

## Targets

| Name | Role | Definition (per eligible call) |
|---|---|---|
| `observed_linked_physical_recorded_met_within14days` | **Primary.** Same task as the frozen general model. | Positive if some meeting meets all of these conditions:<br>• it was entered in `(call_start, call_start + 14 d]`;<br>• `mode = 0` and `result` is not null and ≠ 9;<br>• its forward-linked DSR call has this call's UCID;<br>• the DSR call's seller and the meeting's seller both equal the call's seller.<br>Each meeting is credited once, to the latest linked eligible call before the meeting's entry time. |
| `observed_linked_any_mode_met_within14days` | Secondary | Same as primary, but the meeting may also be `mode = 1` with `verify_status = 9`. This matches the app's `isSuccessfulMeeting`. |
| `answered` | Secondary | `status = 'answered'`. This outcome of the current call is used only as a label. |
| `answered_60s` | Secondary | `answered` and `call_duration ≥ 60`. This is a named "meaningful conversation" proxy, not a verified definition. |

These are **proxy** outcomes. None of them is a canonical completed meeting (`meeting_done`), and no result is reported as completed-meeting uplift. Meeting booked/fixed is **not measured**: a bulk extract of DSR appointment records exceeded the replica's statement timeout when joined to the seller sample (see the gap list in the report).

## Decision unit and eligibility

* **Unit.** One outbound click-to-call row, at its actual `call_start_time` (naive timestamps treated as Asia/Kolkata).
  * Filters: `flag_in_out = 'OUTGOING'`, `fk_glusr_usr_id > 0`, employee not null, status `answered` or `notanswered`, and `call_start_time` on the call's entry date.
  * These filters are identical to the frozen extraction.
* **Sampling.** Sellers are kept when `md5(seller_id)` (first 28 bits) mod 100 is below 8.
  * This is a cluster sample: all of a sampled seller's calls and meetings are kept, so as-of history is complete within the source window.
* **Deduplication.** Rows are deduplicated by call key. Duplicate UCIDs are reported. A meeting is never credited to more than one call.
* **Pseudonymization.** All identifiers are salted md5 values computed in SQL. No names, phone numbers, recordings or transcripts are extracted.

## Splits (chronological; decision date = call start date)

| Period | Dates (2026) | Use |
|---|---|---|
| Warm-up | Aug 11–17 | History features only. Not an example. |
| Train | Aug 18–24 (Tue–Mon) | Fitting. |
| Dev | Aug 25–31 (Tue–Mon) | Model selection, hyperparameters, calibration. |
| Embargo | Sep 1–13 | History features only. Lets train and dev labels mature before the test starts (Aug 31 + 14 d = Sep 14). |
| **Final test** | **Sep 14–25** (Mon–Fri ×2, Sat, Sun) | Read once, after freezing. Its two halves (Sep 14–19 and Sep 20–25) are reported for temporal stability. |

* **Excluded from the final test:** the 12,000 calls the frozen model's published test already used (Sep 21, 23, 25). They are matched by salted call key.
* **Label maturity.** Labels are observed up to the extraction time. Meetings are extracted through Oct 9, so every test call has a complete 14-day window.
* **Cold-start disjointness.** Test calls in the "no observed history" cohort come from sellers with no observed call since Aug 11. Those sellers have no training rows by construction.
* **Lead chains.** Lead chains can't be identified in the extract. This limitation is reported.
* **Split freezing.** Split membership and file hashes are written to a manifest before fitting.

## History cohorts (as of decision time, observed scope only)

* `no_observed_history`: no prior outbound call to the seller observed since 2026-08-11.
* `sparse_observed_history`: 1–9 prior observed calls.
* `substantial_observed_history`: 10 or more prior observed calls. This matches `minimumHistory` = 10.
* Verified first contact can't be established, because call retention starts on Aug 11. It is reported as unavailable.
* At train time the lookback is shorter (7–13 days) than at test time (34 days or more). Model features therefore use fixed windows of 7 days or less, plus meeting history (meetings are extracted from Jul 12). Cohort labels are reporting strata only.

## Features (strictly before `call_start_time`)

* **Clock:** hour, weekday, hour×weekday.
* **Context fields on the call row, set at dial time:** `module` (calling channel/team), `custtype_id`, `vertical_id`, `is_sts_assigned`, `flag_call_type`, `vendor`.
  * Mutability risk: these values come from the row's last modification. The row's `last_modified_date` lag is reported, and an ablation without these fields is required.
* **Seller history:**
  * calls in the last 24 h and last 7 d;
  * answered calls in the last 7 d;
  * answered at this hour in the last 7 d;
  * hours since the last call, and whether the last call was answered;
  * calls already made today;
  * physical and any-mode meetings entered in the last 30 d;
  * days since the last meeting.
  * Meetings count only when entered before `call_start_time`.
* **Excluded:** current status, duration, ring time, feedback and disposition; any later meeting; raw IDs (seller, employee, company); `last_modified_date`.

## Candidate families and bounded tuning

| Id | Family | Tuning (on dev only) |
|---|---|---|
| F0 | **Frozen** `general_erp` hour_day + Platt, scored exactly as the app does it (pooled-hour backoff). Also the Python global-prior variant. | none |
| B0 | Population rate (constant) | none |
| B1 | hour_day smoothing, retrained on the new train data (same code as the frozen model) | strength ∈ {5, 20, 80} |
| B2 | Personal-history heuristic (smoothed seller answer rate at this hour, backed off to B1) | prior strength ∈ {2, 5, 10} |
| H1 | Partial pooling / empirical-Bayes hierarchy: weekday×hour → module group×hour → seller (beta-binomial shrinkage) | strengths from a grid of ≤ 9 |
| L1 | L2-regularized logistic regression: clock → +context → +history (ablation ladder) | C ∈ {0.01, 0.1, 1} |
| G1 | LightGBM, same feature sets | ≤ 12 configurations, early stopping on dev |
| T1 | Two-stage: P(answered) × P(meeting \| answered), then recalibrated on dev | only if components beat L1 on dev |

* **Calibration.** Platt scaling is fitted on dev for the selected model.
* **Excluded with reasons in the report:**
  * survival/hazard models for retry timing (sequence identity and censoring are not verified);
  * contextual bandits and uplift models (no randomized or propensity-logged actions);
  * customer embeddings.

## Metrics and uncertainty

* **Per cohort:** n, positives, prevalence, AP, ROC AUC (null when positives = 0), log loss, Brier, reliability (10 quantile bins).
* **Budget metrics:** yield, recall and calls per proxy event at the top 10/20/30% of calls.
* **Within-seller hour concordance.** Over test sellers with at least one positive and at least one negative call at different hours, this is the share of pairs in which the positive call's hour scores higher. This is the metric most relevant to *when* to call, because a seller-level main effect cannot change which window wins for that seller.
* **Paired comparisons.** Differences between a candidate and a comparator use a seller-cluster bootstrap (1,000 replicates, seed 20261010), with 95% percentile intervals.
* **Temporal stability.** Each test half is reported separately.
* **Association, not causation.** All findings are associational. Historical logs show only the outcome of the time that was actually called.

## Comparisons

1. **Frozen model and policy against candidates.** Same eligible test calls, primary target.
2. **Same-data comparison.** B1, retrained on the new train data, against H1/L1/G1/T1 trained on that same data. This separates the effect of new data from the effect of the model family.

## Selection and promotion rules (fixed now)

* **Selection on dev.** The best dev log loss among candidates is selected, provided AP is not lower than B1's by more than 5% relative. Ties are broken by simplicity: B < H < L < G < T.
* **Convincingly improved over B1 on the final test,** primary target. All of the following must hold:
  1. AP gain ≥ 10% relative, with the 95% cluster CI of the AP difference above 0;
  2. log-loss difference CI upper bound ≤ 0;
  3. same direction in both test halves;
  4. not worse (point estimate) in any cohort with ≥ 30 positives;
  5. within-seller hour concordance not lower than B1's by more than 0.02;
  6. JS inference stays below 1 ms per window, and the artifact is at most 2 MB.
* **Other verdicts:**
  * **Promising:** point gains, but a confidence interval or a stability criterion fails.
  * **Worse:** AP-difference CI entirely below 0, or log-loss CI entirely above 0.
  * **Inconclusive:** anything else.
* **Scope of any positive result.** A favourable result can only support a prospective randomized pilot. It does not support a switch of the live default.

## Change log

* 2026-10-10, before fitting and before reading test outcomes: initial version.
* 2026-10-10, still before fitting and before any test outcome was read: added an **exploratory** policy-agreement analysis.
  * Method: business hours 10–17 are rescored per call, with clock and same-hour features recomputed. The proxy rate for calls placed in a model's top 4 hours is then compared with the rate for calls placed in other hours, using a seller-cluster bootstrap (300 replicates).
  * It is associational only and is not a promotion criterion.
  * The per-hour seller history columns `calls_h{10..17}_7d` and `answered_h{10..17}_7d` were added to the dataset to support it.
* 2026-10-10, after the dev results for the first candidates were in and **before any test outcome was read**: added the population `channel`.
  * What triggered it: in the train and dev splits, 92% of proxy positives come from the calling module `CSDMERP` (train rate 5.6%) and a further 3% from `MERP` (3.3%). The NSD and TELE modules, about 75% of calls, have close to zero UCID-attributed meetings.
  * A model that knows the module therefore gains enormously on pooled metrics (dev AP ≈ 0.045 vs ≈ 0.006 for clock-only models). That gain identifies the channel. It says nothing about the best time to call.
  * Changes made:
    1. The registered `all` population is still evaluated and reported as registered. Any gain it shows from context features is reported as a **channel-mix effect**, not a timing gain.
    2. The new population `channel` covers calls whose module had a train-split proxy rate of at least 1% (`CSDMERP`, `MERP`). This rule uses the train split only.
       * The same candidate families, tuning grids, selection rule, dev-fitted calibration and promotion criteria are applied, with every split restricted to this population.
       * The frozen F0 model is scored on the same calls.
    3. The decision about timing quality rests on the `channel` population results together with within-seller hour concordance. The `channel` final test is also read once.
