> Historical pre-training checkpoint; superseded by [current results](results.md).

# Measured results and limits

The app and offline pipelines are implemented and tested. **No completed-meeting model was trained and no held-out ML accuracy or policy lift was measured.** The binding data gap is authoritative `meeting_done` labels, reliable attribution/availability and complete campaign prehistory. Training guards refused the actual data instead of substituting connects or treating missing links as negatives.

The user overrides PS03's primary `meeting_fixed` objective: primary is `meeting_done`; scheduled meetings, connects and calls per meeting remain secondary.

## Actual extraction

Source 13, dedicated persistent query 47566. Fixed before outcomes: 17 dates from 5 May to 23 September 2026; 09, 11, 14 and 16 local-hour buckets; at most 75 hash-ordered rows per bucket. One date had fewer rows. Source timestamps have no timezone; Asia/Kolkata is a recorded assumption. SQL, extraction times and checksums remain in ignored checkpoints.

| Observation | Measured value |
| --- | ---: |
| Raw / distinct attempts | 4,978 / 4,978 |
| Distinct sellers | 4,706 |
| DSR seller-consistent call links | 2,687 |
| Seller-consistent click links | 1,500 |
| `hot_leads_types` matches | 2,381 |
| Linked DSR meetings / proxy positives | 0 / 0 |
| Missing/unknown supplemental proxy outcomes | 2,291 |
| Known canonical primary labels | 0 |
| Verified complete campaign histories | 0 |
| Answered / NotAnswered statuses | 2,630 / 2,348 |
| Metadata accepted as time-safe features | 0 |
| Deduplicated/conflicting-seller UCID rows excluded | 0 / 0 |

The Answered proportion is 52.83% **in this capped sample**, not a representative connect-rate benchmark or completed-meeting improvement. Counts of non-null FK references differ from actual matches. A separate recent 1,000-row linkage audit found 1,000 click matches, 457 DSR matches, 997 lead-type matches and zero observed click/lead seller conflicts; that audit is not a population estimate. Missing older click links suggest coverage/retention differences that need source-owner investigation. Zero linked meetings does not mean zero true completed meetings.

Dataset SHA256: `40fd0e7ba4625cc336e896c1666815d1983b3d4532838b137faa2df8b0517412`.

All eight accessible schema catalogs were checked: 70/55/10/11/8/13/21/4. None exposed `call_master` or exact `meeting_done`/`meeting_fixed` fields. ERP code defines the dashboard proxy, but does not establish canonical equivalence. Warehouse source 8 and daily mart source 10 query attempts returned HTTP 403 despite schema exposure. Source-55/21/13 bounded samples succeeded; mart completion semantics, refresh lag, preference scope and historical metadata remain unverified. A broad ERP meeting/UCID reconciliation query hit the production statement timeout; it was not expanded into an unbounded scan.

## Models and locked evaluation

| Track / candidate | Actual training | Eligible rows | Final PR-AUC / Brier / budget yield | 95% CI / acceptance |
| --- | --- | ---: | --- | --- |
| History hour/day baseline | Blocked | 0 | Unavailable | Unavailable / unmet |
| History logistic + history ablation | Blocked | 0 | Unavailable | Unavailable / unmet |
| Cold-start global/cohort baseline | Blocked | 0 | Unavailable | Unavailable / unmet |
| Cold-start logistic + metadata ablation | Blocked | 0 | Unavailable | Unavailable / unmet |
| 15-minute policy vs new policy | Not identifiable | — | No completed-meeting causal comparison | Unavailable / unmet |

Canonical prevalence, majority-class accuracy, ROC-AUC, completed meetings per 100 attempts, calls per completed meeting and scheduled-meeting diagnostics are null because the labels are unknown. No all-negative classifier or 100%-accuracy headline was manufactured. Synthetic unit-test labels verify implementation and are not research results.

The initial split manifest had an embargo boundary error discovered before model fitting. The immutable corrected `splits-v2.json` excludes 12 August from validation so all assumed 21-day maturity windows precede 2 September. Raw memberships: history 2,278 train / 1,200 validation / 1,187 test; cold-start 2,162 / 1,134 / 1,132. Membership is not eligibility: both actual eligible tracks are 0/0/0. The last 300 observations are also immature under the provisional horizon/grace assumption. The original manifest is retained as blocked audit evidence; **no final test was scored** under either manifest.

The separate untrained model cards are `ml/history-model-card.json` and `ml/cold_start/model-card.json`. Implemented trainers provide bounded development comparisons, rolling temporal validation, train-only preprocessing, validation-fitted Platt calibration, seller-cluster uncertainty, hashes/freeze and an atomic final-test lock. They do not constitute trained artifacts.

## Application and LLM validation

- Existing GLID/activity/Global Context/admin tests remain passing. The new suite verifies labels/joins, as-of leakage, deduplication, split isolation, true-vs-missing first contact, business hours/timezone/DST, cooldown/attempt/DNC/appointment constraints, storage preservation, schema grounding and provider failures.
- Lint, TypeScript and production build passed. Final automated count is recorded in [checklist.md](checklist.md); Python contract checks are included through Node wrappers.
- Production HTTP smoke: authenticated Admin reads/updates, cross-origin rejection, invalid GLID rejection, model health, a real Redash GLID lookup, top-three null-score recommendations, SQLite persistence and matching JSON export passed. Batch `/api/predictions` returned HTTP 200. Its isolated database deliberately has no shared Global Context token, so that smoke's context status is `not_configured`; it does not verify live JWT access.
- An isolated hidden Chrome browser rendered a real lookup and three recommendation rows at desktop/mobile sizes, with no page overflow or console exceptions. Screenshots stay ignored because they contain operational profile details.
- A 14-case **synthetic backend/mocked-provider** evaluation achieved 9/9 backend eligibility agreements, zero constraint violations and 14/14 grounded outputs, covering sparse/zero/failed history, missing metadata, contradictory counts, DNC, missing artifacts, injection, invalid tools/arguments, fabricated scores and provider outage. This is not live GPT-6 accuracy or ML performance. Raw cases/timings are in [routing-evaluation.json](routing-evaluation.json).
- Live OpenRouter catalog: requested `openai/gpt-6-luna` present, tools/structured output/reasoning parameters exposed. Actual authenticated smoke: HTTP 403, zero tool executions, deterministic fallback and no programmatic errors. The latest measured latency is in [evidence-summary.json](evidence-summary.json); returned usage/cost are unavailable, so no live route-agreement or cost figure is claimed.

Current runtime intentionally serves advisory operating-hour windows with insufficient-support status and null probabilities. Invalid/missing data can suppress windows entirely. No trained model is silently substituted, and no automatic rollout occurred.

## Required external evidence

1. Authoritative Redash source/schema/query for `call_master.meeting_done` and `meeting_fixed`, call-link keys, cancellation/completion definitions and attribution/maturity horizon.
2. Complete target-campaign prehistory or verified first-contact coverage; snapshot/CDC availability, call direction/campaign semantics and retention/freshness reconciliation.
3. Production retry configuration, timezone/contact restrictions and operating capacity.
4. OpenRouter account/provider access resolving the observed HTTP 403 without changing the requested model. Source-8/10 query permissions are separately denied.

Until these are supplied, the 10% relative completed-meeting-yield goal is **unmet and unmeasurable**. Keep the current retry rule pending the preregistered randomized pilot in [pilot.md](pilot.md).
