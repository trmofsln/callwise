# Separate first-contact model

This path predicts the completed-meeting outcome of the first target-campaign outbound call, using historical first-contact examples. `meeting_done` is the objective, overriding the problem PDF's meeting-fixed objective. `meeting_fixed` and connect outcomes remain separate secondary counts. A proxy run is labelled `proxy` throughout; it does not verify canonical completed-meeting accuracy or causal schedule improvement.

Implementation: `ml/cold_start/contract.py`, `models.py`, `metrics.py`, and `train.py`. Training is offline. JSON export supports Node inference without a Python server or model deserialisation. A missing or failed history fetch never establishes first contact.

## Point-in-time dataset contract

Each JSONL row must provide `attempt_id`, `seller_id`, `lead_id`, `call_at`, `available_at`, `history_complete`, `prior_attempts`, `metadata`, `metadata_provenance`, `target`, and `source`, following the shared extraction contract. `employee_id` is linkage/audit context and is excluded from cold-start features.

Eligibility requires explicit `history_complete: true`, numeric `prior_attempts: 0`, a historical call, an observation available by the extraction cutoff, and a mature binary completed-meeting label. A positive needs a completion timestamp between call and label maturity. All timestamps must contain an offset; extraction may attach a separately disclosed timezone assumption before writing rows. Zero prior history means target-campaign outbound history; prior PNS/buyer-seller activity is a different cohort and is not used here. Complete history requires verified prior coverage beyond a bounded extraction period. The trainer cannot certify completeness from the first row it happens to observe.

`available_at` is when the call observation became available, not extraction time, and never a predictor. Each metadata field needs `{source, available_at, historical: true}` or `{source, available_at, verified_static: true}`. Its availability must precede the decision. Missing provenance, mutable current snapshots, late observations, future account creation dates, and invalid values exclude the field. Metadata-free rows remain eligible for hour/day baselines; excluded metadata is counted. GLID, names, phone numbers, current call outcomes/duration, current summaries, and future meeting events are not predictors.

Only one claimed first target-campaign call per seller is accepted. Duplicate attempt IDs and conflicting first-contact records fail rather than silently multiplying observations. Canonical and proxy rows cannot be combined in one experiment.

## Research and bounded experiment matrix

Regularised logistic regression gives a transparent probability model; its coefficients can be exported directly. [Official linear-model documentation](https://scikit-learn.org/stable/modules/linear_model.html#logistic-regression). Hierarchical smoothing stabilises low-support categorical/hour bins; strong simple baselines are useful before more flexible models. The registered development matrix contains two smoothed baselines and four logistic trials: time-only versus verified metadata/time interactions, each at L2 strengths `0.005` and `0.05`. These are deterministic, with no resampling or balancing that would alter observed prevalence.

Preprocessing is fit on training rows only; test-only categories map to the reserved other category. This follows the train/test separation described in the [official leakage guidance](https://scikit-learn.org/stable/common_pitfalls.html#data-leakage). Assessment uses average precision (stepwise PR area), ROC-AUC, log loss, Brier score, reliability bins, yield at a 20% observed call budget, calls per completed meeting, and prevalence. Tied scores receive fractional expected selection at the budget cutoff. [Official metric definitions](https://scikit-learn.org/stable/modules/model_evaluation.html).

Compatibility verified on 10 October 2026: local CPython `3.14.5`, NumPy `2.5.3`, and tzdata `2026.4`; scikit-learn is absent. Current [scikit-learn installation documentation](https://scikit-learn.org/stable/install.html) supports Python 3.11–3.14. The implementation therefore uses its own bounded full-batch logistic optimiser, optionally accelerated by existing NumPy, and portable numeric inference. This is not a claim of solver parity with scikit-learn. Windows timezone conversion requires IANA data; Python documents [zoneinfo's tzdata fallback](https://docs.python.org/3.14/library/zoneinfo.html#data-sources).

CatBoost/boosted trees or a neural model are deferred until verified label volume and historical metadata can justify extra complexity. They are not reported as evaluated models. Standard-library training is slower for large matrices; NumPy acceleration changes compute only. The artifact records the optimizer, iterations, convergence status, dependency versions, and seed.

## Features and inference contract

`feature_schema` stores exact `feature_names`, training-fit `categories`, `interaction_fields`, timezone, and account-age transform settings. Numeric features are:

- `hour_sin`, `hour_cos`: local call-start fractional hour on a 24-hour cycle.
- `weekday_0` through `weekday_6`: Monday=0, Sunday=6.
- Metadata models add `account_age_log1p = log1p(min(age_days,3650))/log1p(3650)` and `account_age_missing`.
- City, state, industry, business type, and segment one-hot categories; minimum training support five; reserved `__missing__` and `__other__`.
- State and industry one-hot indicators multiplied by hour sine/cosine, for the metadata interaction candidate.

No employee or seller identifier enters the model. Time is the call window's start, never the meeting occurrence hour. Account age advances deterministically to the candidate call, while metadata availability is checked at the original inference `as_of`.

After selecting the raw validation winner, the trainer fits a two-parameter Platt mapping when validation contains at least 20 completed-meeting positives and 20 negatives. Its inputs are clipped raw probability logits. The exported transform is `sigmoid(slope * logit(clamp(raw_probability, 1e-6, 1-1e-6)) + intercept)`. Platt target smoothing, a small slope penalty, and a nonnegative slope keep parameters finite and preserve the selected ordering. Insufficient support or optimizer failure produces `kind: none, calibrated: false`. This follows the sigmoid approach in the [official calibration documentation](https://scikit-learn.org/stable/modules/calibration.html#sigmoid).

The artifact records `kind: platt`, `slope`, `intercept`, `clip: 1e-6`, `input: logit_probability`, `fitted_split: validation`, and `calibrated: true` only for a successful supported fit. That flag means the frozen mapping is applied; reliable future calibration still requires held-out evidence. Selection and calibration reuse validation, so all reported validation metrics remain raw (`validation_metrics_kind: raw_before_calibration_fit`). No independent calibrated-validation result is asserted. The locked test evaluates the frozen transform once and also records the raw selected model for comparison. Test labels never fit or update calibration.

Portable artifact shape:

```json
{
  "schema_version": 1,
  "route": "cold_start",
  "model_version": "cold-start-<label-kind>-<dataset-hash>-<model-hash>",
  "primary_target": "meeting_done",
  "label_kind": "canonical or proxy",
  "timezone": "Asia/Kolkata",
  "family": "logistic or hour_day or cohort_hour_day",
  "feature_schema": {
    "feature_names": [], "categories": {}, "interaction_fields": [],
    "account_age_cap_days": 3650
  },
  "logistic": {"coefficients": [], "intercept": 0, "l2": 0.05},
  "smoothing": {
    "strength": 20, "global": {"count": 0, "positive": 0},
    "bins": {}, "cohorts": {}
  },
  "calibration": {"kind": "none", "calibrated": false},
  "deployment": {"approved": false, "reason": "independent review required"}
}
```

Numbers above illustrate schema fields only; no fitted artifact or measured scores are supplied by this example. Baseline artifacts have `logistic: null`. Each slot key is `weekday:hour`, and each bucket has `{count, positive}`. Cohorts nest as `field -> value -> slot -> bucket`. Global rate is `(positive+1)/(count+2)`. Slot rate shrinks toward global rate: `(slot_positive + 20*global_rate)/(slot_count+20)`. A cohort slot with at least five observations shrinks toward that slot rate. The highest-support eligible industry/state/segment slot is selected deterministically; ties preserve field order. Logistic prediction is `sigmoid(intercept + sum(coefficients[i]*features[i]))`.

Python `score_windows` accepts a verified zero-history context and backend-approved future `{start,end}` windows. It returns ranked probabilities with observed-slot support, metadata exclusions, and score status. Fewer than five observations at the relevant slot returns `probability: null`, including when logistic extrapolation is numerically possible. Score status distinguishes supported validation-calibrated and uncalibrated artifacts. A fitted probability is not a confidence interval. Seller-cluster bootstrap intervals quantify held-out aggregate metrics. A deployed artifact registry and the scheduling backend own approval, timezone evidence, business hours, DNC, capacity, attempt limits, and retry constraints.

## Reproduce training and final evaluation

Run from `D:\Hackathon`. IANA timezone data is the only required non-stdlib package on Windows; existing NumPy is optional:

```powershell
py -3.14 -m pip install -r ml/cold_start/requirements.txt
py -3.14 tests/cold-start-checks.py
py -3.14 -m ml.cold_start.train --dataset .data/best-time-to-call/attempts.jsonl --splits .data/best-time-to-call/splits-v2.json --output .data/best-time-to-call/models/cold-start --as-of 2026-10-09T19:20:02.069Z
py -3.14 -m ml.cold_start.train evaluate --dataset .data/best-time-to-call/attempts.jsonl --splits .data/best-time-to-call/splits-v2.json --output .data/best-time-to-call/models/cold-start --as-of 2026-10-09T19:20:02.069Z
```

The exact dataset name and cutoff must match the extraction manifest. Add `--allow-proxy` to both commands for an explicitly separate proxy experiment. No synthetic production dataset is generated. `BEST_TIME_PYTHON` can select another Python executable for the Node test harness.

The split manifest must contain the exact dataset SHA-256, explicit IANA timezone, label kind, and immutable `cold_start: {train:[attempt_id], validation:[...], test:[...]}` membership created by the extraction lead. The current corrected manifest is `splits-v2.json`; archived `splits.json` is preserved as blocked evidence. This trainer checks seller/lead isolation, chronology, and label maturity before the next period; it never decides membership. Training fails if no verified eligible train/validation rows survive. A positive coverage flag without prior-history verification remains an extraction defect, not a statistically inferred fact.

Training writes `acceptance.json`, `model.json`, `model-card.json`, `dataset-manifest.json`, `experiments.json`, and `freeze.json` before final scoring. The artifact and manifest include accepted training feature counts and source/verification provenance. Acceptance records the hour/day baseline, validation selection rule, minimum support, and predictive criteria. It selects the lowest validation log loss among candidates with at most 0.01 Brier degradation. Rolling 60%/80% development folds refit encoders and models with label-maturity embargo. Held-out location/industry/segment cohorts and missing/unseen metadata are assessed separately when available.

Final evaluation verifies all checksums and the frozen eligibility cutoff, then atomically creates `test-lock.json` before scoring the frozen model once. It writes `test-results.json` and updates the output model card; repeated evaluation or overwriting a frozen model fails. An interrupted evaluation leaves the lock in place for audit. The base classifier is not refit on validation after selection; only the declared supported Platt mapping uses validation before freeze. The test compares the final frozen selected artifact with the raw hour/day baseline and reports raw selected metrics separately. It reports whether predictive acceptance and support criteria were met; deployment remains unapproved pending label, coverage, and policy review. Minimum support: training 100 calls/10 positives, validation 30/5, final test 30/5. These are modest minimum reporting thresholds, not proof of reliable policy lift.

## Honest completion status

The code and tests run without access to live production data. Unit fixtures exercise the entire freeze/evaluation lifecycle in a temporary directory, then are removed; those outputs are not model-performance evidence. A genuine artifact is trained only when the shared extraction supplies verified first-contact rows and immutable seller-disjoint splits. No canonical label accuracy, cold-start held-out result, or causal improvement is asserted in this document.

The committed `ml/cold_start/model-card.json` is an explicit blocked status card, not trained weights. The implementation lead's bounded hotlead audit found 4,978 attempt rows across 4,706 sellers and 17 dates, with zero linked DSR meetings; a separate recent 1,000-row linkage audit matched 1,000 click-to-call records and 457 DSR calls but no reverse-linked meetings. These linkage counts do not prove completed-meeting negatives or zero prior calls. Canonical semantics and complete prior seller coverage remain unresolved. Training therefore excludes unknown targets/unverified first contact and refuses a homogeneous training label set. Different-population ERP proxy data cannot silently become hotlead first-contact evidence.

The actual locked dataset was also audited by this path at its latest extraction-bound timestamp, `2026-10-09T19:20:02.069Z`: all 4,978 primary labels are unknown, all histories are unverified, 300 provisional maturity timestamps remain in the future, and zero train/validation/test rows qualify even with explicit proxy opt-in. Strict training exits with `eligible seller-disjoint train/validation data unavailable`; no weights or calibration are fitted. The card records exact dataset/split checksums and exclusion counts, with baseline and held-out metrics null. Extraction-bound `available_at` is conservative availability evidence, rather than proof of historical call-observation availability.

Archived `splits.json` declared a 21-day maturity embargo while its validation-end/test-start boundary gap was 20 days. Its final validation observation matures at `2026-09-02T16:59:58+05:30`, after the first test observation at `2026-09-02T09:07:02+05:30`. No models or test scores used that manifest. The implementation lead locked `splits-v2.json` before any fit or scoring, setting validation end to `2026-08-12T00:00:00+05:30` so August 12 observations are excluded. Both tracks now pass maturity-before-next-period checks. Cold-start membership is 2,162 train / 1,134 validation / 1,132 test, and eligible counts remain zero. The dataset and archived v1 manifest were preserved; the owned model card records the v2 checksum and archived review.

The aspirational 10% completed-meeting policy lift and positive 95% lower bound cannot be evaluated from uncalled observational windows. Report predictive results separately and use a prospective seller-randomised shadow/pilot evaluation after label and coverage validation. The first-contact model supplies no evidence that a 15-minute retry is optimal; retry evaluation belongs to the history-aware track.

## Separate observed-scope ERP proxy experiment

The user subsequently requested actual DB-backed model training. A separate explicit experiment may use general ERP employee outbound calls and directly attributed physical DSR recorded-success proxies. This is a different population and a proxy endpoint; the hotlead pilot and canonical target remain unchanged. The original strict `cold_start` contract still requires complete prehistory. A sampled earliest row never qualifies as a first call in either path.

The new mode requires both `--observed-first-contact-proxy` and `--allow-proxy`. Its manifest supplies:

```json
{
  "label_kind": "proxy",
  "history_scope": {
    "scope_id": "versioned observed ERP scope",
    "population": "general_erp_employee_outbound",
    "coverage_start": "explicit ISO timestamp",
    "coverage_end": "explicit ISO timestamp",
    "complete_within_scope": true,
    "lifetime_complete": false,
    "availability_verified": false,
    "prior_call_search_verified": true,
    "source_ids": [13],
    "source_tables": ["redash.click_to_call", "redash.sts_dsr_call"]
  }
}
```

Each example explicitly retains `history_complete: false` and `prior_attempts: 0`, plus `history_verification: {scope_id, prior_call_exists: false, prior_search_verified: true, checked_before: <call_at>, available_at: <audit observation time>, observation_as_of: <current-record observation time>}`. Complete extraction or independently verified DB prior-call predicates within the declared sources/scope are required. The contract checks exact call/search boundary, scope match, verification observation by the extraction cutoff, mature proxy attribution, and seller-disjoint chronological splits. Unknown prior-search results, samples without coverage verification, missing evidence, calls outside scope, and contradictory lifetime completeness fail closed. Archived history outside the covered sources cannot be asserted absent.

`prior_search_verified` means a correctly scoped DB predicate was executed against observed current records; it does not establish that every prior record or value was available at the original historical decision. ERP audits found that `click_to_call.entered_on` can be supplied or updated, so it is not accepted as historical availability evidence. Current status/outcome/history counters are excluded. The experiment defaults to time-only models; extra metadata must carry independently verified static provenance. Repeated missing categories are not fitted as an apparent metadata candidate. Mutable call-start timestamps, replication omissions, archives outside scope, and retrospective cohort selection remain limitations.

Artifacts and model cards use the distinct route `cold_start_observed_scope`, `experimental: true`, `eligibility_policy: observed_first_contact_proxy`, `lifetime_history_verified: false`, `historical_availability_verified: false`, and `canonical_label_verified: false`. Existing freeze/checksum/one-time-test safeguards apply, including explicit mode preservation between train and evaluate. Runtime experimental scoring requires a fresh zero-prior scoped DB check at `as_of`; it cannot substitute for the strict cold-start scorer or a production recommendation. Physical recorded-success semantics, missing/updated meeting records, historical availability, limited source coverage, and temporal population drift must remain visible limitations.

Use a separately extracted dataset and immutable splits, then add both explicit flags and `--proxy-target observed_linked_physical_recorded_met_within14days` to the train/evaluate commands. The source keeps canonical `target.meeting_done: null`; only an internal numerical loss copy aliases the separately named proxy. Artifact/card/report `trained_target` records the actual supervised endpoint. A positive's `proxy_recording_at`, when supplied, is used as its recording event time, never asserted physical completion time. Named proxy classifiers require at least 10 training positives. `audit` writes a blocked/null-metric support card without fitting or scoring, and refuses to replace a frozen artifact.

The separate `--general-erp-proxy --allow-proxy --proxy-target ...` mode uses immutable `history` membership for all sampled outgoing ERP attempts, including previously observed sellers. It exports route `erp_outbound_observed_proxy`, uses clock features only, and allows seller repetition across chronological periods with unique attempts, the 14-day target-window embargo, and seller-cluster uncertainty. Preparation's `lead_id = erp-seller:<seller>` is a synthetic seller grouping; actual lead/retry sequence identity is unavailable. It must not be treated as a real chain requiring all seller activity in one partition. A genuine provided chain ID retains isolation checks. The strict canonical and cold seller-disjoint contracts remain unchanged. This is a general sampled-call proxy model, rather than a personalized history model or true cold-start model. Both experimental paths keep production approval false and evaluate their frozen final test once. Default output directories for the uniform operational-v3 experiment are `.data/btc-operational-v3/models/cold_start` and `.data/btc-operational-v3/models/general_erp`.

The first operational-v2 extraction was reviewed before any fit, showing insufficient cold positive support. The implementation lead authorized a uniform quota expansion from 1,000 to 4,000 calls per same frozen date, preserving the original dataset and dates, without outcome-based sampling or fitting against v2. Models were fitted only after final immutable operational-v3 delivery; measured results follow below. Optional boosting libraries are absent; existing NumPy supports the strong time-only logistic/hour-day comparison without new dependencies. If sufficient verified proxy volume and feature complexity justify a boosted comparison, install it only in a workspace virtual environment and keep the temporal validation/test discipline. [Histogram boosting documentation](https://scikit-learn.org/stable/modules/generated/sklearn.ensemble.HistGradientBoostingClassifier.html) describes its loss and optional early stopping; random internal validation must not replace the locked chronology. [XGBoost's official installation guide](https://xgboost.readthedocs.io/en/stable/install.html) supports Windows wheels and a smaller CPU package, subject to a real compatibility smoke check before choosing it.

Frozen operational dates cover Tuesday/Wednesday/Friday/Sunday in training, Wednesday/Friday/Sunday in validation, and Monday/Wednesday/Friday in test. Monday is therefore a preregistered unseen-weekday test cohort. All final test calls remain in the aggregate evaluation; the report additionally separates supported slots, insufficient-support slots, unseen training weekdays, and each observed weekday. Inference returns null for slots below five training examples, including wholly unseen weekdays. These checks measure schedule support and temporal shift rather than a personal optimum. `prior_attempts` is a scoped prior-existence indicator in this extraction, not an attempt-count feature. Per-row extraction observation times form an assembled bundle, not a transactional database snapshot.

Before any operational-v3 candidate fit or test scoring, the implementation lead tightened rare-event proxy predictive tolerances: maximum Brier degradation is `max(0.0001, 0.05 * validation_baseline_brier)` and maximum log-loss degradation is `max(0.001, 0.05 * validation_baseline_log_loss)`. The original 0.01/0.02 absolute tolerances are too permissive near 0.3% prevalence. Each run fits only its transparent count baseline, writes `acceptance.json` with these fixed numerical tolerances, then fits/selects supervised candidates. The same contract values apply to raw validation admission and final frozen test pass/fail, alongside AP at least prevalence and declared positive-support requirements. Test values do not adjust thresholds. This predictive criterion never grants production approval or assesses causal policy lift.

Validation and final reports additionally separate calls with observed matched DSR records, calls without a match, and unknown linkage diagnostics. Matched-only results are a sensitivity check; the frozen complete sample remains the primary experimental denominator. Linkage/meeting counts are final-record audit variables and never model inputs. Observed absence can reflect workflow/linkage coverage rather than an actual failed physical meeting.

Operational-v3 preparation quarantines all eight rows belonging to three sellers with multiple zero-prior calls at the same timestamp. Those rows remain valid general ERP sampled attempts but are excluded from the immutable cold track; no arbitrary call is credited as first. The cold trainer verifies the whole-file checksum, restricts to the already provided cold membership, then checks first-contact eligibility and fits preprocessing. It never chooses membership or resolves ambiguous sellers after looking at model outcomes.

## Actual operational-v3 results

Both artifacts were genuinely fitted from 39,284 database-backed ERP attempts (36,447 sellers, 130 observed proxy positives), dataset SHA-256 `b54c79c89d43853ea97db086174968c6de3ba0bfc1980f2009293c55389ef72d`. The observation cutoff is `2026-10-09T22:48:35.713Z`; split SHA-256 is `847a8152eb7fdbba15bfba9e8f3f2c7c59258c6f30ca6e787110ae467f548f0b`. Both selected artifacts were frozen before either final test was scored, then evaluated once, without subsequent tuning. These are results for **`observed_linked_physical_recorded_met_within14days`**, with canonical `meeting_done` unknown.

| Track | Training calls / proxy positives | Validation calls / proxy positives | Locked test calls / proxy positives | Selected artifact | Test AP | Test ROC-AUC | Test Brier | Test log loss |
|---|---:|---:|---:|---|---:|---:|---:|---:|
| Observed first contact | 6,242 / 17 | 2,334 / 3 | 1,364 / 0 | Time-only logistic, L2 0.005; uncalibrated | Undefined | Undefined | 0.00000842175 | 0.0028898394 |
| General ERP | 15,284 / 53 | 12,000 / 34 | 12,000 / 43 | Smoothed hour/day + validation Platt | 0.0052088863 | 0.6431855622 | 0.0035670719 | 0.0230957694 |
| General ERP raw hour/day baseline | Same training | Same validation | Same locked test | Raw smoothed hour/day | 0.0052088863 | 0.6431855622 | 0.0035712987 | 0.0232381170 |

General ERP test prevalence is 0.0035833333 (0.3583%). Seller-cluster bootstrap 95% AP interval is 0.0033806780–0.0074963921. At a fixed 20% observed call budget, tie-aware proxy yield is 0.0060512552, with 95% interval 0.0030213408–0.0088436813. The calibrated selected model has the **same ranking and yield** as the strong raw hour/day baseline; its yield-difference interval is `[0,0]`. Calibration modestly reduces Brier/log loss. This is retrospective proxy discrimination and probability assessment, rather than measured completed-meeting policy lift.

The general model passes the modest preregistered **proxy predictive** criteria. The observed-first model fails support/predictive acceptance: its final cohort has no positives, so PR/ROC discrimination is unidentifiable and calibration lacked validation support. Its majority-class accuracy of 100% merely describes an all-zero test label set and is not a success metric. Neither artifact verifies canonical labels, true lifetime first contact, original historical availability, or causal lift; neither is approved for production.

Monday accounts for 4,000 general test calls and 15 positives, with no Monday training support; all are retained in full test assessment but future unsupported slots return null. General matched-DSR sensitivity has 3,479 calls / 43 proxy positives; 8,521 unmatched calls have no observed linked proxy records. The unmatched zero class is observed absence, rather than a verified canonical failure. The first-contact test has 414 unseen-Monday calls and zero proxy positives throughout.

Artifacts are under `.data/btc-operational-v3/models/cold_start` and `models/general_erp`. Each directory contains `model.json`, `model-card.json`, `dataset-manifest.json`, `acceptance.json`, `experiments.json`, `freeze.json`, `test-results.json`, and completed `test-lock.json`. Model cards include family, actual training counts, source scope, baseline comparison, clock/link support, model/report hashes, and exactly one final evaluation. The completed result and model hashes were verified after reporting enrichment; model weights and final test reports remain frozen.

Original commands (the existing output directories now reject re-fitting or repeated evaluation):

```powershell
py -3.14 -m ml.cold_start.train train --dataset .data/btc-operational-v3/attempts.jsonl --splits .data/btc-operational-v3/splits.json --output .data/btc-operational-v3/models/cold_start --as-of 2026-10-09T22:48:35.713Z --allow-proxy --observed-first-contact-proxy --proxy-target observed_linked_physical_recorded_met_within14days
py -3.14 -m ml.cold_start.train train --dataset .data/btc-operational-v3/attempts.jsonl --splits .data/btc-operational-v3/splits.json --output .data/btc-operational-v3/models/general_erp --as-of 2026-10-09T22:48:35.713Z --allow-proxy --general-erp-proxy --proxy-target observed_linked_physical_recorded_met_within14days
```

After both freezes, the identical arguments with positional `evaluate` ran each final evaluation once. Further improvement needs new development data and a new preregistered evaluation; these locked test results cannot drive a re-fit. A shadow or randomized pilot with verified completion labels is still required to assess the 10% completed-meeting lift objective and retry timing.
