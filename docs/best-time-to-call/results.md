# Measured results and limits

Two actual offline models were trained on a read-only Redash extraction. The app, production build, responsive dashboard, authenticated model report, portable inference, and live GPT-6 Luna tool review are working. **These are experimental operational-proxy models; no canonical meeting_done model or causal completed-meeting lift is claimed.**

The user's primary objective remains completed meetings attributable to calls, overriding PS03's meeting_fixed priority. The explicit fitted endpoint is **observed_linked_physical_recorded_met_within14days**, stored separately from canonical meeting_done:null.

## Actual dataset and validation

Source 13 / pg-main-prod-live, persistent extraction query 47566, 786 bounded checkpoints. 39,284 deduplicated calls, 36,447 sellers, 130 positives. Calls were selected by deterministic hash order on 10 preregistered dates, uniformly capped at 4,000 per date without outcome balancing. Sunday 16 August exhausted at 3,284. V3 uniformly expanded the same V2 dates before model fitting; original V1/V2 evidence remains intact.

| Cohort | Train calls / proxy events | Validation | Locked final test |
| --- | ---: | ---: | ---: |
| General ERP time-only | 15284 / 53 | 12000 / 34 | 12000 / 43 |
| First contact in observed scope | 6242 / 17 | 2334 / 3 | 1364 / 0 |

Dates: train 12/14/16/18 August; validation 2/4/6 September; final test 21/23/25 September 2026. Labels mature 14 days after actual call start before the next split. Cold membership is seller-disjoint. Both pipelines were frozen before either final test was scored, then evaluated once under atomic locks. Dataset SHA-256: **b54c79c89d43853ea97db086174968c6de3ba0bfc1980f2009293c55389ef72d**; observation cutoff: **2026-10-09T22:48:35.713000+00:00**.

## Actual held-out predictive results

| Cohort | Model | Calls | Proxy events | AUPRC | ROC AUC | Log loss | Brier |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| General ERP · time only | Selected | 12000 | 43 | 0.00520889 | 0.643186 | 0.0230958 | 0.00356707 |
| General ERP · time only | Hour/day | 12000 | 43 | 0.00520889 | 0.643186 | 0.0232381 | 0.00357130 |
| First contact · observed scope | Selected | 1364 | 0 | Unavailable | Unavailable | 0.00288984 | 0.00000842175 |
| First contact · observed scope | Hour/day | 1364 | 0 | Unavailable | Unavailable | 0.00373492 | 0.0000255213 |

General ERP · time only: selected **hour_day**; validation-fitted Platt calibration. Predictive acceptance: **met for this proxy endpoint**. AUPRC 95% seller-cluster interval: 0.00338068–0.00749639.

First contact · observed scope: selected **logistic_metadata_False_l2_0.005**; uncalibrated due insufficient validation-positive support. Predictive acceptance: **unmet**. AUPRC 95% seller-cluster interval: undefined.

The first-contact final test contains zero observed positive records: PR/ROC discrimination cannot be established. Its finite log loss/Brier describe negative-only predictions, not successful detection of completed meetings. No headline accuracy is used. Rare-event acceptance was tightened **before fitting** to tolerances of 5% of the baseline, with floors of 0.0001 for Brier and 0.001 for log loss; the saved acceptance contracts contain exact thresholds. Raw selected-model metrics, calibration diagnostics, support by weekday, baselines, secondary diagnostics, uncertainty and model cards are in [operational-results.json](operational-results.json).

Only prospective local hour and weekday enter model features. Current seller metadata, employee IDs, call status/duration, prior outcomes and mutable counters are excluded. Train lacks Monday observations; final test includes Monday. The unchanged scientific preview suppresses unseen/sparse weekday slots; the live advisory fallback pools training evidence by hour for these weekdays and does not claim calibrated probabilities for this extension. Observational employee schedules and the general ERP population do not establish transfer to hotlead campaigns or causal benefits from rescheduling calls.

The general winner is the strong smoothed hour/day baseline, followed by validation-fitted calibration. Calibration preserves its ranking and retrospective top-20% budget yield: there is no measured ranking/yield improvement over the raw baseline. Its log loss improves slightly. This is a measured predictive association with an operational recording proxy, not completed-meeting policy lift.

## Target and coverage limits

A positive means a seller-consistent linked physical DSR record with non-null result other than 9, inserted between actual call start and 14 days later. Direct/reverse keys are checked; contradictory reverse links are rejected. A negative means **no observed qualifying linked recorded-met record in the current replica**, not a confirmed completed-meeting failure. Entry time is an insertion clock; declared physical-meeting dates and later verification are not proven event/availability times. Multiple snapshot batches and later edits/retention/linkage gaps remain limitations.

The observed first-contact scope searches all exposed current-replica qualifying prior calls since 1 May, including unsampled records. It does not prove lifetime absence or complete real-world history. Ambiguous same-time first rows were quarantined in locked membership before training. Naive ERP timestamps assume Asia/Kolkata. Synthetic lead_id values group sellers; real lead/retry-chain identity is unavailable. General temporal evaluation permits repeated sellers, while first-contact evaluation remains seller-disjoint. Canonical meeting_done and meeting_fixed remain unknown; provider-reported Answered is only a secondary operational diagnostic.

The original hotlead pilot remains a separate 4,978-attempt / 4,706-seller dataset with 0 canonical labels and 0 linked meeting proxies. Its strict canonical trainers still refuse that data; see [initial checkpoint](results-initial-audit.md) and [label audit](label-audit.md). Accessible schema catalogs still lack the canonical labels; sources 8/10 expose schemas but deny queries.

## Application and live provider evidence

The Callwise dashboard brings calling plans ahead of profile details, displays one overall ranking of up to four day-and-time choices, personal meeting/answer evidence and short-call penalties, independent conditional retry timing, constraints and evidence, preserves activity/Global Context/JSON exports, and works at desktop and 390-pixel mobile widths. Admin displays authenticated aggregate model results and frozen proxy-clock inference; it exposes no raw seller records or saved keys. SQLite retains existing credentials and stores predictions/model/experiment metadata. Canonical API probabilities remain null until approved, calibrated canonical artifacts are available. Both proxy artifacts remain deployment_approved:false.

Live Luna model: **openai/gpt-6-luna**. The previous key authenticated but had exceeded its monthly limit; the user's reference key successfully called the exact model and was saved locally without exposing it. Latest actual grounded tool review: **reviewed**, 3 tools, 6096 ms, 3284 input / 217 output tokens, cost US$0.00046465; independent programmatic errors: 0. This smoke uses an artificial non-sensitive context; it is provider/contract evidence, not scientific prediction accuracy. Separate 14-case synthetic mocked routing checks have zero constraint violations and 14/14 grounded outputs.

Automated tests, lint, types, production build and final HTTP/browser results are recorded in [checklist](checklist.md) and [aggregate evidence](evidence-summary.json). Reproduce from [commands](reproduce.md). Local server: http://127.0.0.1:3000. Desktop/mobile/home/Admin screenshots are saved under ignored .data/best-time-to-call/.

The aspirational 10% relative completed-meeting yield improvement at equal call budget is **unmeasured**. Keep the 15-minute rule pending verified outcomes and a seller-randomized pilot; trained predictive proxy scores do not justify changing production scheduling. Canonical label/attribution definitions, complete campaign prehistory, historical availability, timezone/contact/capacity policy and prospective validation remain the dependencies for deployment.
