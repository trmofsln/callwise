# Research v4: model families, sources and rationale

Each candidate below is tied to the data constraints measured in `sources-and-feasibility.md`. Those constraints are:

- call history exists only from 2026-08-11;
- the outcome is a rare proxy event (prior estimate about 0.35% of calls);
- there are no randomized or propensity-logged scheduling actions;
- historical seller attributes are not available as-of the call;
- the replica enforces a 5 s query budget.

## Selected for evaluation

| Family | Why it fits these data | Primary sources |
|---|---|---|
| Population rate; smoothed weekday×hour (current baseline family) | Transparent and cheap. It is the same family as the frozen general model, so retraining it on the new data separates gains from new data from gains due to modelling. | Existing implementation (`ml/cold_start/models.py`, `lib/best-time-experiments.ts`) |
| Personal history (answer rate at this hour, shrunk to the population) | Telephone-survey work shows household-specific contact propensities beat average best times. Brick et al. (1996) used logistic models of time of day, day of week and lag. Greenberg & Stokes (1990) chose the next call time from prior-call history. | Wagner, *Improving the efficiency of telephone surveys…* (FCSM 2009) [link](https://www.fcsm.gov/assets/files/docs/2009FCSM_Wagner_IV-C.pdf) ; Greenberg & Stokes, *J. Official Statistics* 6(4), 1990 |
| Hierarchical / partial pooling (empirical-Bayes beta-binomial over hour → weekday×hour → channel×weekday×hour; ridge seller random intercept) | Sparse cells need shrinkage toward supported parents. The ridge seller intercept is a MAP approximation of a Gaussian random effect, and unseen sellers get 0. | Efron & Morris, *JASA* 70(350), 1975 ; Gelman & Hill, *Data Analysis Using Regression and Multilevel/Hierarchical Models*, 2007 |
| L2-regularized logistic regression (clock → +context → +history ablation ladder) | Has few effective parameters per positive event, gives well-behaved probabilities, and needs no unverifiable metadata. | Hastie, Tibshirani & Friedman, *Elements of Statistical Learning*, 2nd ed., ch. 4 |
| Gradient-boosted trees (LightGBM) | Positive support (hundreds of events per split in the 8% sample) and numeric history features justify one bounded nonlinear candidate. The tuning grid has at most 3 configurations per feature set, with early stopping on dev. | Ke et al., *LightGBM*, NeurIPS 2017 |
| Two-stage answer × conversion | Answer events are about 2 orders of magnitude more common than meeting events. The product is **not** assumed to be calibrated: it is recalibrated on dev before any comparison. | Niculescu-Mizil & Caruana, *Predicting good probabilities with supervised learning*, ICML 2005 |
| Platt calibration (dev-fitted, test-evaluated) | Uses the same form as the frozen model, so calibration effects are comparable. | Platt, *Probabilistic outputs for SVMs*, 1999 ; Niculescu-Mizil & Caruana 2005 |

## Evaluation choices

- **AP and prevalence as headline metrics.** For rare outcomes the precision–recall view is more informative than ROC. Source: Saito & Rehmsmeier, *PLOS ONE* 10(3): e0118432, 2015.
- **Chronological splits, a maturity embargo, and seller-cluster resampling.** These guard against temporal and grouped dependence. Sources: Roberts et al., *Ecography* 40:913–929, 2017; Field & Welsh, *JRSS-B* 69(3), 2007.
- **Leakage controls.** Features use only as-of event and recording times; current-call outcomes are excluded. Source: Kaufman et al., *Leakage in data mining*, ACM TKDD 6(4), 2012.

## Considered and excluded (with evidence)

- **CatBoost.**
  - It duplicates the tree-family question already answered with LightGBM.
  - The categorical cardinality here is small (12 module groups plus a few context codes).
  - Excluded to bound tuning. Source: Prokhorenkova et al., NeurIPS 2018.
- **Survival / hazard models for retry timing.**
  - Retry sequences have no identity: there is no lead or retry chain id, and seller grouping is synthetic.
  - Censoring before 2026-08-11 is unknown.
  - The retry delays in the app are labelled `unverified_keep_for_pilot`.
  - Not estimable without a sequence key. Source: Singer & Willett, *J. Educational Statistics* 18(2), 1993 (discrete-time hazards).
- **Contextual bandits and off-policy evaluation.**
  - Off-policy estimators such as IPS and doubly robust need logged action propensities and overlap. Call times are chosen by employees and were never logged with propensities.
  - A retrospective "optimal schedule" claim is therefore not identifiable.
  - These are proposed for a prospective randomized pilot instead.
  - Sources: Dudík, Langford & Li, *Doubly Robust Policy Evaluation and Learning*, ICML 2011 ([arXiv:1103.4601](https://www.arxiv.org/abs/1103.4601)); Li et al., WWW 2010.
- **Uplift / meta-learners.** Same reason: there is no randomized treatment and no validated propensity model. Source: Künzel et al., *PNAS* 116(10), 2019.
- **Customer embeddings and raw ID features.** They do not transfer to unseen sellers and would memorize the cluster sample. Seller ids are used only for grouping and for the ridge random intercept, which is 0 for unseen sellers.
- **Seller metadata** (city, industry, segment, account age). There is no as-of history (snapshot only), so using these fields would leak later values.

## Other related work found but not relied on

- An IBM patent on per-customer contact scoring.
- A UC Berkeley/6sense student project.
- A UCP master's thesis (NOS, decision trees and boosting).

These are vendor or grey literature, listed for context only. Links: [patent US9118764](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9118764), [Berkeley DataX](https://datax.berkeley.edu/projects/6sense-newly-launched-predictive-model-for-scheduling-outbound-calls/), [UCP thesis](https://ciencia.ucp.pt/en/studentTheses/timing-is-everything/).
