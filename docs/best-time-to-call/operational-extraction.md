# Actual ERP proxy extraction and preparation

The actual source-13 database experiment uses the separately named `observed_linked_physical_recorded_met_within14days` target. Its complete business/availability limits are in [operational-proxy-contract.md](./operational-proxy-contract.md). `target.meeting_done` remains null in the prepared data; the named proxy has the numeric training label. Nothing in this extraction verifies the canonical outcome or a change to the retry rule.

## Versions and fixed sampling

The failed earlier `.data/btc-operational` plan and checkpoints are preserved. They did not supply a trainable completed-meeting dataset. The next experiment, `.data/btc-operational-v2`, first verified **call volumes only** on ten proposed dates, then froze those dates and hash sampling before retrieving their labels or fitting models:

| Split | Preregistered dates | Recording-window embargo |
|---|---|---|
| Train | 12, 14, 16, 18 August 2026 | Last 14-day recording window ends before 2 September |
| Validation | 2, 4, 6 September 2026 | Last 14-day recording window ends before 21 September |
| Test | 21, 23, 25 September 2026 | Full nominal 14-day window covered by 10 October extraction |

V2 samples up to 1,000 calls per date, using MD5 of original call ID plus fixed seed `erp-observed-v2-71`, sorted with call ID as a deterministic tie-break. Its actual frozen data contains 10,000 calls, 9,758 sellers and 29 qualifying recorded-met positives. General ERP chronological train/validation/test support is 4,000/11, 3,000/6 and 3,000/12 rows/positives. Verified zero-prior **observed-scope** support is 1,645/3, 582/0 and 351/0. It was not fitted because first-observed positive support was inadequate.

V3 uniformly expands the same ten dates to **up to 4,000 calls per date**, before any fitting or test scoring. It preserves the original 200 V2 chunks byte-for-byte and verifies their SHA256 checksums, then requests the next 60 chunks per date using exactly the same query and ordering. It does not move dates, select positives, rebalance outcomes, or treat the first sample and its larger parent as independent data. The V3 plan records its timestamp, expansion reason, parent dataset checksum and original chunk checksums. Use the final manifest's actual counts; a cap does not promise that every date has that volume.

The completed V3 bundle was preregistered at `2026-10-09T22:36:03.808Z` and finished at `2026-10-09T22:48:35.713Z`. It contains **39,284 calls / 36,447 sellers / 130 qualifying physical recorded-met positives (0.331%)**. The 16 August cohort exhausted at 3,284 calls; the other nine dates supplied their 4,000-call caps. Original V2 observations are preserved from `2026-10-09T22:30:19.320Z`. No model fitting or final test scoring preceded the completed dataset freeze.

| V3 track / split | Calls | Distinct sellers | Proxy positives |
|---|---:|---:|---:|
| General ERP train | 15,284 | 14,345 | 53 |
| General ERP validation | 12,000 | 10,684 | 34 |
| General ERP test | 12,000 | 11,811 | 43 |
| First observed in scope train | 6,242 | 6,242 | 17 |
| First observed in scope validation | 2,334 | 2,334 | 3 |
| First observed in scope test | 1,364 | 1,364 | 0 |

The cold track has enough positives to fit an exploratory artifact, but three validation positives and zero final-test positives cannot establish reliable positive-class discrimination or calibration. Report undefined metrics and failed support/acceptance explicitly. Preserve that result rather than changing dates, balancing outcomes or redefining cold history to produce positives. Test class counts above are a data-quality summary, not model performance or causal lift.

Linkage diagnostics: 9,893 calls match seller-consistent DSR entries; 201 calls have joined meeting records, comprising 205 joined records. Four meeting records with a conflicting seller are rejected from the positive predicate. No sampled UCID duplicates required merging; eight ambiguous multiple-first-observed rows are excluded from the cold track. Across the whole bundle, 16,562 calls have provider-reported Answered status (42.16%); this secondary status diagnostic does not verify seller conversation.

Dataset SHA256: `b54c79c89d43853ea97db086174968c6de3ba0bfc1980f2009293c55389ef72d`. All nine integrity checks passed; `.data/btc-operational-v3/verification.json` stores the result. Replaying all 786 cached chunks through exact query/source/47566/hash guards and repeating preparation produced byte-identical immutable outputs without further database requests.

## Bounded read-only querying

`scripts/btc-operational-v2.cjs` uses source 13 and the dedicated persistent training query 47566 through `REDDASH_TRAINING_QUERY_ID`, preserving the interactive query configuration. All queries run serially. A chunk contains at most 50 calls; each call has a valid same-day actual start, seller/employee ID, explicit outgoing direction and terminal answered/notanswered status. The query uses the exposed date/direction index to obtain the day's cohort, materializes the capped spine, then resolves UCID -> seller-consistent DSR call -> direct/reverse meeting links. It retrieves identifiers, times and outcome codes only, without contact numbers, email addresses, recordings, summaries or credentials.

A separate indexed `EXISTS` per call searches qualifying earlier outgoing call events in the current exposed ERP replica from 1 May to the actual decision time. It is an existence indicator, **not an exact count** and not historical availability proof. `prior_attempts` is 0 or 1 with `prior_count_kind=exists_indicator_not_exact_count`; it must not be displayed as the seller's lifetime attempt count. `history_scope.complete_within_scope=true` describes a complete search of the defined observable current-replica event population, not proof of all real-world calls. Lifetime coverage and historical availability are explicitly false. Missing actual timestamps and nonexposed/deleted records can further limit this scope.

Every raw checkpoint stores the exact SQL, query hash, source/query IDs, extraction time, elapsed time and returned rows in ignored `.data` directories. This is a frozen **extraction bundle** assembled over time, not a transactional database snapshot. Each row keeps its own observation time. Current final outcome codes may include later edits; recording time does not prove when a later correction became available. The 14-day `mature_at` is nominal recording-window maturity, not organizer-confirmed final canonical status.

## Preparation and isolation

`ml/operational_prepare.py` verifies planned chunks, source/query IDs and query hashes. It deduplicates meaningful UCIDs after seller/employee/time consistency checks, rejects conflicting identities or event times, aggregates meeting IDs, checks seller and call linkage, and limits physical recorded-met positives to the strict mode 0 / non-null non-9 result predicate inside the forward 14-day recording window. A meeting credited to different attempts raises an error instead of silently multiplying positives. A proxy zero means absence of the defined linked record in the observed bundle.

Only prospective local hour/day features are allowed. Employee ID, GLID, current metadata, current outcome/duration, previous answer status and meeting yield are excluded from training features. The India timezone is an explicit assumption for naive ERP timestamps. All metadata/provenance dictionaries are empty. Source identifiers remain available for ignored audit/deduplication and seller-isolated evaluation, not memorization.

V3 also preserves `target.connected` as a secondary **provider-reported Answered/NotAnswered status** diagnostic, with an explicit basis field. It is never a predictor and does not prove a seller conversation or duration-qualified successful connect. Canonical `meeting_fixed` remains null because its label is unavailable. The `lead_id` field is an `erp-seller:<seller_id>` grouping surrogate for split isolation, not a real source lead ID.

The preparation writes three immutable files:

- `attempts.jsonl`: unique call rows, numeric named proxy, null canonical label, observation provenance and exact scoped-prior existence checks.
- `splits.json`: chronological general ERP membership, first-observed scope membership, named history-scope contract, dataset checksum and 14-day embargo.
- `dataset-manifest.json`: actual counts/prevalence by split, linkage/exclusion diagnostics, raw/query/plan checksums, feature limits and canonical/availability gates.

The `history` membership key identifies the general chronological experiment; it does not make a time-only model personalized or prove historical feature availability. Cold membership includes only zero scoped-prior search results and rejects multiple ambiguous first-observed claims for a seller. Cold seller and lead keys are disjoint across its splits. “First observed since May in this replica” must not be reported as verified first-ever call.

V2 checks passed for unique attempts, dataset/checksum agreement, explicit null canonical labels, empty mutable metadata, seller-disjoint cold splits, positive recording windows, nominal maturity and 14-day split embargo. Repeating its preparation produced byte-identical immutable output. The final expanded dataset must pass the same checks before model fitting. If a split lacks positive support, record that fact; it cannot produce meaningful positive-class discrimination or calibration simply by fitting a classifier.

## Reproduction

Run from `D:\Hackathon` with the already configured server-side Redash credentials. Do not print the environment file or token values.

```powershell
# Optional call-volume checks only. This does not select by outcomes.
node scripts/btc-operational-v2.cjs probe

# Frozen original 10,000-row cap; existing checkpoints resume safely.
node scripts/btc-operational-v2.cjs extract 20
python ml/operational_prepare.py --root .data/btc-operational-v2

# Uniform expansion; records a new plan and checksums the original chunks.
$env:BTC_OPERATIONAL_ROOT='.data/btc-operational-v3'
node scripts/btc-operational-v2.cjs extract 80
python ml/operational_prepare.py --root .data/btc-operational-v3
python ml/operational_prepare.py --root .data/btc-operational-v3 --verify
```

Do not run simultaneous processes against the persistent training query; the serial queue is process-local. Do not mutate frozen plans or datasets to retry tuning against a test set. Query failures leave completed checkpoints intact, and preparation refuses an incomplete plan. Offline classifiers must read the manifest's named proxy target explicitly and retain `canonical_label_verified:false`; their estimates are observed-proxy associations under historical sampling, not measured causal schedule improvement.
