"""History-aware offline development and one-time frozen-test evaluation."""
from __future__ import annotations
import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
from zoneinfo import ZoneInfo
import numpy as np
from .cold_start.contract import instant, load_rows
from .cold_start.metrics import evaluate, bootstrap, cohort_metrics
from .cold_start.models import fit_smoothing


FEATURES = ["hour_sin", "hour_cos"] + [f"weekday_{day}" for day in range(7)] + ["prior_attempts_log1p", "retry_gap_log1p", "retry_gap_missing"]


def features(row: dict, zone: str) -> list[float]:
    at = instant(row["call_at"]).astimezone(ZoneInfo(zone))
    hour = at.hour + at.minute / 60
    prior = row.get("prior_attempts", 0)
    gap = row.get("prior_retry_gap_minutes")
    return [math.sin(2 * math.pi * hour / 24), math.cos(2 * math.pi * hour / 24)] + [float(at.weekday() == day) for day in range(7)] + [math.log1p(min(prior, 100)) / math.log(101), math.log1p(min(max(gap or 0, 0), 10080)) / math.log(10081), float(gap is None)]


def eligible(rows: list[dict], as_of: str, allow_proxy: bool) -> tuple[list[dict], dict]:
    cutoff = instant(as_of)
    result, reasons = [], Counter()
    for row in rows:
        problems = []
        target = row.get("target") or {}
        if row.get("history_complete") is not True:
            problems.append("unverified_complete_history")
        if not isinstance(row.get("prior_attempts"), (int, float)) or isinstance(row.get("prior_attempts"), bool) or row["prior_attempts"] < 1:
            problems.append("missing_prior_history")
        if target.get("meeting_done") not in (0, 1) or isinstance(target.get("meeting_done"), bool):
            problems.append("unknown_completed_meeting_label")
        if target.get("label_kind") != "canonical" and not (allow_proxy and target.get("label_kind") == "proxy"):
            problems.append("unverified_label_contract")
        try:
            call, maturity, available = instant(row["call_at"]), instant(target["mature_at"]), instant(row["available_at"])
            if call >= cutoff or maturity > cutoff or available > cutoff:
                problems.append("future_or_immature_observation")
            if maturity < call:
                problems.append("invalid_maturity")
            if target.get("meeting_done") == 1 and not call <= instant(target["completion_at"]) <= maturity:
                problems.append("invalid_completion_horizon")
            if row.get("prior_retry_gap_minutes") is not None and row["prior_retry_gap_minutes"] < 0:
                problems.append("negative_retry_gap")
        except (KeyError, ValueError, TypeError):
            problems.append("invalid_timestamps")
        if not row.get("lead_id"):
            problems.append("missing_lead_id")
        if problems:
            reasons.update(problems)
        else:
            result.append(row)
    if len({r["attempt_id"] for r in result}) != len(result):
        raise ValueError("duplicate attempts; deduplicate before fitting")
    if len({r["target"]["label_kind"] for r in result}) > 1:
        raise ValueError("canonical and proxy experiments must remain separate")
    return result, {"total_rows": len(rows), "eligible_rows": len(result), "exclusions": dict(reasons)}


def partitions(rows: list[dict], manifest: dict) -> dict:
    result = {k: [] for k in ("train", "validation", "test")}
    mapping = {}
    for name in result:
        for aid in manifest["history"][name]:
            if aid in mapping:
                raise ValueError("attempt crosses partitions")
            mapping[aid] = name
    lead_split = {}
    for row in rows:
        name = mapping.get(row["attempt_id"])
        if name is None:
            continue
        lead = row["lead_id"]
        if lead in lead_split and lead_split[lead] != name:
            raise ValueError("lead/retry chain crosses partitions")
        lead_split[lead] = name
        result[name].append(row)
    for left, right in (("train", "validation"), ("validation", "test")):
        if result[left] and result[right]:
            if max(instant(r["call_at"]) for r in result[left]) >= min(instant(r["call_at"]) for r in result[right]):
                raise ValueError("non-chronological split")
            if max(instant(r["target"]["mature_at"]) for r in result[left]) > min(instant(r["call_at"]) for r in result[right]):
                raise ValueError("label horizon crosses partition embargo")
    return result


def logistic(rows: list[dict], zone: str, penalty: float, include_history: bool = True) -> dict:
    names = FEATURES if include_history else FEATURES[:9]
    matrix = np.array([features(r, zone)[:len(names)] for r in rows])
    labels = np.array([r["target"]["meeting_done"] for r in rows])
    w, intercept = np.zeros(len(names)), math.log((labels.sum() + 1) / (len(labels) - labels.sum() + 1))
    for _ in range(500):
        predicted = 1 / (1 + np.exp(-np.clip(matrix @ w + intercept, -40, 40)))
        error = predicted - labels
        gradient = matrix.T @ error / len(labels) + penalty * w
        w -= .25 * gradient
        intercept -= .25 * error.mean()
    return {"feature_schema": {"feature_names": names}, "logistic": {"coefficients": w.tolist(), "intercept": float(intercept), "l2": penalty}, "family": "logistic", "timezone": zone}


def raw_predict(row: dict, model: dict) -> float:
    if model["family"] == "logistic":
        vals = features(row, model["timezone"])[:len(model["feature_schema"]["feature_names"])]
        z = model["logistic"]["intercept"] + sum(c * x for c, x in zip(model["logistic"]["coefficients"], vals))
        return 1 / (1 + math.exp(-max(-40, min(40, z))))
    at = instant(row["call_at"]).astimezone(ZoneInfo(model["timezone"]))
    global_bin = model["smoothing"]["global"]
    rate = (global_bin["positive"] + 1) / (global_bin["count"] + 2)
    b = model["smoothing"]["bins"].get(f"{at.weekday()}:{at.hour}", {"positive": 0, "count": 0})
    strength = model["smoothing"]["strength"]
    return (b["positive"] + strength * rate) / (b["count"] + strength)


def calibrate(labels: list[int], scores: list[float]) -> dict:
    if sum(labels) < 20 or len(labels) - sum(labels) < 20:
        return {"kind": "none", "calibrated": False, "reason": "fewer than 20 positive/negative validation labels"}
    x = np.array([math.log(max(1e-8, p) / max(1e-8, 1 - p)) for p in scores])
    y = np.array(labels)
    slope, intercept = 1., 0.
    for _ in range(500):
        error = 1 / (1 + np.exp(-np.clip(slope * x + intercept, -40, 40))) - y
        slope -= .01 * float((error * x).mean())
        intercept -= .01 * float(error.mean())
    return {"kind": "platt", "calibrated": True, "slope": slope, "intercept": intercept, "fitted_on": "validation_after_raw_candidate_selection", "validation_not_independent_for_calibration": True}


def predict(row: dict, model: dict) -> float:
    p = raw_predict(row, model)
    calibration = model.get("calibration") or {}
    if calibration.get("kind") != "platt":
        return p
    z = calibration["slope"] * math.log(max(1e-8, p) / max(1e-8, 1 - p)) + calibration["intercept"]
    return 1 / (1 + math.exp(-max(-40, min(40, z))))


def digest(file: Path | str) -> str:
    return hashlib.sha256(Path(file).read_bytes()).hexdigest()


def save(file: Path, value: dict) -> None:
    file.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def rolling_development(rows: list[dict], zone: str) -> list[dict]:
    ordered = sorted(rows, key=lambda r: instant(r["call_at"]))
    output = []
    for fraction in (.6, .8):
        cut = int(len(ordered) * fraction)
        if cut <= 0 or cut >= len(ordered):
            continue
        validation = ordered[cut:]
        start = instant(validation[0]["call_at"])
        validation_leads = {r["lead_id"] for r in validation}
        train = [r for r in ordered[:cut] if instant(r["target"]["mature_at"]) <= start and r["lead_id"] not in validation_leads]
        if len(train) < 20 or len(validation) < 10 or len({r["target"]["meeting_done"] for r in train}) < 2:
            output.append({"cut_fraction": fraction, "status": "insufficient_support"})
            continue
        smoothing = fit_smoothing(train, zone)
        baseline = {"family": "hour_day", "timezone": zone, "smoothing": smoothing}
        linear = {**logistic(train, zone, .05), "smoothing": smoothing}
        output.append({"cut_fraction": fraction, "train_attempts": len(train), "validation_attempts": len(validation), "embargo": "all training labels mature before rolling validation; leads disjoint", "baseline": evaluate([r["target"]["meeting_done"] for r in validation], [raw_predict(r, baseline) for r in validation]), "logistic": evaluate([r["target"]["meeting_done"] for r in validation], [raw_predict(r, linear) for r in validation])})
    return output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("audit", "train", "evaluate"), default="audit", nargs="?")
    parser.add_argument("--dataset", default=".data/best-time-to-call/attempts.jsonl")
    parser.add_argument("--splits", default=".data/best-time-to-call/splits-v2.json")
    parser.add_argument("--output", default=".data/best-time-to-call/history")
    parser.add_argument("--as-of", default=datetime.now(timezone.utc).isoformat())
    parser.add_argument("--allow-proxy", action="store_true")
    args = parser.parse_args()
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(args.splits).read_text(encoding="utf-8"))
    if manifest["dataset_sha256"] != digest(args.dataset):
        raise ValueError("dataset checksum does not match locked manifest")
    rows, audit = eligible(load_rows(args.dataset), args.as_of, args.allow_proxy)
    grouped = partitions(rows, manifest)
    if args.command == "audit":
        result = {"status": "eligible" if rows else "blocked", "trained": False, "primary_target": "meeting_done", "eligibility": audit, "split_counts": {k: len(v) for k, v in grouped.items()}, "held_out_metrics": None}
        save(out / "eligibility.json", result)
        print(json.dumps(result, indent=2))
        return
    if args.command == "train":
        if (out / "freeze.json").exists():
            raise ValueError("model frozen; do not tune against final test")
        train, val = grouped["train"], grouped["validation"]
        if not train or not val or len({r["target"]["meeting_done"] for r in train}) < 2:
            save(out / "model-card.json", {"trained": False, "status": "blocked", "primary_target": "meeting_done", "eligibility": audit, "held_out_metrics": None})
            raise SystemExit("Training blocked: verified history and both completed-meeting classes required.")
        zone = manifest["timezone"]
        smoothing = fit_smoothing(train, zone)
        baseline = {"family": "hour_day", "timezone": zone, "smoothing": smoothing, "feature_schema": {"feature_names": []}, "logistic": None}
        labels = [r["target"]["meeting_done"] for r in val]
        baseline_scores = [raw_predict(r, baseline) for r in val]
        reference = evaluate(labels, baseline_scores)
        save(out / "acceptance.json", {"primary_target": "meeting_done", "written_before_tuning": True, "baseline_validation": reference, "selection": "validation log_loss; Brier degradation <=0.01", "predictive_support": {"train_positive": 10, "validation_positive": 5, "test_positive": 5}, "aspirational_policy_lift": {"relative": .10, "positive_95pct_lower_bound": True, "identifiable": False}, "no_automatic_rollout": True})
        candidates = [baseline]
        for use_history in (False, True):
            for l2 in (.005, .05, .2):
                candidates.append({**logistic(train, zone, l2, use_history), "smoothing": smoothing, "candidate": f"logistic_history_{use_history}_l2_{l2}"})
        measured = []
        for i, model in enumerate(candidates):
            measured.append({"candidate": model.get("candidate", "hour_day"), "index": i, "metrics": evaluate(labels, [raw_predict(r, model) for r in val])})
        admissible = [m for m in measured if m["metrics"]["brier"] <= reference["brier"] + .01]
        selected = min(admissible, key=lambda m: (m["metrics"]["log_loss"], m["index"]))
        model = deepcopy(candidates[selected["index"]])
        model["calibration"] = calibrate(labels, [raw_predict(r, model) for r in val])
        version = f"history-{digest(args.dataset)[:12]}-{selected['index']}"
        model.update({"schema_version": 1, "model_version": version, "route": "history_aware", "primary_target": "meeting_done", "label_kind": train[0]["target"]["label_kind"], "dataset_sha256": digest(args.dataset), "split_sha256": digest(args.splits), "trained_at": datetime.now(timezone.utc).isoformat(), "evidence": {"training_attempts": len(train), "training_positives": sum(r["target"]["meeting_done"] for r in train)}, "deployment": {"approved": False, "reason": "independent canonical-label/support/cohort review required"}})
        save(out / "model.json", model)
        save(out / "experiments.json", {"selected": selected, "experiments": measured, "history_feature_ablation": True, "trials": len(candidates) - 1, "test_accessed": False, "policy_lift_measured": False, "calibration": model["calibration"], "validation_uncertainty_raw": bootstrap(val, [raw_predict(r, model) for r in val], baseline_scores), "rolling_development_validation": rolling_development(train + val, zone)})
        save(out / "freeze.json", {"model_sha256": digest(out / "model.json"), "dataset_sha256": digest(args.dataset), "split_sha256": digest(args.splits), "as_of": args.as_of})
        print(json.dumps({"status": "frozen_offline", "model_version": version, "validation_raw": selected["metrics"], "deployment_approved": False}))
        return
    freeze = json.loads((out / "freeze.json").read_text())
    if freeze["model_sha256"] != digest(out / "model.json") or freeze["dataset_sha256"] != digest(args.dataset) or freeze["split_sha256"] != digest(args.splits) or instant(args.as_of) != instant(freeze["as_of"]):
        raise ValueError("frozen model/data/cutoff changed")
    test = grouped["test"]
    if not test:
        raise ValueError("no eligible locked test rows")
    with (out / "test-lock.json").open("x") as f:
        json.dump({"status": "started", "as_of": args.as_of}, f)
    model = json.loads((out / "model.json").read_text())
    baseline = {**model, "family": "hour_day", "calibration": {"kind": "none"}}
    scores = [predict(r, model) for r in test]
    measured = evaluate([r["target"]["meeting_done"] for r in test], scores)
    reference = evaluate([r["target"]["meeting_done"] for r in test], [predict(r, baseline) for r in test])
    support = model["evidence"]["training_attempts"] >= 100 and model["evidence"]["training_positives"] >= 10 and len(test) >= 30 and sum(r["target"]["meeting_done"] for r in test) >= 5
    passed = support and measured["brier"] <= reference["brier"] + .01 and measured["log_loss"] <= reference["log_loss"] + .02 and measured["average_precision"] is not None and measured["average_precision"] >= measured["class_prevalence"]
    result = {"primary_target": "meeting_done", "label_kind": model["label_kind"], "test": measured, "baseline": reference, "cohorts": cohort_metrics(test, scores), "uncertainty": bootstrap(test, scores, [predict(r, baseline) for r in test]), "predictive_acceptance": passed, "canonical_objective_verified": model["label_kind"] == "canonical", "policy_lift_measured": False, "policy_acceptance": False, "deployment_approved": False}
    save(out / "final-test.json", result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
