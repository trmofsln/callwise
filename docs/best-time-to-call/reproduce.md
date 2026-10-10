# Reproduce the implementation and audit

Use Node 24+ and Python 3.14.5. This workspace already has NumPy 2.5.3 and tzdata 2026.4; history fitting uses NumPy, cold-start has a stdlib fallback. `.env` retains the existing server keys; do not print it. `.env.example` only has empty secret placeholders. Leave the requested OpenRouter model unchanged.

```powershell
npm ci
npm test
npm run lint
npm run typecheck
npm run build
npm run dev
```

Open `/`, enter comma-separated GLIDs, view Best Time to Call above activity, and download JSON. `/admin` retains existing authentication and adds calling settings/model status. Defaults are explicit operating assumptions. `GET /api/predictions/health` reports healthy service separately from model readiness; `POST /api/predictions` accepts `{ "glids": "123,456" }`.

## Read-only extraction

```powershell
node scripts/btc-audit.cjs schema
node scripts/btc-audit.cjs query ml/sql/schema.sql 13 column-types.json
node scripts/btc-extract.cjs
node scripts/btc-source-check.cjs
```

Extraction creates/reuses only `REDDASH_TRAINING_QUERY_ID` (current run 47566), never an interactive ID. The source-13 plan has fixed dates/hours/seed/caps and checkpoints. Schema refresh visibility does not guarantee query permission. Source-8/10 query attempts currently return 403. The ERP/UCID coverage query is preserved as a timed-out diagnostic and is not a training extraction.

The current normalized dataset and manifests already exist; these commands intentionally refuse to overwrite immutable outputs. For a new extraction, use a new run directory and preregister its source/date/sampling plan rather than modifying the frozen evidence. Existing checkpoints can be resumed when the extraction plan/code is unchanged. For the existing run, the quality/manifests/checksums can be read directly from `.data/best-time-to-call/`.

For a fresh output directory:

Use `node scripts/btc-extract.cjs --output .data/best-time-to-call/new-run` to extract into a separate directory. Resumed checkpoints must match the current query hashes.

```powershell
python -m ml.prepare --raw .data/best-time-to-call/raw --output .data/best-time-to-call/new-preparation
```

The existing blocked v1 manifest remains unchanged. Corrected membership is `.data/best-time-to-call/splits-v2.json`; use that version below. Available-at fields in this pilot are extraction observation bounds, not verified historical availability. Organizer-supplied canonical data must follow the dictionary and reconstruct full verified history using `ml.asof.build_asof_features` before fitting. The pilot's supplemental recording proxy must never be relabelled as canonical.

## Eligibility, training and frozen evaluation

```powershell
python -m ml.history_train audit --splits .data/best-time-to-call/splits-v2.json
python -m ml.retry_audit
python -m ml.history_train train --splits .data/best-time-to-call/splits-v2.json --as-of 2026-10-09T19:20:02.069Z
python -m ml.cold_start.train train --dataset .data/best-time-to-call/attempts.jsonl --splits .data/best-time-to-call/splits-v2.json --output .data/best-time-to-call/cold-start --as-of 2026-10-09T19:20:02.069Z
```

**Training currently refuses this dataset:** canonical labels and full history are unknown. This is the expected measured guard, not a successful training result. No model.json/freeze/final-test score should be fabricated. A separately validated proxy experiment must use `--allow-proxy`, distinct manifests and explicit proxy labels, never change the primary target's scientific interpretation.

Only after valid training produces a frozen artifact:

```powershell
python -m ml.history_train evaluate --splits .data/best-time-to-call/splits-v2.json --as-of 2026-10-09T19:20:02.069Z
python -m ml.cold_start.train evaluate --dataset .data/best-time-to-call/attempts.jsonl --splits .data/best-time-to-call/splits-v2.json --output .data/best-time-to-call/cold-start --as-of 2026-10-09T19:20:02.069Z
```

Reuse exactly the training cutoff, dataset and split hashes. Each final evaluation is locked once; no tuning against final results. Trainers keep deployment unapproved. A reviewed canonical, calibrated artifact satisfying provenance/feature/support checks is required in `BTC_MODEL_DIRECTORY/history_aware.json` or `cold_start.json`. No probability model is currently approved or installed there; cards explain the blocker. Production inference uses portable JSON rather than retraining or invoking Python.

## Provider/contract smoke checks

```powershell
node scripts/btc-smoke.cjs
node scripts/btc-routing-eval.cjs
node scripts/btc-export-evidence.cjs
```

The live provider smoke uses an artificial non-sensitive context and the existing environment key. After the user's reference script identified a second working key, the exhausted monthly-limit key was replaced locally. Luna now performs actual tool calls and passes independent structured grounding checks; the latest measured latency/tokens/cost are in the evidence summary. Routing evaluation uses synthetic contexts/mocked failures, separated from actual provider and ML evidence. Aggregate evidence is stored in SQLite and `docs/best-time-to-call/evidence-summary.json`; seller rows stay ignored.

For local production HTTP/browser QA, start with a **fresh isolated** database filename. Never run the initial-setup harness against `.data/app.sqlite`:

```powershell
$env:SQLITE_DATABASE_PATH='.data/btc-http-smoke-fresh.sqlite'
node node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3102
# In a second terminal:
node scripts/btc-http-smoke.cjs http://localhost:3102
node scripts/btc-browser-smoke.cjs http://localhost:3102
```

The HTTP harness creates a random test admin password only in memory, disables LLM calls in its isolated settings, uses a previously saved GLID for live Redash lookup, and compares returned/saved predictions. Browser QA requires installed Chrome, uses an ignored isolated profile and closes it afterward. Screenshots remain ignored. Stop the temporary server after testing; clear the terminal's SQLITE_DATABASE_PATH override before running the normal app.

Open [presentation.html](presentation.html) for the one-slide handoff; its results are aggregate measured evidence and explicit blockers.

## Actual operational proxy experiment

The original hotlead audit above is preserved. The new experiment uses general ERP employee-associated outbound calls and a **separate** target, `observed_linked_physical_recorded_met_within14days`. It does not fill the canonical `meeting_done` field. Frozen dates have a 14-day attribution embargo; the first-contact subset is seller-disjoint within the current replica's declared observation scope. Only hour and weekday enter the models.

```powershell
$env:BTC_OPERATIONAL_ROOT='.data/btc-operational-v3'
node scripts/btc-operational-v2.cjs extract 80
Remove-Item Env:\BTC_OPERATIONAL_ROOT
python ml/operational_prepare.py --root .data/btc-operational-v3
$btcCutoff = (Get-Content .data/btc-operational-v3/dataset-manifest.json | ConvertFrom-Json).as_of
python -m ml.cold_start.train train --dataset .data/btc-operational-v3/attempts.jsonl --splits .data/btc-operational-v3/splits.json --output .data/btc-operational-v3/models/general_erp --as-of $btcCutoff --allow-proxy --general-erp-proxy --proxy-target observed_linked_physical_recorded_met_within14days
python -m ml.cold_start.train train --dataset .data/btc-operational-v3/attempts.jsonl --splits .data/btc-operational-v3/splits.json --output .data/btc-operational-v3/models/cold_start --as-of $btcCutoff --allow-proxy --observed-first-contact-proxy --proxy-target observed_linked_physical_recorded_met_within14days
```

For each model, run the same command with `evaluate` replacing `train` **once after its pipeline freezes**. Existing frozen model directories and final-test locks refuse a second fit/evaluation; use new preregistered development data for later improvements. Source checkpoints preserve exact query hashes and dataset/split hashes. These artifacts stay unapproved, and canonical API probabilities remain null.

`GET /api/admin/experiments` requires the existing Admin session. `/admin` shows aggregate extraction counts, selected/baseline final metrics, bootstrap intervals, and a supported-slot numerical preview of the frozen proxy model. The preview has no seller eligibility claim and never enters the canonical recommendation registry. `node scripts/btc-export-evidence.cjs` persists sanitized experiment/model metadata to SQLite.

The normal server uses the existing `.data/app.sqlite`:

```powershell
npm run build
npm run start -- --hostname 127.0.0.1 --port 3000
```

For a fresh isolated QA server, set a new `SQLITE_DATABASE_PATH`, start on 3102, and run `$env:BTC_BROWSER_QA='1'; node scripts/btc-http-smoke.cjs http://127.0.0.1:3102`. The cookie passes only in memory to the hidden browser. This captures home, real lookup, mobile, and authenticated experiment screenshots under `.data/best-time-to-call/`.


## Personal history correction

The live engine uses seller-linked ERP meeting and answered-call counts by local hour, with a documented short-call penalty and the trained general proxy model as the fallback for inconclusive or new sellers. It preserves null canonical probabilities and caps alternatives at maxSlotsPerDay (3 or 4). See [personal-ranking.md](personal-ranking.md).

For the supplied regression seller, set BTC_SAMPLE_GLID=204563657 in the QA terminal before the HTTP/browser commands. Use a fresh isolated database for the HTTP setup harness. The main server's live response, actual Luna review and slot evidence are saved under ignored .data/best-time-to-call/personal-ranking-live.json. Home, desktop, mobile, full mobile calling-plan and authenticated Admin screenshots are also ignored. No new training or repeat locked-test evaluation was needed for this routing correction.
