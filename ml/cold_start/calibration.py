"""Validation-only Platt mapping, exported as two finite scalar parameters."""

from __future__ import annotations

import math

CLIP = 1e-6


def sigmoid(value: float) -> float:
    if value >= 0:
        return 1 / (1 + math.exp(-value))
    exponential = math.exp(value)
    return exponential / (1 + exponential)


def logit_probability(probability: float, clip: float = CLIP) -> float:
    if not 0 < clip < .5:
        raise ValueError("calibration clip must be between 0 and 0.5")
    if not math.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError("calibration probability outside [0,1]")
    value = min(1 - clip, max(clip, probability))
    return math.log(value) - math.log1p(-value)


def apply_calibration(probability: float, calibration: dict | None) -> float:
    if not calibration or calibration.get("kind") == "none":
        return probability
    if calibration.get("kind") != "platt" or calibration.get("calibrated") is not True:
        raise ValueError("unknown or invalid frozen calibration contract")
    slope, intercept = calibration["slope"], calibration["intercept"]
    if not math.isfinite(slope) or not math.isfinite(intercept):
        raise ValueError("calibration parameters must be finite")
    return sigmoid(slope * logit_probability(probability, calibration.get("clip", CLIP)) + intercept)


def fit_platt(labels: list[int], probabilities: list[float], minimum_per_class: int = 20,
              max_iterations: int = 100) -> dict:
    """Fit only supplied validation labels; this function receives no other rows."""
    if len(labels) != len(probabilities) or any(isinstance(label, bool) or label not in (0, 1) for label in labels):
        raise ValueError("invalid calibration labels")
    minimum_per_class = max(20, minimum_per_class)
    inputs = [logit_probability(probability) for probability in probabilities]
    positives, negatives = sum(labels), len(labels) - sum(labels)
    provenance = {"fitted_split": "validation", "validation_reused_for_selection": True,
                  "independent_calibrated_validation_metrics": False,
                  "validation_attempts": len(labels), "validation_positives": positives,
                  "validation_negatives": negatives, "minimum_per_class": minimum_per_class}
    if positives < minimum_per_class or negatives < minimum_per_class:
        return dict(provenance, kind="none", calibrated=False, reason="insufficient_validation_class_support")
    # Platt's smoothed targets and small slope penalty keep perfectly separated
    # fixtures finite. A nonnegative slope preserves the selected raw ordering.
    targets = [(positives + 1) / (positives + 2) if label else 1 / (negatives + 2) for label in labels]
    ridge, slope, intercept = 1e-6, 1.0, 0.0
    def objective(a: float, b: float) -> float:
        total = 0.0
        for value, target in zip(inputs, targets):
            prediction = a * value + b
            total += max(prediction, 0) + math.log1p(math.exp(-abs(prediction))) - target * prediction
        return total / len(targets) + ridge * a * a / 2
    converged, loss = False, objective(slope, intercept)
    for iteration in range(max_iterations):
        errors, curvature = [], []
        for value, target in zip(inputs, targets):
            probability = sigmoid(slope * value + intercept)
            errors.append(probability - target)
            curvature.append(probability * (1 - probability))
        gradient_a = sum(error * value for error, value in zip(errors, inputs)) / len(inputs) + ridge * slope
        gradient_b = sum(errors) / len(inputs)
        if max(abs(gradient_a), abs(gradient_b)) < 1e-7:
            converged = True
            break
        hessian_aa = sum(weight * value * value for weight, value in zip(curvature, inputs)) / len(inputs) + ridge
        hessian_ab = sum(weight * value for weight, value in zip(curvature, inputs)) / len(inputs)
        hessian_bb = sum(curvature) / len(inputs)
        determinant = hessian_aa * hessian_bb - hessian_ab * hessian_ab
        if determinant <= 1e-18:
            break
        delta_a = (gradient_a * hessian_bb - gradient_b * hessian_ab) / determinant
        delta_b = (gradient_b * hessian_aa - gradient_a * hessian_ab) / determinant
        step, accepted = 1.0, False
        for _ in range(25):
            candidate_a, candidate_b = max(0.0, slope - step * delta_a), intercept - step * delta_b
            candidate_loss = objective(candidate_a, candidate_b)
            if math.isfinite(candidate_loss) and candidate_loss <= loss + 1e-12:
                accepted = True
                break
            step /= 2
        if not accepted:
            break
        difference = abs(loss - candidate_loss)
        slope, intercept, loss = candidate_a, candidate_b, candidate_loss
        if difference < 1e-10:
            converged = True
            break
    if not converged or not math.isfinite(slope) or not math.isfinite(intercept):
        return dict(provenance, kind="none", calibrated=False, reason="platt_optimizer_did_not_converge")
    return dict(provenance, kind="platt", calibrated=True, slope=slope, intercept=intercept,
                input="logit_probability", clip=CLIP, slope_constraint="nonnegative",
                target_smoothing="positive=(n_pos+1)/(n_pos+2), negative=1/(n_neg+2)",
                slope_l2=ridge, iterations=iteration + 1, converged=True,
                meaning="validation-fitted calibration applied; independent quality assessed only on locked test")
