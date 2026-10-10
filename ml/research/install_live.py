"""Install the research-v4 retrained hour_day model as the app's general proxy fallback.

Builds ``models/live/models/general_erp/`` (committed, so hosted deployments ship it) in the exact schema that
``lib/best-time-generalized.ts`` and ``lib/best-time-experiments.ts`` verify (model, freeze,
card, held-out test results), from the frozen ``all``-population bundle and its sealed-test
results. The v3 ``cold_start`` experiment is copied unchanged so the Admin report keeps it.
The previous v3 directory is never modified; rollback is ``BTC_EXPERIMENT_DIRECTORY=.data/btc-operational-v3``.

Usage: ``python -m ml.research.install_live``
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import pickle
import shutil

import numpy as np
import pandas as pd

from ml.research import metrics
from ml.research.dataset import OUT as DATA
from ml.research.train import MODELS, PRIMARY

V3 = MODELS.parents[1] / "btc-operational-v3" / "models"
LIVE = MODELS.parents[2] / "models" / "live" / "models"
TARGET = "observed_linked_physical_recorded_met_within14days"


def app_metrics(summary: dict) -> dict:
    return {"attempts": summary["n"], "completed_meetings": summary["positives"],
            "class_prevalence": summary["prevalence"], "average_precision": summary["average_precision"],
            "roc_auc": summary["roc_auc"], "brier": summary["brier"], "log_loss": summary["log_loss"]}


def ap_interval(scores: np.ndarray, y: np.ndarray, sellers: np.ndarray, reps: int = 1000, seed: int = 20261010) -> dict:
    _, inverse = np.unique(sellers, return_inverse=True)
    k = inverse.max() + 1
    rng = np.random.default_rng(seed)
    ranked = metrics.Ranked(scores, y)
    draws = [ranked.average_precision(rng.multinomial(k, np.full(k, 1 / k)).astype(float)[inverse]) for _ in range(reps)]
    return {"lower": float(np.quantile(draws, 0.025)), "upper": float(np.quantile(draws, 0.975)),
            "replicates": reps, "cluster": "seller", "seed": seed}


def main() -> None:
    freeze = json.loads((MODELS / "freeze.json").read_text())
    results = json.loads((MODELS / "test-results.json").read_text())
    if not (MODELS / "test-lock.json").exists() or results.get("exploratory"):
        raise SystemExit("Install requires the confirmatory one-shot test results.")
    bundle_bytes = (MODELS / "frozen-candidates.pkl").read_bytes()
    if hashlib.sha256(bundle_bytes).hexdigest() != freeze["bundle_sha256"]:
        raise SystemExit("Frozen bundle hash mismatch.")
    bundle = pickle.loads(bundle_bytes)
    name = freeze["retrained_baseline"]
    model, calibrator = bundle["models"][name], bundle["calibrators"][name]
    manifest = json.loads((DATA / "manifest.json").read_text())
    dataset_sha = manifest["files"]["examples.parquet"]
    smoothing = model.artifact_smoothing()
    smoothing_sha = hashlib.sha256(json.dumps(smoothing, sort_keys=True).encode()).hexdigest()
    version = f"erp-outbound-observed-proxy-v4-{name.replace('_', '-').lower()}-{smoothing_sha[:8]}"
    artifact = {
        "schema_version": 1, "experimental": True, "label_kind": "proxy", "trained_target": TARGET,
        "primary_target": "meeting_done", "canonical_label_verified": False,
        "deployment": {"approved": False, "reason": "proxy target; installed as the general fallback by explicit user decision on 2026-10-10 against a no-timing-gain finding"},
        "route": "erp_outbound_observed_proxy", "eligibility_policy": "general_erp_observed_proxy",
        "model_version": version, "candidate": name, "dataset_sha256": dataset_sha,
        "split_sha256": manifest["split_membership_sha256"], "timezone": "Asia/Kolkata", "family": "hour_day",
        "evidence": {"training_attempts": smoothing["global"]["count"], "training_positives": smoothing["global"]["positive"],
                     "training_window": manifest["splits"]["train"], "sample": manifest["sample"]},
        "smoothing": smoothing,
        "feature_schema": {"feature_names": ["hour_sin", "hour_cos", *[f"weekday_{i}" for i in range(7)]]},
        "logistic": None,
        "calibration": {"calibrated": True, "kind": "platt", "slope": calibrator.slope, "intercept": calibrator.intercept,
                        "clip": 1e-6, "fitted_split": "dev", "fitted_window": manifest["splits"]["dev"]},
        "history_scope": {"source_ids": [13], "source_tables": ["redash.click_to_call", "redash.sts_dsr_meeting"],
                          "coverage_start": "2026-08-11T00:00:00+05:30", "lifetime_complete": False},
        "environment": freeze["versions"], "code_revision": freeze["code_revision"],
        "trained_at": freeze["frozen_at"],
    }
    target = LIVE / "general_erp"
    target.mkdir(parents=True, exist_ok=True)
    model_bytes = json.dumps(artifact, indent=1).encode()
    (target / "model.json").write_bytes(model_bytes)
    model_sha = hashlib.sha256(model_bytes).hexdigest()

    test = pd.read_parquet(DATA / "test-sealed.parquet").reset_index(drop=True)
    scores = calibrator(model.predict(test))
    y = test[PRIMARY].to_numpy()
    selected = results["overall"][name + "+platt"]
    assert abs(metrics.summary(scores, y)["average_precision"] - selected["average_precision"]) < 1e-12
    baseline = results["overall"]["F0_frozen_general_erp"]
    paired = results["paired"][f"{name}+platt-vs-F0_frozen_general_erp"]
    acceptance = bool(paired["intervals_95"]["ap"][0] > 0 and paired["intervals_95"]["log_loss"][1] < 0)
    test_results = {
        "model_version": version, "model_sha256": model_sha, "trained_target": TARGET, "label_kind": "proxy",
        "experimental": True, "deployment_approved": False, "route": "erp_outbound_observed_proxy",
        "split": {"name": "test", "window": manifest["splits"]["test"], "excluded_prior_published_test_calls": manifest["exclusions"]},
        "evaluated_at": results["evaluated_at"],
        "support_sufficient": bool(selected["positives"] >= 100 and smoothing["global"]["positive"] >= 100),
        "predictive_acceptance_met": acceptance,
        "acceptance_rule": "seller-cluster 95% CI of AP difference vs v3 frozen model > 0 and of log-loss difference < 0 on the same sealed test",
        "selected_metrics": app_metrics(selected),
        "hour_day_baseline_metrics": app_metrics(baseline), "baseline_model": "v3 frozen general_erp (app scoring)",
        "paired_vs_v3": paired,
        "uncertainty": {"intervals": {"average_precision": ap_interval(scores, y, test["seller_key"].to_numpy())}},
        "within_seller_hour_concordance": {"v4": results["within_seller_hour_concordance"][name + "+platt"],
                                           "v3": results["within_seller_hour_concordance"]["F0_frozen_general_erp"]},
        "limitations": ["proxy label, not canonical meeting_done",
                        "no measured timing (within-seller) improvement over v3",
                        "within CSDMERP/MERP channels the retrained table is not better than v3 (see research-v4 decision report)"],
        "policy_lift_measured": False,
    }
    (target / "test-results.json").write_text(json.dumps(test_results, indent=1, default=metrics.safe))
    dev = json.loads((MODELS / "dev-report.json").read_text())["candidates"][name]
    card = {
        "schema_version": 1, "model_version": version, "trained": True, "experimental": True, "label_kind": "proxy",
        "trained_target": TARGET, "deployment_approved": False, "route": "erp_outbound_observed_proxy",
        "family": "hour_day", "selected_candidate": name,
        "training_attempts": smoothing["global"]["count"], "training_proxy_positives": smoothing["global"]["positive"],
        "validation_metrics": app_metrics(dev), "validation_metrics_kind": "dev split, uncalibrated (calibration fitted on dev)",
        "calibration": artifact["calibration"], "frozen_model_sha256": model_sha,
        "support_sufficient": test_results["support_sufficient"], "predictive_acceptance_met": acceptance,
        "limitations": test_results["limitations"],
        "documentation": "docs/best-time-to-call/research-v4/decision-report.md",
    }
    (target / "model-card.json").write_text(json.dumps(card, indent=1, default=metrics.safe))
    (target / "experiments.json").write_text(json.dumps({"selected_candidate": name, "selection": "research-v4 retrained baseline (dev-tuned smoothing strength)",
                                                         "trained_target": TARGET, "label_kind": "proxy"}, indent=1))
    (target / "freeze.json").write_text(json.dumps({"model_sha256": model_sha, "dataset_sha256": dataset_sha,
                                                    "split_sha256": manifest["split_membership_sha256"],
                                                    "frozen_at": freeze["frozen_at"],
                                                    "installed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                                                    "bundle_sha256": freeze["bundle_sha256"]}, indent=1))
    examples = pd.concat([pd.read_parquet(DATA / "examples.parquet", columns=["seller_key", PRIMARY]),
                          test[["seller_key", PRIMARY]]])
    (LIVE.parent / "dataset-manifest.json").write_text(json.dumps({
        "version": manifest["dataset_version"], "as_of": manifest["built_at"], "dataset_sha256": dataset_sha,
        "deduplicated_rows": int(len(examples)), "sellers": int(examples["seller_key"].nunique()),
        "positives": int(examples[PRIMARY].sum()), "label_kind": "proxy", "target_name": TARGET,
        "canonical_label_verified": False, "source_ids": [13], "sample": manifest["sample"],
        "splits": manifest["splits"], "documentation": "docs/best-time-to-call/research-v4/reproduce.md",
    }, indent=1))
    cold = LIVE / "cold_start"
    if cold.exists():
        shutil.rmtree(cold)
    shutil.copytree(V3 / "cold_start", cold)
    print(json.dumps({"installed": str(target), "model_version": version, "model_sha256": model_sha,
                      "support_sufficient": test_results["support_sufficient"], "predictive_acceptance_met": acceptance,
                      "test_ap": selected["average_precision"], "v3_test_ap": baseline["average_precision"]}, indent=1))


if __name__ == "__main__":
    main()
