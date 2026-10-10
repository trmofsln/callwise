"""One-shot final-test evaluation of the frozen research-v4 candidates.

Refuses to run unless ``models/freeze.json`` matches the pickled bundle, and refuses a second
confirmatory run once ``models/test-lock.json`` exists (``--exploratory`` re-runs are labelled
as such). Writes aggregate, non-identifying results to ``models/test-results.json``.

Usage: ``python -m ml.research.evaluate [all|channel] [--exploratory]``
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import pickle
import sys

import numpy as np
import pandas as pd

from ml.research import metrics
from ml.research.dataset import OUT as DATA
from ml.research.train import PRIMARY, output_dir, population_frame

POLICY_HOURS = list(range(10, 18))
TOP_SLOTS = 4  # app maxSlotsPerDay default


def policy_agreement(model, test: pd.DataFrame, y: np.ndarray, reps: int = 300, seed: int = 20261010) -> dict:
    """Exploratory, associational: proxy rate of calls placed in a model's top-4 business hours
    for that seller and day versus calls placed in other business hours. Hour-dependent features
    (clock, same-hour 7-day history) are recomputed per candidate hour; others stay as observed."""
    inside = test["hour"].isin(POLICY_HOURS).to_numpy()
    base = test[inside].reset_index(drop=True)
    yy = y[inside]
    grid = np.zeros((len(base), len(POLICY_HOURS)))
    for j, h in enumerate(POLICY_HOURS):
        cf = base.copy()
        cf["hour"] = h
        cf["calls_same_hour_7d"] = base[f"calls_h{h}_7d"]
        cf["answered_same_hour_7d"] = base[f"answered_h{h}_7d"]
        grid[:, j] = model.predict(cf)
    # rank with earliest-hour tie-break, as the app sorts by score then start time
    order = np.lexsort((np.tile(np.arange(len(POLICY_HOURS)), (len(base), 1)), -grid), axis=1)
    top = np.zeros_like(grid, dtype=bool)
    np.put_along_axis(top, order[:, :TOP_SLOTS], True, axis=1)
    actual = base["hour"].map({h: j for j, h in enumerate(POLICY_HOURS)}).to_numpy()
    in_top = top[np.arange(len(base)), actual]
    sellers = base["seller_key"].to_numpy()
    _, inv = np.unique(sellers, return_inverse=True)
    rng = np.random.default_rng(seed)
    k = inv.max() + 1

    def rates(w):
        a = np.sum(w * yy * in_top) / max(np.sum(w * in_top), 1e-12)
        b = np.sum(w * yy * ~in_top) / max(np.sum(w * ~in_top), 1e-12)
        return a, b

    point = rates(np.ones(len(base)))
    diffs = []
    for _ in range(reps):
        w = rng.multinomial(k, np.full(k, 1 / k)).astype(float)[inv]
        a, b = rates(w)
        diffs.append(a - b)
    return {"calls_in_business_hours": int(len(base)), "calls_in_top4": int(in_top.sum()),
            "positives_in_top4": int(yy[in_top].sum()), "positives_outside": int(yy[~in_top].sum()),
            "rate_in_top4": point[0], "rate_outside": point[1], "rate_difference": point[0] - point[1],
            "rate_difference_ci95": [float(np.quantile(diffs, 0.025)), float(np.quantile(diffs, 0.975))],
            "interpretation": "association only; calls were not randomized to hours"}


HALVES = {"first_half": ("2026-09-14", "2026-09-19"), "second_half": ("2026-09-20", "2026-09-25")}


def verdict(cmp: dict, halves: dict, cohorts: dict, concordance: tuple[float, float], cost: dict) -> dict:
    ci_ap, ci_ll = cmp["intervals_95"]["ap"], cmp["intervals_95"]["log_loss"]
    checks = {
        "ap_gain_ge_10pct_and_ci_above_0": bool(cmp["ap_relative"] is not None and cmp["ap_relative"] >= 0.10 and ci_ap and ci_ap[0] > 0),
        "log_loss_ci_upper_le_0": bool(ci_ll and ci_ll[1] <= 0),
        "same_direction_both_halves": all((h or 0) > 0 for h in halves.values()),
        "not_worse_in_supported_cohorts": all(v >= 0 for v in cohorts.values()),
        "within_seller_concordance_not_lower_by_0.02": concordance[0] is None or concordance[1] is None or concordance[0] >= concordance[1] - 0.02,
        "operational_cost_ok": cost["ok"],
    }
    if all(checks.values()):
        label = "convincingly_improved"
    elif (ci_ap and ci_ap[1] < 0) or (ci_ll and ci_ll[0] > 0):
        label = "worse"
    elif (cmp["ap_difference"] or 0) > 0 and cmp["log_loss_difference"] <= 0:
        label = "promising"
    else:
        label = "inconclusive"
    return {"label": label, "checks": checks}


def main() -> None:
    exploratory = "--exploratory" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    population = args[0] if args else "all"
    MODELS = output_dir(population)
    lock_path = MODELS / "test-lock.json"
    if lock_path.exists() and not exploratory:
        raise SystemExit("Final test already consulted; rerun with --exploratory (results labelled exploratory).")
    freeze = json.loads((MODELS / "freeze.json").read_text())
    bundle_bytes = (MODELS / "frozen-candidates.pkl").read_bytes()
    if hashlib.sha256(bundle_bytes).hexdigest() != freeze["bundle_sha256"]:
        raise SystemExit("Frozen bundle hash mismatch.")
    test_file = DATA / "test-sealed.parquet"
    if hashlib.sha256(test_file.read_bytes()).hexdigest() != freeze["dataset_files"]["test-sealed.parquet"]:
        raise SystemExit("Sealed test file hash mismatch.")
    if not exploratory:
        lock_path.write_text(json.dumps({"opened_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                                         "bundle_sha256": freeze["bundle_sha256"]}))
    bundle = pickle.loads(bundle_bytes)
    test = population_frame(pd.read_parquet(test_file), population).reset_index(drop=True)
    y = test[PRIMARY].to_numpy()
    sellers, hours = test["seller_key"].to_numpy(), test["hour"].to_numpy()

    scores = {"F0_frozen_general_erp": bundle["frozen_general"]["pooled"].predict(test)}
    unsupported_f0 = bundle["frozen_general"]["pooled"].unsupported
    scores["F0_frozen_global_prior_backoff"] = bundle["frozen_general"]["global"].predict(test)
    raw = {}
    for name, model in bundle["models"].items():
        raw[name] = model.predict(test)
        scores[name + "+platt"] = bundle["calibrators"][name](raw[name])
    selected, b1 = bundle["selected"] + "+platt", bundle["b1"] + "+platt"

    def block(mask: np.ndarray) -> dict:
        return {name: metrics.summary(s[mask], y[mask]) for name, s in scores.items()}

    results = {
        "exploratory": exploratory, "population": population, "evaluated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "freeze": {k: freeze[k] for k in ("bundle_sha256", "code_revision", "selected", "retrained_baseline", "split_membership_sha256")},
        "primary_target": "observed_linked_physical_recorded_met_within14days",
        "label_kind": "proxy (not canonical meeting_done)",
        "overall": block(np.ones(len(test), bool)),
        "raw_uncalibrated": {n: metrics.summary(s, y) for n, s in raw.items()},
        "frozen_model_unsupported_rows": unsupported_f0,
        "by_cohort": {c: block((test["cohort"] == c).to_numpy()) for c in sorted(test["cohort"].unique())},
        "by_half": {h: block(test["date"].between(*r).to_numpy()) for h, r in HALVES.items()},
        "by_weekday": {int(d): {n: metrics.summary(scores[n][m], y[m]) for n in ("F0_frozen_general_erp", b1, selected)}
                       for d in sorted(test["weekday"].unique()) for m in [(test["weekday"] == d).to_numpy()]},
        "by_module_group": {g: {n: metrics.summary(scores[n][m], y[m]) for n in ("F0_frozen_general_erp", b1, selected)}
                            for g in test["module_group"].value_counts().index[:8] for m in [(test["module_group"] == g).to_numpy()]},
    }
    frozen_bins = bundle["frozen_general"]["pooled"].model["smoothing"]["bins"]
    slot_supported = np.array([frozen_bins.get(f"{d}:{h}", {"count": 0})["count"] >= 5 for d, h in zip(test["weekday"], test["hour"])])
    results["by_frozen_slot_support"] = {"weekday_hour_bin_supported": block(slot_supported),
                                         "pooled_or_unsupported": block(~slot_supported)}
    results["within_seller_hour_concordance"] = {n: metrics.within_seller_concordance(s, y, sellers, hours) for n, s in scores.items()}
    results["reliability"] = {n: metrics.reliability(scores[n], y) for n in ("F0_frozen_general_erp", b1, selected)}

    comparisons = [(selected, b1), (selected, "F0_frozen_general_erp"), (b1, "F0_frozen_general_erp")]
    comparisons += [(n + "+platt", b1) for n in sorted(set(freeze["best_by_family"].values()) | set(freeze["ablation_ladder"].values()))
                    if n + "+platt" not in (selected, b1)]
    comparisons = list(dict.fromkeys(comparisons))
    results["paired"] = metrics.paired_bootstrap(scores, y, sellers, comparisons)

    def ap(name, mask):
        return metrics.Ranked(scores[name][mask], y[mask]).average_precision()

    half_diff = {}
    for h, r in HALVES.items():
        m = test["date"].between(*r).to_numpy()
        a, b = ap(selected, m), ap(b1, m)
        half_diff[h] = None if a is None or b is None else a - b
    cohort_diff = {}
    for c in test["cohort"].unique():
        m = (test["cohort"] == c).to_numpy()
        if y[m].sum() >= 30:
            cohort_diff[c] = ap(selected, m) - ap(b1, m)
    dev_report = json.loads((MODELS / "dev-report.json").read_text())["candidates"]
    cost = dev_report.get(bundle["selected"], {})
    conc = results["within_seller_hour_concordance"]
    results["promotion"] = {
        "comparison": f"{selected} vs {b1}",
        "half_ap_differences": half_diff, "cohort_ap_differences_ge30_positives": cohort_diff,
        **verdict(results["paired"][f"{selected}-vs-{b1}"], half_diff, cohort_diff,
                  (conc[selected]["concordance"], conc[b1]["concordance"]),
                  {"ok": (cost.get("predict_us_per_row") or 0) < 1000, "predict_us_per_row": cost.get("predict_us_per_row")}),
        "note": "JS inference and artifact-size checks apply only if an app export exists for the selected family.",
    }
    secondary = {}
    for target, pair in bundle["secondary"].items():
        ys = test[target].to_numpy()
        secondary[target] = {name: {"overall": metrics.summary(v["calibrator"](v["model"].predict(test)), ys),
                                    "by_cohort": {c: metrics.summary(v["calibrator"](v["model"].predict(test[m]))[:], ys[m.to_numpy()])
                                                  for c in sorted(test["cohort"].unique()) for m in [test["cohort"] == c]}}
                             for name, v in pair.items()}
    results["secondary_targets"] = secondary
    policy_models = {"F0_frozen_general_erp": bundle["frozen_general"]["pooled"], b1: bundle["models"][bundle["b1"]],
                     selected: bundle["models"][bundle["selected"]]}
    for name in bundle["models"]:
        if name.startswith(("B2_", "H1_")):
            policy_models[name + "+platt"] = bundle["models"][name]
    results["policy_agreement_exploratory"] = {n: policy_agreement(m, test, y) for n, m in policy_models.items()}
    out = MODELS / ("test-results-exploratory.json" if exploratory else "test-results.json")
    out.write_text(json.dumps(results, indent=1, default=metrics.safe))
    print(json.dumps({"promotion": results["promotion"], "paired": results["paired"]}, indent=1, default=metrics.safe)[:6000])


if __name__ == "__main__":
    main()
