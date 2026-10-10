# Research and evaluate better calling-time models

You are the research engineer and ML engineer for the existing Callwise application in `D:\Hackathon`. Investigate whether a better model, combination of models, or decision policy can improve recommendations for customers with no, sparse, or substantial call history. Complete the research, data discovery, reproducible dataset creation, training, and comparative evaluation on an isolated branch. Present measured findings so the user can decide whether to replace the current implementation.

This is an experimental evaluation task. Do not replace the live implementation, merge into the original branch, deploy, initiate calls, or change production scheduling. An improvement recommendation must be supported by real database data and a fair comparison with the current baseline. A well-supported finding that no candidate improves the baseline is also a valid outcome.

## 1. Establish the baseline and create an isolated branch

Read all applicable `AGENTS.md` instructions. Before writing Next.js code, read the relevant installed guides under `node_modules/next/dist/docs/`; do not assume familiar framework APIs apply.

Inspect Git status, the active branch, and HEAD. Record the starting commit. The checkpoint created for this work was `53ae52f` (`Checkpoint Callwise dashboard and calling-time models`); verify the actual repository state rather than assuming it still matches. Preserve any subsequent user changes. Do not reset, discard, or automatically commit unrelated work. Create a descriptively named experimental branch, such as `research/calling-time-models-<date>`, before changing implementation or experiment files. Use an isolated worktree if necessary to preserve unrelated changes.

Read the current implementation, model artifacts, tests, and documentation, including:

- `lib/best-time-ranking.ts`, `lib/best-time-policy.ts`, `lib/best-time-models.ts`, `lib/best-time-generalized.ts`, and `lib/best-time-experiments.ts`.
- Context, history, retry, service, LLM, and integration modules under `lib/`.
- Training, preparation, feature, calibration, and evaluation code under `ml/`.
- `docs/best-time-to-call/architecture.md`, `results.md`, `personal-ranking.md`, `data-dictionary.md`, `label-audit.md`, `acceptance.md`, and `reproduce.md`.
- Existing frozen artifacts and manifests in ignored `.data/` directories, including `.data/btc-operational-v3/models/`.

Explain the actual end-to-end baseline: history eligibility, personal ranking thresholds, short-call penalties, supported canonical-model paths, general proxy fallback, pooled-hour backoff, operating-hours fallback, preferred-day ordering, candidate eligibility, and conditional retry behavior. Distinguish route labels from the engine actually used. Verify which artifacts load successfully.

Current evidence indicates the general fallback is a smoothed `hour_day` model with validation-fitted Platt calibration, trained on 15,284 calls and 53 proxy positives. The separate observed-scope first-contact experiment had zero positives in its final test and is not the accepted general fallback. Treat these facts as starting context to verify. Do not describe pipeline capabilities or unused feature schemas as features of the trained model.

## 2. Define the objective and evidence standards

The primary business objective is completed meetings attributable to calls (`meeting_done`), at a comparable call budget. Meeting booked/fixed, answer rate, meaningful conversation rate, and calls per completed meeting are secondary outcomes. Optimizing pickup alone does not establish improvement in completed meetings.

The current fitted target is `observed_linked_physical_recorded_met_within14days`, an ERP recording proxy. Establish whether reliable canonical completion labels can be obtained. If not, continue with an explicitly separate proxy experiment and state that its findings cannot establish canonical completed-meeting uplift. Never silently convert missing outcomes to failures or rename proxy results as completed meetings.

Before fitting, write an experiment plan specifying target definitions, attribution and maturity horizons, eligibility, cohorts, sampling, splits, candidate families, tuning limits, metrics, selection rules, uncertainty estimates, and promotion criteria. Document changes to that plan before accessing new final-test outcomes.

## 3. Thoroughly investigate the database and reference code

You are authorized to inspect the available database through existing project integrations and to read the reference source tree at:

`C:\Users\imart\Pictures\No work\Repository`

Use that source tree to discover business definitions, table names, join keys, statuses, meeting lifecycle transitions, event timestamps, archival history, and relevant feature generation. Read its applicable instructions. Treat it as a read-only reference; make experimental changes only inside the experimental Hackathon checkout.

Inspect existing credential helpers and source configurations without printing secrets. Source 13 has historically exposed ERP tables; source 70 is a separate call-insight source. Verify actual access and schemas. Schema visibility alone does not prove query permission. Do not guess that similarly named tables across sources are interchangeable.

Search beyond the currently used tables. Investigate, where available:

- Outbound call starts, answer events, durations, dispositions, retries, meaningful UCIDs, recording metadata, and archives.
- Meeting booked, occurred, completed, cancelled, rescheduled, verified, and sales/conversion records, including reliable call-to-meeting attribution.
- Customer account creation, business type, industry, segment, geography, timezone, lifecycle, engagement, and declared contact preferences.
- Employee/team assignments, campaigns, lead origin, product, and workload, including historical assignment changes.
- Historical digital activity, prior meetings and outcomes, contact restrictions, appointments, working calendars, and capacity constraints.
- Event-time and availability-time provenance, update history, retention gaps, and coverage differences by source or period.

Produce a source inventory and feature feasibility matrix: source/table/column, business meaning, join keys and cardinality, event timestamp, availability timestamp, coverage, missingness, mutability, query access, and leakage risks. Trace important business rules to reference-code file paths and symbols, then verify them against bounded database samples. Reference code suggests semantics; it does not by itself prove data quality or completeness.

Use read-only, bounded queries. Start with schema inspection, aggregates, date filters, limited samples, and query plans where available. Avoid repeated full scans, writes, DDL, index changes, and modifications to production tables. Reuse credential handling and keep secrets out of output. Do not overwrite interactive Redash query definitions; use dedicated experiment queries when required by the existing extraction workflow. Record SQL, source IDs, execution cutoffs, sampling rules, counts, and resumable checkpoints.

Do not send raw customer identities, phones, transcripts, credentials, or database records to external LLMs. Keep raw extracts and row-level datasets under ignored local `.data/` paths. Reports committed to Git should contain aggregate, non-sensitive evidence.

## 4. Verify promising approaches against database evidence first

Before committing to a training pipeline, perform feasibility checks using real database data: label support, trustworthy linkage, historical feature availability, sample coverage, cohort sizes, and support across weekdays/hours. Use exploratory/development periods for these checks; reserve final-test periods.

Establish whether the proposed information exists and was knowable at the calling decision. For example, a segment feature needs historical values or a justified static interpretation; a richer completion model needs usable completed-meeting labels. Present-day profile values, later outcomes, and extraction timestamps must not be treated as historical knowledge.

Distinguish:

- Verified complete first-contact history.
- No calls observed within a stated source/time scope.
- Sparse observed history.
- Reliable substantial history.
- Missing or failed retrieval.

An empty fetch is not proof of lifetime first contact. Investigate reliable prehistory and report when it cannot be established. Choose candidates based on measured feasibility rather than presumed data availability.

## 5. Research and compare suitable model families

Use current primary sources such as official documentation and research papers. Cite sources and connect each candidate to the observed data constraints. Investigate several credible families, but bound tuning and avoid searching indefinitely:

- The existing smoothed hour/day model, simple population rates, and transparent personal-history baselines.
- Hierarchical Bayesian or mixed-effects models with partial pooling across supported customer groups, customers, and time slots. Evaluate whether they improve sparse-history behavior over the existing smoothing.
- Regularized logistic models with defensible clock, context, and prior-history features.
- Gradient-boosted trees such as CatBoost or LightGBM when sample size, positive support, and feature quality justify their complexity.
- Shared models with history features versus separate cohort models; learned gating or mixtures only where support permits.
- Separate answer and meeting-conversion components, only if their labels and conditioning are valid. Do not assume multiplying separately trained probabilities produces a calibrated meeting model.
- Survival or hazard models for retry timing when event times, censoring, and sequence identity are reliable.
- Contextual bandits or uplift/causal approaches as future candidates when randomized actions or adequate propensity/overlap evidence exists. Do not claim retrospective optimal scheduling from observational logs alone.

Explain exclusions as well as selections. With scarce positive outcomes, simpler models may be the best supported choice. Do not use arbitrary ensemble weights, unsupported customer embeddings, raw IDs as transferable cold-start features, fabricated data, or synthetic outcomes to demonstrate improvement. Customer IDs may be used for joins, grouping, and justified training-only random effects with safe unseen-customer behavior.

## 6. Build reproducible training and evaluation datasets

After feasibility checks, construct a new versioned dataset from the database with an explicit dictionary and provenance manifest. Preserve the existing datasets, frozen models, and test locks unchanged.

Use one defensible decision unit per example, such as an eligible outbound call at its actual start. Deduplicate calls and reconcile source overlap. Avoid join multiplication. Define attribution rules for multiple calls preceding one meeting, ambiguous links, multiple meetings, and cancellations. Do not credit the same completion repeatedly without an explicit justified definition.

Compute history strictly as of the decision timestamp. Features must precede the decision in both event time and verified availability time. Exclude current-call status, current-call duration, future meetings, later profile updates, and any label-derived counters from pre-call features. Keep post-call signals only in separately defined decisions where they are actually available.

Require sufficient outcome follow-up. Address censored calls, uncertain negatives, missing timestamps, timezone assumptions, archived histories, and label latency explicitly. Record exclusions and missingness by cohort. Do not drop inconvenient groups without reporting their effect on the target population.

Use chronological development and final-test splits with a maturity embargo. For cold-start evaluation, additionally keep customers and linked lead chains disjoint across splits; exclude their earlier records from training. For established-customer evaluation, repeated customers may be appropriate if every feature remains strictly historical. Evaluate these settings separately.

Use rolling temporal validation where support allows. Choose dates from actual coverage, include useful weekday coverage, and freeze split membership with checksums. Keep final-test outcomes outside feature selection, tuning, calibration, and threshold selection. The previously published test results are already known; use a fresh untouched holdout for new confirmatory claims where possible. If one is unavailable, report the comparison as exploratory and explain the limitation.

## 7. Train and compare fairly

Implement executable extraction/preparation, training, calibration, and evaluation commands on the experimental branch. Record code revision, software versions, seeds, hyperparameters, data hashes, split hashes, and model artifacts. Freeze the selected candidate before its final evaluation. Keep all candidates unapproved for deployment.

Make two distinct comparisons:

1. Current frozen model and current end-to-end ranking policy against candidates on the same eligible examples, outcome definitions, and calling constraints where compatible.
2. Existing baseline model family retrained on the new training data against candidate families trained on that same data.

This separates gains from new data from gains due to modeling. If labels differ from the original proxy, retain the original-task comparison and clearly separate the new-task experiment. Do not compare incompatible targets or claim a modeling gain from extra data alone.

Tune using training/development partitions only. Fit calibration on an appropriate development subset and evaluate it independently. If positive support is insufficient, decline unsupported calibration or discrimination claims. Reconcile Python and application scoring for exported artifacts. Assess pooled-hour backoff and unseen-customer behavior separately.

Run feature ablations and component comparisons: clock-only, added context, added history, partial pooling, and any ensemble versus its components. Check runtime, inference latency, artifact size, dependency burden, missing-feature behavior, and reproducibility.

Preserve calling constraints and unrelated application behavior. Offline recommendation examples or a preview behind an explicit experimental flag may be created on the branch, but the existing default route must remain unchanged.

## 8. Evaluate results and uncertainty honestly

Report cohort sample sizes and positives alongside:

- AUPRC/average precision and prevalence, ROC AUC when defined, log loss, Brier score, and reliability/calibration plots where supported.
- Yield/precision and recall at matched call budgets, ranking metrics, and calls per verified meeting or per explicitly named proxy event.
- Paired differences and customer-cluster uncertainty intervals; consider temporal variability and rare-event instability.
- Results for no observed history, verified first contact if available, sparse history, substantial history, supported/unsupported slots, and major supported segments.
- Scheduling constraint violations, safe fallback behavior, and operational costs.

Accuracy alone is inadequate for rare outcomes. A zero-positive cohort cannot establish positive-class discrimination. Report undefined metrics as unavailable. Never label ranking points, posterior uncertainty, or proxy estimates as verified individual meeting probabilities.

Historical data reveals the outcome of the action actually taken, not every alternative time. A retrospective call-budget comparison demonstrates association, not causal benefits of changing schedules. Offline policy evaluation requires justified action logging, propensities, overlap, and assumptions. Otherwise propose a bounded randomized pilot as the next step, without running it.

Set material improvement criteria before final testing, based on event counts, the objective, uncertainty, cohort stability, and operational costs. Distinguish promising, inconclusive, worse, and convincingly improved results. Do not declare victory because one metric improves slightly or because the final test was repeatedly consulted. Further tuning after final evaluation requires a new holdout or an explicit exploratory label.

## 9. Deliver findings for the user's decision

Create a concise decision report plus detailed reproducibility documentation on the experimental branch. Include:

- Verified baseline behavior and starting commit/branch.
- Database/reference-code discoveries with sources and business definitions.
- Data dictionary, label/attribution rules, feature feasibility matrix, coverage, exclusions, and remaining gaps.
- Research sources, candidate rationale, rejected alternatives, and selected model or combination.
- Training/split manifests, exact commands, model provenance, and reproducible aggregate evaluation artifacts.
- Baseline-versus-candidate tables with uncertainty, cohort results, calibration, ablations, and practical costs.
- Why any improvement occurs: new data, better labels, modeling, personalization, or a changed policy; distinguish measured evidence from hypotheses.
- A clear recommendation: retain the baseline, investigate further, or consider replacing it, with limitations and any proposed prospective pilot.
- If replacement is recommended, a concrete integration, validation, rollback, and monitoring plan for later approval.

Run meaningful experiment checks and relevant existing tests for branch changes. Run lint, type checks, and build if application code changes. Report the actual commands and outcomes; do not copy old passing results as current evidence.

Commit coherent experimental changes on the new branch, excluding secrets, raw data, and unrelated work. Keep locally generated training/test datasets and model artifacts available under ignored experiment directories with manifests explaining how to regenerate them.

Do not merge, deploy, approve model artifacts, switch the live default model, publish data, or launch a calling experiment. Present the findings and leave the replacement decision to the user. If no improvement is demonstrated, say so and provide the evidence and the most useful next step.

## Working expectations

Do the actual research and experiments; do not stop at a plan or literature summary. Progress autonomously through authorized read-only discovery and isolated experimental work. Give concise updates on discoveries, data limitations, and evaluation progress. Ask for clarification only when a consequential unresolved business definition or access requirement prevents valid work; continue independent work while waiting.

Thoroughness means verified sources, defensible labels, leakage-free datasets, fair comparisons, and reproducible results. Do not fabricate database access, training runs, model quality, or completed-meeting uplift. If canonical data or sufficient positives are unavailable, complete the supported proxy research and report exactly what remains unproven.
