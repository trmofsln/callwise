"""Tie-aware predictive evaluation. No metric estimates causal scheduling lift."""

from __future__ import annotations

from collections import defaultdict
import math
import random


def budget_yield(labels: list[int], scores: list[float], fraction: float = 0.2) -> dict:
    if not labels:
        return {"budget": 0, "yield": None, "precision": None, "recall": None}
    budget = max(1, math.ceil(len(labels) * fraction))
    groups = defaultdict(list)
    for label, score in zip(labels, scores):
        groups[score].append(label)
    remaining, positive = budget, 0.0
    for score in sorted(groups, reverse=True):
        values = groups[score]
        take = min(remaining, len(values))
        positive += sum(values) * take / len(values)
        remaining -= take
        if not remaining:
            break
    return {"budget": budget, "expected_completed_meetings": positive,
            "precision": positive / budget, "yield": positive / budget,
            "recall": positive / sum(labels) if sum(labels) else None,
            "tie_policy": "fractional_expectation_of_uniform_selection_at_cutoff"}


def evaluate(labels: list[int], scores: list[float], budget_fraction: float = 0.2) -> dict:
    if len(labels) != len(scores) or any(label not in (0, 1) for label in labels):
        raise ValueError("invalid metric input")
    if any(not math.isfinite(score) or not 0 <= score <= 1 for score in scores):
        raise ValueError("probability outside [0,1]")
    n, positive = len(labels), sum(labels)
    result = {"attempts": n, "completed_meetings": positive,
              "class_prevalence": positive / n if n else None,
              "majority_class_accuracy": max(positive, n - positive) / n if n else None,
              "meetings_per_100_attempts": 100 * positive / n if n else None,
              "calls_per_completed_meeting": n / positive if positive else None,
              "average_precision": None, "roc_auc": None, "brier": None, "log_loss": None,
              "budget_fraction": budget_fraction, "at_call_budget": budget_yield(labels, scores, budget_fraction),
              "interpretation": "predictive retrospective discrimination; no causal schedule lift"}
    if not n:
        return result
    result["brier"] = sum((score - label) ** 2 for label, score in zip(labels, scores)) / n
    result["log_loss"] = -sum(label * math.log(max(1e-15, score)) + (1 - label) * math.log(max(1e-15, 1 - score)) for label, score in zip(labels, scores)) / n
    groups = defaultdict(list)
    for label, score in zip(labels, scores):
        groups[score].append(label)
    if positive:
        seen, seen_positive, ap = 0, 0, 0.0
        for score in sorted(groups, reverse=True):
            values = groups[score]
            seen += len(values)
            seen_positive += sum(values)
            ap += sum(values) / positive * seen_positive / seen
        result["average_precision"] = ap
    if positive and positive != n:
        negatives_before, wins = 0, 0.0
        for score in sorted(groups):
            values = groups[score]
            positives, negatives = sum(values), len(values) - sum(values)
            wins += positives * (negatives_before + negatives / 2)
            negatives_before += negatives
        result["roc_auc"] = wins / (positive * (n - positive))
    calibration = []
    for index in range(10):
        selected = [(label, score) for label, score in zip(labels, scores) if min(int(score * 10), 9) == index]
        if selected:
            calibration.append({"bin": index, "count": len(selected), "mean_prediction": sum(score for _, score in selected) / len(selected), "observed_rate": sum(label for label, _ in selected) / len(selected)})
    result["calibration_bins"] = calibration
    return result


def bootstrap(rows: list[dict], scores: list[float], baseline_scores: list[float] | None = None,
              repeats: int = 300, seed: int = 1729, budget_fraction: float = 0.2) -> dict:
    groups = defaultdict(list)
    for index, row in enumerate(rows):
        groups[str(row["seller_id"])].append(index)
    sellers = sorted(groups)
    if len(sellers) < 2:
        return {"method": "seller_cluster_percentile", "clusters": len(sellers), "intervals": {}}
    rng, collected = random.Random(seed), defaultdict(list)
    for _ in range(repeats):
        indices = [index for _ in sellers for index in groups[rng.choice(sellers)]]
        labels = [rows[index]["target"]["meeting_done"] for index in indices]
        sample_scores = [scores[index] for index in indices]
        measured = evaluate(labels, sample_scores, budget_fraction)
        for key in ("average_precision", "brier", "log_loss"):
            if measured[key] is not None:
                collected[key].append(measured[key])
        selected_yield = measured["at_call_budget"]["yield"]
        if selected_yield is not None:
            collected["yield_at_call_budget"].append(selected_yield)
        if baseline_scores is not None:
            reference_yield = budget_yield(labels, [baseline_scores[index] for index in indices], budget_fraction)["yield"]
            collected["yield_at_budget_difference"].append(selected_yield - reference_yield)
    def percentile(values: list[float], probability: float) -> float:
        ordered = sorted(values)
        return ordered[round((len(ordered) - 1) * probability)]
    return {"method": "seller_cluster_percentile", "clusters": len(sellers), "repeats": repeats, "seed": seed,
            "intervals": {key: {"lower": percentile(values, .025), "upper": percentile(values, .975)} for key, values in collected.items() if values}}


def cohort_metrics(rows: list[dict], scores: list[float], minimum_size: int = 20) -> dict:
    result = {}
    for field in ("city", "state", "industry", "segment"):
        groups = defaultdict(list)
        for index, row in enumerate(rows):
            groups[str(row.get("safe_metadata", {}).get(field, "__missing__"))].append(index)
        result[field] = {}
        for value, indices in groups.items():
            if len(indices) >= minimum_size:
                result[field][value] = evaluate([rows[index]["target"]["meeting_done"] for index in indices], [scores[index] for index in indices])
    return result


def metadata_coverage(rows: list[dict], scores: list[float], schema: dict) -> dict:
    """Explicitly assess missing and train-unseen categories on untouched rows."""
    result = {}
    for field, vocabulary in schema.get("categories", {}).items():
        conditions = {"missing": [], "unseen_or_rare": [], "seen": []}
        for index, row in enumerate(rows):
            value = row.get("safe_metadata", {}).get(field)
            name = "missing" if value is None else "seen" if str(value) in vocabulary else "unseen_or_rare"
            conditions[name].append(index)
        result[field] = {name: evaluate([rows[index]["target"]["meeting_done"] for index in indices], [scores[index] for index in indices])
                         for name, indices in conditions.items()}
    return result


def clock_support_metrics(rows: list[dict], scores: list[float], artifact: dict, minimum_slot_support: int = 5) -> dict:
    """Separate unseen weekdays and weak observed slots; no score masking on test."""
    from .models import local_time, slot
    training_weekdays = sorted({int(key.split(":", 1)[0]) for key, value in artifact["smoothing"]["bins"].items() if value["count"] > 0})
    groups = {"supported_slots": [], "insufficient_slot_support": [], "unseen_training_weekday": []}
    by_weekday = defaultdict(list)
    for index, row in enumerate(rows):
        day = local_time(row, artifact["timezone"]).weekday()
        by_weekday[day].append(index)
        count = artifact["smoothing"]["bins"].get(slot(row, artifact["timezone"]), {}).get("count", 0)
        groups["supported_slots" if count >= minimum_slot_support else "insufficient_slot_support"].append(index)
        if day not in training_weekdays:
            groups["unseen_training_weekday"].append(index)
    def measured(indices: list[int]) -> dict:
        return evaluate([rows[index]["target"]["meeting_done"] for index in indices], [scores[index] for index in indices])
    return {"training_weekdays_monday_zero": training_weekdays, "minimum_slot_support": minimum_slot_support,
            "groups": {name: measured(indices) for name, indices in groups.items()},
            "by_weekday_monday_zero": {str(day): measured(indices) for day, indices in sorted(by_weekday.items())},
            "inference_policy": "slots below minimum training support return null rather than an observed-supported recommendation",
            "evaluation_policy": "all preregistered test calls retained, including unsupported weekdays; subgroup results disclosed"}


def link_coverage_metrics(rows: list[dict], scores: list[float]) -> dict:
    """Final-record linkage is diagnostic only, never a pre-call predictor."""
    groups = {"matched_dsr": [], "no_matched_dsr": [], "unknown_link_coverage": []}
    for index, row in enumerate(rows):
        count = (row.get("evidence") or {}).get("matched_dsr_calls")
        name = "unknown_link_coverage" if isinstance(count, bool) or not isinstance(count, int) else "matched_dsr" if count > 0 else "no_matched_dsr"
        groups[name].append(index)
    return {"groups": {name: evaluate([rows[index]["target"]["meeting_done"] for index in indices], [scores[index] for index in indices]) for name, indices in groups.items()},
            "matched_only_is_sensitivity": True, "used_as_feature": False,
            "interpretation": "observed absence and label-source coverage can affect rates; unmatched calls are not verified canonical completion negatives"}
