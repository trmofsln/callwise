"""Transparent numeric model and hierarchical, observed-slot baselines."""

from __future__ import annotations

from collections import Counter
from datetime import datetime
import math
from zoneinfo import ZoneInfo

from .calibration import apply_calibration
from .contract import CATEGORICAL_FIELDS, instant, safe_metadata

MISSING, OTHER = "__missing__", "__other__"


def local_time(row: dict, timezone: str) -> datetime:
    return instant(row["call_at"]).astimezone(ZoneInfo(timezone))


def slot(row: dict, timezone: str) -> str:
    value = local_time(row, timezone)
    return f"{value.weekday()}:{value.hour}"


def fit_feature_schema(rows: list[dict], timezone: str, use_metadata: bool = True, interactions: bool = True) -> dict:
    names = ["hour_sin", "hour_cos"] + [f"weekday_{day}" for day in range(7)]
    categories = {}
    if use_metadata:
        names += ["account_age_log1p", "account_age_missing"]
        for field in CATEGORICAL_FIELDS:
            counts = Counter(str(row.get("safe_metadata", {}).get(field, MISSING)) for row in rows)
            vocabulary = sorted(value for value, count in counts.items() if count >= 5 and value not in (MISSING, OTHER))
            categories[field] = [MISSING, OTHER] + vocabulary
            names += [f"{field}={value}" for value in categories[field]]
    interaction_fields = [field for field in ("state", "industry") if field in categories] if interactions else []
    for field in interaction_fields:
        names += [f"{field}={value}*{periodic}" for value in categories[field] for periodic in ("hour_sin", "hour_cos")]
    return {"schema_version": 1, "timezone": timezone, "feature_names": names, "categories": categories,
            "interaction_fields": interaction_fields, "account_age_cap_days": 3650, "minimum_category_support": 5}


def features(row: dict, schema: dict) -> list[float]:
    called = local_time(row, schema["timezone"])
    hour = called.hour + called.minute / 60 + called.second / 3600
    numeric = {"hour_sin": math.sin(hour * 2 * math.pi / 24), "hour_cos": math.cos(hour * 2 * math.pi / 24)}
    numeric.update({f"weekday_{day}": float(called.weekday() == day) for day in range(7)})
    metadata = row.get("safe_metadata")
    if metadata is None:
        metadata, _ = safe_metadata(row)
    if "account_age_log1p" in schema["feature_names"]:
        created = metadata.get("account_created_at")
        age = max(0.0, (instant(row["call_at"]) - instant(created)).total_seconds() / 86400) if created else 0.0
        numeric["account_age_log1p"] = math.log1p(min(age, schema["account_age_cap_days"])) / math.log1p(schema["account_age_cap_days"])
        numeric["account_age_missing"] = float(created is None)
    for field, vocabulary in schema["categories"].items():
        value = str(metadata.get(field, MISSING))
        if value not in vocabulary:
            value = OTHER
        for category in vocabulary:
            name = f"{field}={category}"
            numeric[name] = float(value == category)
            if field in schema["interaction_fields"]:
                numeric[name + "*hour_sin"] = numeric[name] * numeric["hour_sin"]
                numeric[name + "*hour_cos"] = numeric[name] * numeric["hour_cos"]
    return [numeric[name] for name in schema["feature_names"]]


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1 + exponential)


def fit_logistic(rows: list[dict], schema: dict, l2: float, max_steps: int = 500) -> dict:
    """Full-batch L2 penalised cross-entropy; representative prevalence, no resampling."""
    x = [features(row, schema) for row in rows]
    y = [row["target"]["meeting_done"] for row in rows]
    if not x or len(set(y)) < 2:
        raise ValueError("logistic fitting requires both completed-meeting classes")
    prevalence = (sum(y) + 1) / (len(y) + 2)
    intercept = math.log(prevalence / (1 - prevalence))
    coefficients = [0.0] * len(x[0])
    # A conservative Hessian upper bound includes the intercept feature.
    step = 1 / (.25 * (1 + max(sum(value * value for value in values) for values in x)) + l2)
    last_loss = math.inf
    converged = False
    # Numpy acceleration is optional; exported inference always uses scalar JSON.
    try:
        import numpy as np
        matrix, labels = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
        weights = np.asarray(coefficients)
        for iteration in range(max_steps):
            logits = matrix @ weights + intercept
            probabilities = 1 / (1 + np.exp(-np.clip(logits, -40, 40)))
            errors = probabilities - labels
            loss = float(np.mean(np.logaddexp(0, logits) - labels * logits) + l2 * np.dot(weights, weights) / 2)
            weights -= step * (matrix.T @ errors / len(y) + l2 * weights)
            intercept -= step * float(errors.mean())
            if abs(last_loss - loss) < 1e-9:
                converged = True
                break
            last_loss = loss
        coefficients = weights.tolist()
        backend = "numpy"
    except ImportError:
        for iteration in range(max_steps):
            errors = [sigmoid(intercept + sum(w * value for w, value in zip(coefficients, values))) - label for values, label in zip(x, y)]
            gradients = [sum(error * values[index] for error, values in zip(errors, x)) / len(y) + l2 * coefficients[index] for index in range(len(coefficients))]
            coefficients = [weight - step * gradient for weight, gradient in zip(coefficients, gradients)]
            intercept -= step * sum(errors) / len(y)
        backend = "stdlib"
    return {"coefficients": coefficients, "intercept": float(intercept), "l2": l2,
            "iterations": iteration + 1, "converged": converged, "backend": backend,
            "optimizer": "full_batch_gradient_descent", "class_weight": None}


def fit_smoothing(rows: list[dict], timezone: str, strength: float = 20) -> dict:
    def count(target: dict, key: str, label: int) -> None:
        bucket = target.setdefault(key, {"count": 0, "positive": 0})
        bucket["count"] += 1
        bucket["positive"] += label
    result = {"strength": strength, "global": {"count": len(rows), "positive": 0}, "bins": {}, "cohorts": {}}
    for row in rows:
        label, key = row["target"]["meeting_done"], slot(row, timezone)
        result["global"]["positive"] += label
        count(result["bins"], key, label)
        for field in ("industry", "state", "segment"):
            value = row.get("safe_metadata", {}).get(field)
            if value is not None:
                target = result["cohorts"].setdefault(field, {}).setdefault(str(value), {})
                count(target, key, label)
    return result


def smooth_score(row: dict, artifact: dict, use_cohorts: bool = False) -> tuple[float, int, str]:
    smoothing = artifact["smoothing"]
    global_bin = smoothing["global"]
    global_rate = (global_bin["positive"] + 1) / (global_bin["count"] + 2)
    key = slot(row, artifact["timezone"])
    observed = smoothing["bins"].get(key, {"count": 0, "positive": 0})
    strength = smoothing["strength"]
    probability = (observed["positive"] + strength * global_rate) / (observed["count"] + strength)
    support, source = observed["count"], "hour_day"
    if use_cohorts:
        metadata = row.get("safe_metadata")
        if metadata is None:
            metadata, _ = safe_metadata(row)
        eligible = []
        for field in ("industry", "state", "segment"):
            value = metadata.get(field)
            cohort = smoothing["cohorts"].get(field, {}).get(str(value), {}).get(key)
            if cohort and cohort["count"] >= 5:
                eligible.append((cohort["count"], field, cohort))
        if eligible:
            support, field, observed = max(eligible, key=lambda item: item[0])
            probability = (observed["positive"] + strength * probability) / (support + strength)
            source = "cohort_" + field
    return probability, support, source


def raw_predict(row: dict, artifact: dict) -> float:
    if artifact["family"] == "logistic":
        model = artifact["logistic"]
        return sigmoid(model["intercept"] + sum(weight * value for weight, value in zip(model["coefficients"], features(row, artifact["feature_schema"]))))
    return smooth_score(row, artifact, artifact["family"] == "cohort_hour_day")[0]


def predict(row: dict, artifact: dict) -> float:
    return apply_calibration(raw_predict(row, artifact), artifact.get("calibration"))


def score_windows(artifact: dict, context: dict, windows: list[dict], minimum_slot_support: int = 5) -> list[dict]:
    """Backend owns future-window constraints; numerical scoring verifies route/time."""
    if context.get("history_complete") is not True or context.get("prior_attempts") != 0 or isinstance(context.get("prior_attempts"), bool):
        raise ValueError("cold-start inference requires verified complete zero-call history")
    if artifact.get("route") not in (None, "cold_start"):
        raise ValueError("strict cold-start scoring requires its own complete-history artifact")
    at = instant(context["as_of"])
    metadata, excluded = safe_metadata(dict(context, call_at=context["as_of"]), at)
    scored = []
    for window in windows:
        starts, ends = instant(window["start"]), instant(window["end"])
        if starts <= at or ends <= starts:
            raise ValueError("window must be future and have positive duration")
        row = dict(context, call_at=window["start"], safe_metadata=metadata)
        fallback, support, source = smooth_score(row, artifact, artifact["family"] == "cohort_hour_day")
        probability = predict(row, artifact) if support >= minimum_slot_support else None
        # Extrapolation into unseen/very sparse observed slots is never a measured score.
        calibrated = artifact.get("calibration", {}).get("calibrated") is True
        scored.append(dict(window, probability=probability, observed_slot_support=support,
                           support_source=source, metadata_excluded=excluded,
                           score_status=("supported_validation_calibrated" if calibrated else "supported_uncalibrated") if probability is not None else "insufficient_support"))
    return sorted(scored, key=lambda row: (row["probability"] is None, -(row["probability"] or 0), row["start"]))
