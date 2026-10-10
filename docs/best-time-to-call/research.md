# Model research and experiment plan

Research checked 10 October 2026. The usable pilot contains no verified completed-meeting labels or complete first-contact histories, so the following matrix is implemented/proposed, not measured model performance.

| Candidate | Data fit and compute | Current execution |
| --- | --- | --- |
| Smoothed global hour/day | CPU; compact counts, observed slots only; low-support shrinkage avoids personal optima from one call | Trained in separate ERP proxy experiment; general winner after validation calibration; canonical fitting blocked |
| Cohort hour/day | CPU; time-safe location/industry metadata and rare-category backoff | Cold-start implementation; historical metadata unavailable |
| Regularized logistic | CPU; transparent cyclic time, weekday, verified history/gap and optional first-contact metadata | Actual time-only proxy candidates fitted; scoped first-contact winner; canonical history/metadata fitting blocked |
| CatBoost | CPU tabular categoricals and nonlinear interactions; ordered encoding does not replace temporal isolation | Researched, deferred until valid labels/volume justify another dependency |
| Discrete-time hazard | CPU-sized model can handle delayed outcomes/censoring, but requires event/availability/follow-up evidence | Deferred: completion/verification timing unverified |
| Small embedding MLP / sequence | Additional dependencies/compute; needs sufficiently large clean sequences and a fair simpler baseline | Not warranted by current data |

Logistic implementation follows the penalized binary log-loss family described in the [official scikit-learn linear-model documentation](https://scikit-learn.org/stable/modules/linear_model.html#logistic-regression). Installed Python 3.14.5 has NumPy 2.5.3 and tzdata 2026.4, but no scikit-learn; NumPy/stdlib implementations provide reproducible portable coefficients without changing app dependencies. Cold-start also supports a stdlib fallback. Deterministic gradient fitting uses no sampling; seed 1729 fixes bootstrap draws and seed 42 fixes extraction ordering.

The [CatBoost paper](https://proceedings.neurips.cc/paper/2018/hash/14491b756b3a51daac41c24863285549-Abstract.html) motivates categorical handling and safeguards around target encoding. Its [official installation documentation](https://catboost.ai/docs/en/concepts/python-installation) was checked; no wheel was installed or compatibility empirically asserted. An isolated supported Python environment can be added if categorical support and label volume justify it.

The [discrete-time survival paper](https://arxiv.org/abs/1805.00917) motivates retaining censoring/follow-up information. Current classification excludes immature labels; survival cannot repair unknown event definitions or missing attribution links.

Calibration requires a held-out fitting set. The implementation follows sigmoid calibration principles in [scikit-learn's calibration documentation](https://scikit-learn.org/stable/modules/calibration.html), with at least 20 positive and 20 negative validation labels. Candidate selection precedes calibration; validation is reused, so raw validation results are reported separately and calibrated performance is assessed only on the frozen final test. No resampling changes validation/test prevalence. Class weighting is a future ablation only after representative labels are available; the current logistic objective is unweighted.

[Doubly robust policy evaluation](https://arxiv.org/abs/1103.4601) requires defensible reward/propensity and overlap assumptions. Current data has no known logging propensities and unobserved call windows have no outcomes. Neither scores nor a simulator will be reported as causal lift. A randomized pilot is required.

Bound development to at most 30 trials per family and three improvement rounds; implemented trials remain below this cap. Compare identical datasets/partitions, use validation log loss with a Brier guard, quantify budget yield/AP/AUC and seller-cluster uncertainty, and preserve unsuccessful results. Deep learning or broad boosting searches are not prerequisites when label access is the binding constraint.

The LLM implementation preserves the explicitly requested model. [Official GPT-6 Luna documentation](https://developers.openai.com/api/docs/models/gpt-6-luna), [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling), [structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs), and the live [model catalog](https://openrouter.ai/api/v1/models) informed supported parameters. The catalog supports the requested route; the live authenticated request returned 403. Capability exposure is distinct from account access and numerical ML accuracy.
