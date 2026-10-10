# Research v4: decision report (calling-time models)

> **Update 2026-10-10: user decision to replace the live model.** After reviewing this report, the user chose to replace the live general fallback. The retrained v4 hour/day table is installed; see section 8. The analysis below is unchanged.

**Recommendation: keep the current baseline for choosing call times.** No candidate improves the *timing* of calls. The large gains on pooled metrics come from the calling channel and from seller history. A randomized pilot is the only way to establish timing uplift (see the last section).

- **Branch:** `research/calling-time-models-2026-10-10`, started from `53ae52f`. The pipeline code was committed as `1e67ab9`; the models were frozen at that revision.
- **Code and data:** nothing was merged or deployed, and the app's default route, model and scheduling are unchanged.
- **Label kind:** every result is for a **proxy** label. None of them measures canonical `meeting_done`.

## 1. What the current baseline actually does (verified)

- **Personal-history ranking.** It is used when the seller has at least 2 calls that led to a meeting, or at least 3 answered calls with at least 2 answered in one hour.
  - Score = linked×1e6 + answered×1e3, multiplied by (1 − 0.75 × short-call share), where a short call is shorter than 20 s.
  - A weekday's own slot is used when that weekday is supported (≥ 2 converted calls or ≥ 3 answered); otherwise the pooled hour is used.
- **Fallback order** when personal history is inconclusive:
  1. Canonical models. The `history_aware` and `cold_start` artifacts do **not exist**, so this step never runs.
  2. The general proxy model, `.data/btc-operational-v3/models/general_erp`. It is a smoothed weekday×hour table (strength 20) with validation-fitted Platt scaling. It was trained on 15,284 calls with 53 positives, sampled only from Aug 12, 14, 16 and 18 (Tue, Wed, Fri, Sun).
     - Monday, Thursday and Saturday slots are always scored through the app's pooled-hour backoff.
     - Hours with fewer than 5 pooled rows are dropped: 63 of the 168 week-hours, all at night.
  3. Operating hours.
- **Other rules:** preferred-day ordering, candidate eligibility (10:00–18:00 Mon–Sat, cooldown, daily and sequence caps, do-not-call, appointments) and conditional retry behave as described in `architecture.md`.
- **Route labels vs engine.** The `generalized` route label means the proxy table above. The `fallback` route label means operating-hours order; no cohort model is involved.
- **Cold-start experiment.** Its test split had 0 positives, it was never usable, and the request path does not load it.
- **Artifact checks:**
  - The general model loads, and its SHA-256 equals its freeze record.
  - JS scoring matches a Python re-implementation to 1.7e-18 (`scripts/btc-research-parity.cjs`).

## 2. Data discoveries that changed the question

1. **Click-to-call history starts on 2026-08-11.** Earlier dates hold 7–41 stray rows per day. History windows, cohorts and the definition of "first contact" are bounded by this date, so **verified first contact cannot be established**.
2. **The replica enforces a 5 s statement timeout.** Extraction was therefore split into about 2,300 small chunks.
3. **The proxy label exists almost only in two calling channels.**
   - On train and dev, module `CSDMERP` produces 92% of the attributed meetings (5.6% of its calls). `MERP` adds 3% (3.3%).
   - The NSD and TELE modules, about 75% of calls, have close to zero.
   - The cause is that a meeting is attributed only when its appointment record carries the call's UCID. Roughly 65% of appointment records carry no UCID.
4. **No canonical completed-meeting label was found.**
   - Meeting result codes (1, 2, 4, 5, 9, 19–25) have no lookup table in any accessible source, and the reference repository is not on this machine.
   - A candidate *validated meeting* source exists: `sts_dsr_sales` / `unified_tp_mart` approval scores and `emp_meeting_payout.valid_meets` in source 55. It has no call link, and the session's data-handling permission blocked aggregate inspection.
5. **Query access.** Sources 4, 8, 10 and 11 return HTTP 403. Sources 13, 21, 55 and 70 are queryable.

Details are in `sources-and-feasibility.md`.

## 3. Dataset v4

| | Train (Aug 18–24) | Dev (Aug 25–31) | **Final test (Sep 14–25, fresh)** |
|---|---:|---:|---:|
| Eligible calls (8% seller cluster sample) | 150,875 | 165,323 | 269,060 |
| Sellers | 65,977 | 68,262 | 95,816 |
| Proxy positives `y_physical` | 723 | 628 | 1,332 |
| Channel population (CSDMERP, MERP): calls / positives | 12,460 / 678 | 14,361 / 610 | 22,708 / 1,264 |

How the dataset was built:

- **Embargo.** Aug 31 + 14 days falls before the test begins on Sep 14.
- **Fresh test set.** The 1,000 sampled calls the earlier model's published test had already used were removed from the test.
- **Pseudonymization.** All identifiers are salted md5 values computed in SQL.
- **As-of features.** Features use only events that both started and were recorded before the call. A test asserts strict prior history.
- **Attribution.** A meeting is credited to the call whose UCID is on the meeting's forward-linked DSR record, within 14 days of the call, with the seller matching. Each meeting is credited once.
- **Missing fields.** `custtype_id` and `vertical_id` were 100% null, so they contribute nothing.

## 4. Results on the sealed final test

The test was read once. Intervals are 95% seller-cluster bootstraps with 1,000 replicates.

### A. All eligible calls (pre-registered population; prevalence 0.50%)

| Model | AP | ROC AUC | Log loss | Yield at top 20% |
|---|---:|---:|---:|---:|
| F0 frozen general model (app scoring) | 0.0080 | 0.652 | 0.0309 | 0.0090 |
| B1 hour_day retrained on v4 train | 0.0085 | 0.675 | 0.0304 | 0.0091 |
| Clock-only logistic / LightGBM | 0.0085 | 0.676 / 0.679 | 0.0304 / 0.0303 | 0.0091 |
| +history only (LightGBM) | 0.0516 | 0.898 | 0.0246 | 0.0208 |
| +context (module) only (LightGBM) | 0.0680 | 0.962 | 0.0199 | 0.0245 |
| **Selected: LightGBM, all features** | **0.0932** | 0.969 | 0.0193 | 0.0246 |

- **New data.** B1 retrained vs F0: AP +0.00055 (+6.9%, CI [+0.00012, +0.00093]); log loss −0.0005. The gain is real but below the 10% materiality bar.
- **Modelling of the clock.** Clock-only logistic vs B1: AP −0.00006 (CI [−0.00015, +0.00003]). No gain.
- **Context and history.** The selected model vs B1: AP +0.085 (CI [+0.078, +0.093]). This gain comes from the module (channel) and from seller history, not from time of day.

### B. Channel population: calls that can produce the proxy (prevalence 5.6%)

| Model | AP | ROC AUC | Log loss | Within-seller hour concordance |
|---|---:|---:|---:|---:|
| F0 frozen | 0.0641 | 0.562 | 0.312 (miscalibrated for this population) | 0.606 |
| B1 hour_day retrained | 0.0605 | 0.543 | 0.216 | 0.574 |
| Clock-only LightGBM | 0.0618 | 0.553 | 0.215 | 0.594 |
| Personal-answer heuristic (B2) | 0.0684 | 0.582 | 0.215 | **0.537** |
| +history LightGBM | 0.0904 | 0.651 | 0.208 | 0.590 |
| **Selected: two-stage answer×conversion** | **0.0923** | 0.669 | 0.206 | 0.598 |

- **Time of day carries almost no signal here** (AUC 0.54–0.56).
- **Pickup.** In this population, the clock alone does not predict pickup either: on the secondary target `answered`, B1 has AUC 0.50.
- **Seller history.** History raises call-level AP by 52% over B1 (CI [+0.026, +0.039]). The effect is stable in both test halves and in every history cohort.

**Pre-registered rule vs timing evidence.** Under the pre-registered criteria, the selected models in A and B are labelled `convincingly_improved` for **call-level proxy prediction**. That criterion does not measure timing. As recorded in the plan before the test was opened, the timing decision rests on within-seller concordance:

- **Within-seller hour concordance (exploratory, after the lock).** This asks: for the same seller, does the model rank the hour of a call that produced a meeting above the hour of a call that did not?
  - **No candidate beats the frozen model:** selected −0.008 (CI [−0.051, +0.031]); LightGBM full −0.006 (CI [−0.046, +0.031]).
  - The **personal-answer heuristic is worse than F0:** −0.069 (CI [−0.109, −0.030]).
- **Policy agreement (exploratory, associational).** Calls placed in a model's top 4 business hours have a higher proxy rate than calls placed in other hours, for every model. The differences between models overlap:

  | Model | Rate difference (top 4 vs other hours) | 95% CI |
  |---|---:|---|
  | F0 | +0.020 | [0.012, 0.026] |
  | B1 | +0.024 | [0.017, 0.029] |
  | Selected | +0.021 | [0.014, 0.027] |

### Cohorts (channel population, AP)

| Cohort | Calls / positives | F0 | B1 | Selected |
|---|---|---:|---:|---:|
| No observed history | 619 / 69 | 0.104 | 0.129 | 0.157 |
| Sparse history | 8,317 / 627 | 0.090 | 0.083 | 0.101 |
| Substantial history | 13,772 / 568 | 0.046 | 0.043 | 0.068 |

The "no observed history" cohort means no call observed since Aug 11, which is not the same as verified first contact.

### Calibration and cost

- **Calibration in the channel population.**
  - F0's probabilities (0.1–0.7%) sit far below the observed 4–7%. Its displayed `proxy_estimate` should not be read as a probability for these calls.
  - The dev-fitted Platt calibrators of B1 and the selected model track observed rates within about 3 percentage points per decile. Details are in `results.json` under `reliability`.
- **Operational cost.**

  | Model | Fit time | Python inference | Size |
  |---|---|---|---|
  | hour_day | < 0.1 s | ~0.6 µs/row | ~2 KB |
  | Selected LightGBM / two-stage | 0.5–4 s | 2–7 µs/row | 200–420 KB |

  There is no JS runtime for tree models. They would need either a JS tree evaluator or a Python sidecar.

## 5. Why the pooled metrics improve

| Source of gain | Evidence | Status |
|---|---|---|
| New data (10× rows, all weekdays) | B1 vs F0 on all calls: +6.9% AP | Measured. Small. In the channel population B1 is not better than F0. |
| Better clock modelling (logistic, LightGBM, partial pooling) | Clock-only vs B1 ≈ 0 | Measured. **No gain.** |
| Channel / module | Context-only LightGBM AP 0.068 vs 0.0085 | Measured. This is a **label-attribution / channel-mix effect, not timing**. |
| Seller recent history (answer rate, recency, prior meetings) | +49% to +52% AP within the channel population | Measured. It predicts **which calls** produce meetings ("whom/whether"). It does not change **when** to call (concordance not improved). |
| Personalised timing from answer history | B2 within-seller concordance lower than F0 | Exploratory. Suggests the app's answer-history ranking may not help meeting timing. |

All of this is associational. The logs show the outcome only for the time that was actually called.

## 6. Recommendation

1. **Keep the frozen general model and the current timing policy.** Do not replace them with any v4 candidate for time-window ranking.
2. **Do not retrain hour_day on v4 data for deployment yet.** The +6.9% AP on all calls is below the materiality bar, and within the channel population the retrained model is not better.
3. **Investigate further, as separate decisions:**
   - **Label.** Confirm with the ERP owners:
     - what the `sts_dsr_meeting_result` and `verify_status` codes mean;
     - whether `sts_dsr_sales` / `unified_tp_mart` approval or `emp_meeting_payout.valid_meets` defines a validated completed meeting.
     
     Approve inspection of those marts.
   - **Population.** Decide whether Callwise serves only meeting-booking channels (CSDMERP/MERP). Outside them, the meeting proxy is undefined, so any meeting-based recommendation there is empty.
   - **Prioritisation, not timing.** The history-feature model could rank *which* sellers to call today. That is a different product decision, and it would need its own evaluation and fairness review.
   - **Personal-answer ranking.** Re-examine its use for meeting outcomes, given the exploratory negative concordance.
4. **Proposed prospective pilot (not run).**
   - **Design.** Within CSDMERP/MERP, randomize each eligible seller-day between the frozen-model top window and a uniformly random allowed window, with logged propensities.
   - **Unchanged.** Calling caps, cooldown, do-not-call and appointment rules stay as they are.
   - **Primary outcome.** Validated completed meeting within 14 days, once the label is confirmed. Answer rate and calls per meeting are secondary.
   - **Size.** At a 5.6% base rate, detecting a 10% relative uplift (5.6% → 6.2%) at α = 0.05 with 80% power needs about 28k calls per arm before the seller-clustering design effect, and more once that effect is included. Agree the target effect size before starting, because a smaller pilot is inconclusive by design.
   - **Safeguards.** Daily guardrail monitoring on answer rate and complaints, and a kill switch.

No integration plan is proposed, because replacement is not recommended.

## 7. Limitations

- Proxy labels only. Result-code semantics are unverified, and UCID-less appointment records cause the proxy to miss meetings.
- The data cover about 6 weeks, in one season. Sep 1 recorded only 61 meetings source-wide, against about 6.9k on Sep 2. That day falls inside the 14-day label window of the train and dev calls.
- The 8% seller cluster sample adds sampling variance. The intervals are seller-cluster bootstraps.
- The `channel` population and the timing analyses were added after the dev results and before the test. The concordance intervals are post-lock and exploratory.
- Context fields come from the call row's final state. The modification lag is median 0.01 h and p99 0.3 h, so the risk is low but not zero.

## 8. Live replacement (user decision, 2026-10-10)

**What changed**
- The app's default experiment directory is now `models/live` (`DEFAULT_EXPERIMENT_DIRECTORY`). Before, it was `.data/btc-operational-v3`.
- The general proxy fallback is `erp-outbound-observed-proxy-v4-b1-hour-day-s80-…`. It is the same family and app schema as before, retrained on 150,875 calls and 723 proxy positives covering all weekdays, with Platt calibration fitted on dev. It is built by `python -m ml.research.install_live` from the frozen bundle and the sealed-test results.
- The personal-history ranking, eligibility, caps and retry logic are unchanged. The canonical models are still absent, and `deployment.approved` stays `false` because the label is a proxy.

**Why this candidate.** It is the only measured improvement in the app's existing schema:
- all-calls test AP 0.00853 vs 0.00797 (+6.9%, CI [+0.00012, +0.00093]), with lower log loss;
- every weekday is covered, so Mon, Thu and Sat no longer depend on pooled-hour backoff;
- JS/Python parity is within 2.2e-18.

The history and channel models need a JS tree runtime and the caller's channel at request time, and they showed no timing gain.

**Known downsides (accepted by the user)**
- There is no measured improvement in within-seller timing: −0.012 vs v3, CI [−0.039, +0.020].
- Within CSDMERP/MERP, the retrained table's AP is slightly below v3's: −0.0036, CI [−0.0071, −0.0001].

**Validation run**
- `npm run typecheck` and `npm run lint` pass. `npm run build` passes after adding the Linux native binaries for lightningcss and tailwind oxide, installed with `--no-save`; the lockfile is unchanged.
- `npm test`: 51/52 pass when `python` resolves to the venv. The remaining failure is pre-existing: `tests/ml_data_checks.py` fails to import. Without that shim, 50/52 pass.
- The new regression test checks that the live default loads v4 and that the rollback override loads v3.
- `/api/predictions/health` reports `generalized_ranking_ready: true`.

**Rollback**
- Set `BTC_EXPERIMENT_DIRECTORY=.data/btc-operational-v3` and restart. The v3 artifacts are untouched.
- Alternatively, revert the commit that sets `DEFAULT_EXPERIMENT_DIRECTORY`.

**Monitoring to add before relying on it**
- Daily share of recommendations served by `generalized_model` vs personal history vs operating hours.
- Proxy linked-meeting rate per 100 recommended calls, split by CSDMERP/MERP and other channels, compared with the pre-switch weeks.
- Answer rate and calls per proxy meeting.
- Alert if the generalized model fails to load (the `issue` string). If it does, the app falls back to operating hours.

**Artifact availability.** The live artifacts (aggregate hour/day tables and evaluation summaries, no seller records) are committed under `models/live` so hosted deployments ship them. Other environments must run the v4 pipeline (`research-v4/reproduce.md`), or copy `.data/btc-research-v4/live`. Until one of those is done, they fall back to operating hours.
