# Acceptance contract

Written before any valid model fitting. Primary outcome is canonical `meeting_done` attributable to an eligible call; PS03's primary `meeting_fixed` is retained only as a secondary measure under the user's override.

The actual pilot has zero eligible canonical labels and zero verified complete histories. A baseline result cannot currently be calculated. A new authoritative, mature-labelled dataset and verified attribution contract are prerequisites to activate these criteria; no acceptance criterion is claimed met.

This paragraph concerns canonical acceptance for the original hotlead pilot. The separate operational recorded-met proxy experiment has actual predictive results and its own preregistered contracts. Before fitting, it tightened rare-event Brier/log-loss tolerances to 5% of the validation baseline with floors of 0.0001/0.001. The general clock model meets those proxy predictive criteria; first-contact support and acceptance fail because its final test has zero positive events. Both artifacts remain unapproved, and the canonical causal-yield goal remains unmeasured. See [current results](results.md).

Predictive comparison uses fixed temporal and seller-disjoint partitions, a horizon/maturity embargo, and independent history/cold-start results. Require at least 100 training rows/10 positives, 30 validation rows/5 positives and 30 final rows/5 positives as minimal guardrails, not sufficient statistical power. Select validation log loss among candidates with no more than 0.01 absolute Brier degradation versus smoothed hour/day. Final test must preserve log loss within 0.02 of baseline, AP at least prevalence, adequate reliability and no material loss in sufficiently large cohorts. A sparse/no-positive cohort returns insufficient support.

Platt calibration needs at least 20 validation positives/20 negatives. No fitting, category vocabulary, imputation or tuning uses final-test outcomes. Freeze hashes/cutoff before final evaluation and atomically lock a single final scoring run. If final evaluation fails, preserve it and retain the defensible baseline; further work needs new development data and a new preregistered test.

The aspirational policy goal is at least 10% relative completed-meeting yield improvement at the same eligible-seller call budget, with a positive seller-cluster 95% confidence-interval lower bound, sound calibration and no material degradation in major adequately sized cohorts. This is assessed only by an identifiable policy comparison/pilot; a retrospective top-budget predictive metric does not satisfy it. The current rule cannot be causally evaluated from this pilot.

Stop bounded search after the criteria are met, after three rounds/30 trials per family plateau, or when valid data/compute prevents defensible progress. Current stopping condition is the external canonical-label and complete-history gap. No automatic production rollout follows any offline result.
