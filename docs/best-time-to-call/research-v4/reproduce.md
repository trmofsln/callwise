# Research v4: reproduce

**Scope.** All of this work is experimental and lives on branch `research/calling-time-models-2026-10-10`. Nothing in it is installed into the app: `BTC_MODEL_DIRECTORY` and `BTC_EXPERIMENT_DIRECTORY` are not changed.

**Generated files.** Raw extracts, datasets, model bundles and result JSON all go under the ignored directory `.data/btc-research-v4/`. They are not committed.

## Environment

```bash
uv venv .venv --python 3.13
uv pip install --python .venv/bin/python numpy pandas scipy scikit-learn lightgbm statsmodels tzdata pyarrow
```

Verified versions (2026-10-10, Linux 6.17):

| Package | Version |
|---|---|
| Python | 3.13.7 |
| numpy | 2.5.3 |
| pandas | 3.0.6 |
| scikit-learn | 1.9.1 |
| lightgbm | 4.7.0 |
| scipy | 1.18.1 |
| pyarrow | 26.0.0 |

`models/freeze.json` records the exact versions and the code revision used for the frozen run.

## Credentials and query id

**Credentials.** `.env` supplies `REDASH_URL` and `REDDASH_API_KEY`. Neither is ever printed.

**Query id.** All research SQL runs under one dedicated saved query, `hackathon-btc-research-2026-10-10`.
- Its id is stored in `.data/btc-research-v4/redash-query.json`. You can override it with `REDDASH_RESEARCH_QUERY_ID`.
- The client refuses to run if that id equals any interactive id (`REDDASH_ADHOC_QUERY_ID`, `REDDASH_USER_QUERY_ID`, `REDDASH_TRAINING_QUERY_ID`).
- Statements are executed through `POST /api/query_results` with `query_id`, so the saved definition is never rewritten and chunks can run concurrently.

**Pseudonymization.** Identifiers are pseudonymized inside SQL with a local salt kept in `.data/btc-research-v4/pseudonym-salt` (mode 0600). The salt is redacted in `.data/btc-research-v4/query-audit.jsonl`.
- To regenerate the same pseudonyms, keep the salt file.
- If you delete it, the next run creates a new salt, and the exclusion of the earlier test's calls still works because both sides are recomputed with the new salt.

## Commands

```bash
# 1. Extraction (read-only, resumable, ~2 h at 6 workers; respects the replica's 5 s statement timeout)
.venv/bin/python -m ml.research.extract all        # or: calls | meetings
# 2. Dataset v4 (features strictly as-of the call, labels, frozen split membership, manifest)
.venv/bin/python -m ml.research.dataset
# 3. Fit candidates on train, tune/select/calibrate on dev only, freeze the bundle
.venv/bin/python -m ml.research.train all        # pre-registered population
.venv/bin/python -m ml.research.train channel    # CSDMERP/MERP (train-only rule), outputs models/channel/
# 4. One-shot sealed final test (writes test-lock.json; a second run requires --exploratory)
.venv/bin/python -m ml.research.evaluate all
.venv/bin/python -m ml.research.evaluate channel
# 4b. Post-lock exploratory timing intervals (within-seller hour concordance)
.venv/bin/python -m ml.research.analyze_timing all
.venv/bin/python -m ml.research.analyze_timing channel
# 5. JS (lib/best-time-experiments.ts) vs Python scoring parity for clock artifacts
node scripts/btc-research-parity.cjs
# 6. Checks
.venv/bin/python -I tests/research_v4_checks.py && node --test tests/research-v4.test.cjs
```

## Outputs (`.data/btc-research-v4/`)

| Path | Content |
|---|---|
| `raw/calls/<date>/<block>.json.gz` | Outbound calls for the 8% seller sample, in 30-minute entry blocks |
| `raw/meetings/<date>/<parts>-<part>.json.gz` | Meetings for sampled sellers, split by company id when a date would exceed the timeout |
| `dataset/examples.parquet` | Train and dev examples |
| `dataset/test-sealed.parquet` | Final-test examples. Opened only by `evaluate.py` after the freeze. |
| `dataset/manifest.json` | Provenance, exclusions, per-split counts (test outcomes are not counted), file hashes, split-membership hash |
| `models/frozen-candidates.pkl` | Fitted models and dev-fitted calibrators |
| `models/freeze.json` | Bundle hash, data hashes, selection, environment |
| `models/dev-report.json` | Dev metrics for every candidate, plus fit and inference costs |
| `models/test-lock.json` | Records when the final test was first opened |
| `models/test-results.json` | Aggregate final-test results. No identifiers. |
| `models/hour-day-app-export.json` | Retrained hour_day model in the app's experimental schema. For parity checks only, never installed. |
| `models/parity.json` | JS/Python parity results |

The committed aggregate copies of these results are in `docs/best-time-to-call/research-v4/results.json`.
