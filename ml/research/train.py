"""Fit, tune (dev only), select, calibrate and freeze research-v4 candidates.

Reads only ``dataset/examples.parquet`` (train + dev). The sealed test file is never opened
here. Writes ``.data/btc-research-v4/models/`` (pickles, dev report, freeze manifest) and an
app-schema export of the retrained hour_day baseline for JS/Python parity checks.

Usage: ``python -m ml.research.train [all|channel]``

``all`` is the pre-registered population (every eligible call). ``channel`` restricts train,
dev and test to the calling modules whose *train-split* proxy rate is at least 1%
(``CHANNEL_MODULES``), where a UCID-attributed meeting can actually occur; outputs go to
``models/channel/``.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import pickle
import platform
import subprocess
import time
from pathlib import Path

import numpy as np
import pandas as pd

from ml.research import metrics
from ml.research.dataset import OUT as DATA
from ml.research.models import (Boosted, Constant, FrozenGeneral, HourDay, Logistic, NestedPooling,
                                PersonalAnswer, Platt, SellerEffects, TwoStage)
from ml.research.redash_client import ROOT

MODELS = ROOT / ".data" / "btc-research-v4" / "models"
FROZEN = ROOT / ".data" / "btc-operational-v3" / "models" / "general_erp" / "model.json"
PRIMARY = "y_physical"
CHANNEL_MODULES = ["CSDMERP", "MERP"]  # train-only rule: module proxy rate >= 1% on the train split


def population_frame(data: pd.DataFrame, population: str) -> pd.DataFrame:
    if population == "all":
        return data
    if population == "channel":
        return data[data["module"].isin(CHANNEL_MODULES)]
    raise SystemExit(f"unknown population {population}")


def output_dir(population: str) -> Path:
    return MODELS if population == "all" else MODELS / population
SECONDARY = ["y_any_mode", "y_answered", "y_answered_60s"]
SIMPLICITY = {"B": 0, "H": 1, "L": 2, "G": 3, "T": 4}
GBM_GRID = [
    {"num_leaves": 7, "min_child_samples": 400, "learning_rate": 0.03},
    {"num_leaves": 15, "min_child_samples": 200, "learning_rate": 0.03},
    {"num_leaves": 31, "min_child_samples": 100, "learning_rate": 0.03, "reg_lambda": 10.0},
]


def candidates() -> list:
    out: list = [Constant()]
    out += [HourDay(s) for s in (5, 20, 80)]
    out += [PersonalAnswer(k) for k in (2, 5, 10)]
    out += [NestedPooling(s) for s in ((20, 20, 50), (20, 50, 100), (10, 20, 20), (50, 50, 200))]
    out += [Logistic(fs, C) for fs in ("clock", "clock_context", "clock_history", "full") for C in (0.01, 0.1, 1.0)]
    out += [SellerEffects(0.1, scale) for scale in (0.3, 1.0)]
    out += [Boosted(fs, dict(p), label=f"_cfg{i}") for fs in ("clock", "clock_context", "clock_history", "full")
            for i, p in enumerate(GBM_GRID)]
    out += [TwoStage("full")]
    return out


def fit(model, train, y, dev, y_dev):
    if isinstance(model, (Boosted, TwoStage)):
        return model.fit(train, y, (dev, y_dev))
    return model.fit(train, y)


def git_revision() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    except Exception:  # noqa: BLE001
        return "unknown"


def versions() -> dict:
    import lightgbm, scipy, sklearn
    return {"python": platform.python_version(), "numpy": np.__version__, "pandas": pd.__version__,
            "scikit-learn": sklearn.__version__, "lightgbm": lightgbm.__version__, "scipy": scipy.__version__,
            "platform": platform.platform()}


def main() -> None:
    import sys
    population = sys.argv[1] if len(sys.argv) > 1 else "all"
    out = output_dir(population)
    out.mkdir(parents=True, exist_ok=True)
    data = population_frame(pd.read_parquet(DATA / "examples.parquet"), population)
    assert set(data["split"]) <= {"train", "dev"}, "sealed test rows must not be present"
    train, dev = data[data["split"] == "train"].reset_index(drop=True), data[data["split"] == "dev"].reset_index(drop=True)
    y, y_dev = train[PRIMARY].to_numpy(), dev[PRIMARY].to_numpy()
    print(f"train {len(train)} rows / {y.sum()} positives; dev {len(dev)} rows / {y_dev.sum()} positives", flush=True)

    report, fitted = {}, {}
    frozen = FrozenGeneral(FROZEN)
    for model in [frozen, FrozenGeneral(FROZEN, pool_hours=False), *candidates()]:
        started = time.time()
        fit(model, train, y, dev, y_dev)
        fit_seconds = time.time() - started
        started = time.time()
        scores = model.predict(dev)
        per_row_us = (time.time() - started) / max(len(dev), 1) * 1e6
        entry = metrics.summary(scores, y_dev)
        entry.update({"fit_seconds": round(fit_seconds, 2), "predict_us_per_row": round(per_row_us, 3)})
        if isinstance(model, FrozenGeneral):
            entry["unsupported_cells_rows"] = model.unsupported
        if isinstance(model, Boosted):
            entry["best_iteration"] = model.best_iteration
        report[model.name] = entry
        fitted[model.name] = model
        print(f"{model.name:55s} AP={entry['average_precision']:.5f} AUC={entry['roc_auc']:.4f} "
              f"LL={entry['log_loss']:.5f} ({fit_seconds:.1f}s)", flush=True)

    # Selection rule (pre-registered): best dev log loss, AP >= 0.95 x best B1 AP, simplicity tie-break.
    b1 = max((n for n in report if n.startswith("B1_")), key=lambda n: (-report[n]["log_loss"]))
    ap_floor = 0.95 * report[b1]["average_precision"]
    eligible = [n for n in report if n[0] in SIMPLICITY and not n.startswith("B0")
                and (report[n]["average_precision"] or 0) >= ap_floor]
    selected = min(eligible, key=lambda n: (round(report[n]["log_loss"], 6), SIMPLICITY[n[0]]))
    best_by_family = {}
    for name in report:
        family = name.split("_")[0]
        if family in ("B0", "F0"):
            continue
        if family not in best_by_family or report[name]["log_loss"] < report[best_by_family[family]]["log_loss"]:
            best_by_family[family] = name
    # Ablation ladder: best configuration per feature set for L1 and G1.
    ladder = {}
    for prefix, suffix in (("L1_logistic_", "_C"), ("G1_lightgbm_", "_cfg")):
        for fs in ("clock", "clock_context", "clock_history", "full"):
            names = [n for n in report if n.startswith(prefix + fs + suffix)]
            if names:
                ladder[f"{prefix}{fs}"] = min(names, key=lambda n: report[n]["log_loss"])

    # Platt calibration fitted on dev for every frozen comparator (dev-fitted, test-evaluated).
    frozen_set = sorted({selected, b1, *best_by_family.values(), *ladder.values()})
    calibrators = {}
    for name in frozen_set:
        calibrators[name] = Platt().fit(fitted[name].predict(dev), y_dev)

    # Secondary targets: retrained baseline B1 vs the selected family's configuration.
    secondary = {}
    for target in SECONDARY:
        ys, yd = train[target].to_numpy(), dev[target].to_numpy()
        pair = {}
        for model in (HourDay(fitted[b1].strength), Logistic("full", 0.1), Boosted("full", dict(GBM_GRID[1]), label="_cfg1")):
            fit(model, train, ys, dev, yd)
            pair[model.name] = {"model": model, "calibrator": Platt().fit(model.predict(dev), yd),
                                "dev": metrics.summary(model.predict(dev), yd)}
        secondary[target] = pair

    bundle = {"selected": selected, "b1": b1, "frozen_set": frozen_set,
              "models": {n: fitted[n] for n in frozen_set}, "calibrators": calibrators,
              "frozen_general": {"pooled": frozen, "global": fitted["F0_frozen_general_erp_global_prior_backoff"]},
              "secondary": secondary}
    bundle_path = out / "frozen-candidates.pkl"
    bundle_path.write_bytes(pickle.dumps(bundle))
    manifest = json.loads((DATA / "manifest.json").read_text())
    freeze = {
        "frozen_at": dt.datetime.now(dt.timezone.utc).isoformat(), "code_revision": git_revision(),
        "population": population, "channel_modules": CHANNEL_MODULES if population == "channel" else None,
        "versions": versions(), "seed": 1729, "primary_target": PRIMARY,
        "dataset_files": manifest["files"], "split_membership_sha256": manifest["split_membership_sha256"],
        "bundle_sha256": hashlib.sha256(bundle_path.read_bytes()).hexdigest(),
        "selected": selected, "retrained_baseline": b1, "frozen_set": frozen_set,
        "selection_rule": "min dev log loss among B/H/L/G/T with dev AP >= 0.95 x selected B1 AP; simplicity tie-break",
        "ap_floor": ap_floor, "best_by_family": best_by_family, "ablation_ladder": ladder,
        "calibration": {n: {"kind": "platt", "fitted_on": "dev", "slope": c.slope, "intercept": c.intercept} for n, c in calibrators.items()},
        "deployment": {"approved": False, "reason": "offline research candidate; proxy target; association only"},
    }
    (out / "freeze.json").write_text(json.dumps(freeze, indent=2))
    (out / "dev-report.json").write_text(json.dumps({"train_rows": len(train), "train_positives": int(y.sum()),
                                                        "dev_rows": len(dev), "dev_positives": int(y_dev.sum()),
                                                        "candidates": report,
                                                        "secondary_dev": {t: {n: v["dev"] for n, v in p.items()} for t, p in secondary.items()}},
                                                       indent=2, default=metrics.safe))
    export_hour_day(fitted[b1], calibrators[b1], manifest, out)
    print(json.dumps({k: freeze[k] for k in ("selected", "retrained_baseline", "best_by_family", "ablation_ladder")}, indent=1))


def export_hour_day(model: HourDay, calibrator: Platt, manifest: dict, out: Path) -> None:
    """App-schema artifact (scoreExperimentalClock) for parity checks only; never installed."""
    artifact = {
        "schema_version": 1, "experimental": True, "label_kind": "proxy",
        "trained_target": "observed_linked_physical_recorded_met_within14days",
        "deployment": {"approved": False, "reason": "research-v4 parity export; not for installation"},
        "route": "erp_outbound_observed_proxy", "model_version": f"research-v4-{model.name}",
        "dataset_sha256": manifest["files"]["examples.parquet"], "timezone": "Asia/Kolkata", "family": "hour_day",
        "evidence": {"training_attempts": model.global_["count"], "training_positives": model.global_["positive"]},
        "smoothing": model.artifact_smoothing(),
        "feature_schema": {"feature_names": ["hour_sin", "hour_cos", *[f"weekday_{i}" for i in range(7)]]},
        "logistic": None,
        "calibration": {"calibrated": True, "kind": "platt", "slope": calibrator.slope, "intercept": calibrator.intercept, "clip": 1e-6},
    }
    (out / "hour-day-app-export.json").write_text(json.dumps(artifact, indent=1))


if __name__ == "__main__":
    main()
