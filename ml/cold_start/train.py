"""Reproducible offline train/freeze/test commands; never chooses split membership."""

from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys

from .calibration import fit_platt
from .contract import instant, load_rows, prepare_rows, split_rows
from .metrics import bootstrap, clock_support_metrics, cohort_metrics, evaluate, link_coverage_metrics, metadata_coverage
from .models import fit_feature_schema, fit_logistic, fit_smoothing, predict
from .observed_scope import ROUTE as OBSERVED_ROUTE, prepare_observed_rows
from .experimental_proxy import GENERAL_ROUTE, map_proxy_training_target, prepare_general_proxy_rows, split_general_proxy_rows


def digest(path: str | Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def environment() -> dict:
    versions = {}
    for package in ("numpy", "tzdata", "scikit-learn"):
        try:
            versions[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            versions[package] = None
    return {"python": platform.python_version(), "platform": platform.platform(), "packages": versions, "seed": 1729}


def feature_provenance(rows: list[dict]) -> dict:
    result = {}
    for field in ("city", "state", "industry", "business_type", "segment", "account_created_at"):
        accepted = [row for row in rows if field in row.get("safe_metadata", {})]
        result[field] = {"accepted_training_rows": len(accepted),
                         "source_counts": dict(Counter(str(row["metadata_provenance"][field]["source"]) for row in accepted)),
                         "historical_rows": sum(row["metadata_provenance"][field].get("historical") is True for row in accepted),
                         "verified_static_rows": sum(row["metadata_provenance"][field].get("verified_static") is True for row in accepted),
                         "availability_policy": "available_at <= original decision timestamp"}
    return result


def load_experiment(dataset: Path, splits: Path, as_of: str, allow_proxy: bool, observed_first_contact_proxy: bool = False,
                    general_erp_proxy: bool = False, proxy_target: str | None = None, require_development: bool = True) -> tuple[dict, dict, dict]:
    manifest = json.loads(splits.read_text(encoding="utf-8-sig"))
    dataset_sha = digest(dataset)
    if manifest.get("dataset_sha256") != dataset_sha:
        raise ValueError("dataset checksum differs from locked split manifest")
    raw_rows = load_rows(dataset)
    if observed_first_contact_proxy and general_erp_proxy:
        raise ValueError("observed-first and general ERP proxy are distinct experiments; select one")
    if observed_first_contact_proxy or general_erp_proxy:
        if not allow_proxy:
            raise ValueError("experimental ERP mode requires explicit --allow-proxy")
        if manifest.get("label_kind") != "proxy":
            raise ValueError("experimental ERP mode requires a separate proxy split manifest")
        mapped, _ = map_proxy_training_target(raw_rows, manifest, proxy_target)
        if observed_first_contact_proxy:
            # The immutable preparation contract quarantines ambiguous first-call
            # ties before model work. Unselected population rows are not claimed
            # cold examples and must not enter eligibility/preprocessing fitting.
            declared = split_rows(mapped, manifest)
            scoped_rows = [row for name in ("train", "validation", "test") for row in declared[name]]
            rows, exclusions = prepare_observed_rows(scoped_rows, instant(as_of), manifest.get("history_scope"))
            exclusions.update({"source_dataset_rows": len(raw_rows), "rows_outside_locked_cold_membership": len(raw_rows) - len(scoped_rows),
                               "membership_policy": "provided immutable cold track; ambiguous first-call ties quarantined by preparation"})
        else:
            rows, exclusions = prepare_general_proxy_rows(mapped, instant(as_of), manifest.get("history_scope"))
    else:
        rows, exclusions = prepare_rows(raw_rows, instant(as_of), allow_proxy)
    kinds = {row["target"]["label_kind"] for row in rows}
    if kinds and manifest.get("label_kind") not in kinds:
        raise ValueError("split manifest label_kind differs from experiment")
    grouped = split_general_proxy_rows(rows, manifest) if general_erp_proxy else split_rows(rows, manifest)
    if require_development and (not grouped["train"] or not grouped["validation"]):
        raise ValueError("eligible seller-disjoint train/validation data unavailable")
    return grouped, manifest, exclusions


def audit_command(args: argparse.Namespace) -> dict:
    """Write an honest input/support card without fitting or scoring any model."""
    output = Path(args.output)
    if (output / "model.json").exists() or (output / "freeze.json").exists() or (output / "test-lock.json").exists():
        raise ValueError("audit cannot replace a frozen or evaluated model card")
    observed_mode = getattr(args, "observed_first_contact_proxy", False)
    general_mode = getattr(args, "general_erp_proxy", False)
    experimental = observed_mode or general_mode
    target = getattr(args, "proxy_target", None) if experimental else "meeting_done"
    grouped, manifest, exclusions = load_experiment(Path(args.dataset), Path(args.splits), args.as_of, args.allow_proxy,
                                                    observed_mode, general_mode, target, require_development=False)
    counts = {name: {"attempts": len(values), "positives": sum(row["target"]["meeting_done"] for row in values),
                     "negatives": sum(row["target"]["meeting_done"] == 0 for row in values),
                     "sellers": len({str(row["seller_id"]) for row in values})} for name, values in grouped.items()}
    reasons = []
    if not grouped["train"] or not grouped["validation"]:
        reasons.append("eligible development data unavailable")
    if counts["train"]["positives"] == 0 or counts["train"]["negatives"] == 0:
        reasons.append("training lacks both observed target classes")
    if experimental and counts["train"]["positives"] < 10:
        reasons.append("fewer than 10 training positives; scoped cohort is too sparse")
    route = OBSERVED_ROUTE if observed_mode else GENERAL_ROUTE if general_mode else "cold_start"
    card = {"schema_version": 1, "route": route, "artifact_status": "blocked_insufficient_support" if reasons else "audited_ready_for_offline_training",
            "trained": False, "model_version": None, "experimental": experimental,
            "primary_target": "meeting_done", "trained_target": target, "label_kind": manifest["label_kind"],
            "canonical_label_verified": manifest["label_kind"] == "canonical", "lifetime_history_verified": not experimental,
            "historical_availability_verified": False if experimental else None, "deployment_approved": False,
            "policy_lift_measured": False, "baseline_metrics": None, "held_out_metrics": None,
            "calibration": {"kind": "none", "calibrated": False}, "blocked_reasons": reasons,
            "history_scope": manifest.get("history_scope"), "eligible_counts": counts, "eligibility": exclusions,
            "dataset_sha256": digest(args.dataset), "split_sha256": digest(args.splits), "as_of": args.as_of,
            "labels_used_for_fit": False, "test_scores_accessed": False,
            "limitations": ["Snapshot recording-proxy labels do not establish canonical completion.",
                            "Scoped current-record history does not establish lifetime history or historical availability.",
                            "Sampled schedules do not identify causal policy lift."] if experimental else []}
    output.mkdir(parents=True, exist_ok=True)
    write_json(output / "model-card.json", card)
    return card


def candidate_models(train: list[dict], timezone_name: str) -> list[dict]:
    smoothing = fit_smoothing(train, timezone_name)
    result = []
    for family in ("hour_day", "cohort_hour_day"):
        result.append({"family": family, "timezone": timezone_name, "smoothing": smoothing, "logistic": None,
                       "feature_schema": fit_feature_schema(train, timezone_name, False, False), "candidate": family})
    if len({row["target"]["meeting_done"] for row in train}) == 2:
        # Four bounded supervised trials include metadata/time-interaction ablation.
        # Missing fields carry no metadata signal; avoid redundant interactions
        # being presented as an evaluated metadata model when every field is absent.
        metadata_available = any(row.get("safe_metadata") for row in train)
        for use_metadata in ((False, True) if metadata_available else (False,)):
            for l2 in (.005, .05):
                schema = fit_feature_schema(train, timezone_name, use_metadata, use_metadata)
                result.append({"family": "logistic", "timezone": timezone_name, "smoothing": smoothing,
                               "feature_schema": schema, "logistic": fit_logistic(train, schema, l2),
                               "candidate": f"logistic_metadata_{use_metadata}_l2_{l2}"})
    return result


def acceptance_contract(train: list[dict], validation: list[dict], baseline: dict, label_kind: str, experimental: bool = False) -> dict:
    positives = lambda values: sum(row["target"]["meeting_done"] for row in values)
    brier_tolerance = max(.0001, .05 * baseline["brier"]) if experimental else .01
    log_loss_tolerance = max(.001, .05 * baseline["log_loss"]) if experimental else .02
    return {"written_before_selection": True, "written_before_supervised_candidate_fitting": True,
            "primary_target": "meeting_done", "label_kind": label_kind,
            "minimum_support": {"training_attempts": 100, "training_positives": 10, "validation_attempts": 30,
                                "validation_positives": 5, "test_attempts": 30, "test_positives": 5},
            "selection": "lowest raw validation log_loss subject to the preregistered Brier tolerance versus hour/day",
            "predictive_criteria": {"max_brier_degradation": brier_tolerance, "max_log_loss_degradation": log_loss_tolerance,
                                    "minimum_average_precision_vs_prevalence": 1.0},
            "tolerance_basis": {"kind": "validation-baseline relative tolerance with absolute floors" if experimental else "original strict-track absolute tolerances",
                                "relative_fraction": .05 if experimental else None, "brier_floor": .0001 if experimental else None,
                                "log_loss_floor": .001 if experimental else None,
                                "rationale": "rare proxy prevalence makes original absolute 0.01/0.02 tolerances overly permissive" if experimental else "original strict contract",
                                "frozen_for_final_test": True},
            "calibration": {"method": "validation-fitted Platt after raw candidate selection", "minimum_validation_positives": 20,
                            "minimum_validation_negatives": 20, "validation_reused_for_selection": True,
                            "independent_quality_assessment": "locked final test only"},
            "aspirational_policy_lift": {"relative_yield": .10, "positive_95pct_lower_bound": True,
                                         "assessed": False, "reason": "observational schedule does not identify uncalled outcomes"},
            "baseline_validation": baseline,
            "development_support_sufficient": len(train) >= 100 and positives(train) >= 10 and len(validation) >= 30 and positives(validation) >= 5,
            "canonical_objective_verified": label_kind == "canonical"}


def rolling_validation(rows: list[dict], timezone_name: str) -> list[dict]:
    ordered = sorted(rows, key=lambda row: instant(row["call_at"]))
    results = []
    for fraction in (.6, .8):
        cut = max(1, int(len(ordered) * fraction))
        if cut >= len(ordered):
            continue
        starts = instant(ordered[cut]["call_at"])
        train = [row for row in ordered[:cut] if instant(row["target"]["mature_at"]) <= starts]
        validation = ordered[cut:]
        if len(train) < 20 or len(validation) < 10:
            continue
        candidates = candidate_models(train, timezone_name)
        results.append({"cut_fraction": fraction, "train_attempts": len(train), "validation_attempts": len(validation),
                        "embargo": "prior labels mature before validation first call",
                        "experiments": {model["candidate"]: evaluate([row["target"]["meeting_done"] for row in validation], [predict(row, model) for row in validation]) for model in candidates}})
    return results


def train_command(args: argparse.Namespace) -> dict:
    output = Path(args.output)
    if (output / "test-lock.json").exists() or (output / "model.json").exists():
        raise ValueError("output already frozen; use preregistered new development data for another experiment")
    observed_mode = getattr(args, "observed_first_contact_proxy", False)
    general_mode = getattr(args, "general_erp_proxy", False)
    experimental_mode = observed_mode or general_mode
    trained_target = getattr(args, "proxy_target", None) if experimental_mode else "meeting_done"
    grouped, manifest, exclusions = load_experiment(Path(args.dataset), Path(args.splits), args.as_of, args.allow_proxy, observed_mode, general_mode, trained_target)
    route = OBSERVED_ROUTE if observed_mode else GENERAL_ROUTE if general_mode else "cold_start"
    eligibility_policy = "observed_first_contact_proxy" if observed_mode else "general_erp_observed_proxy" if general_mode else "verified_first_contact"
    availability_verified = False if experimental_mode else (manifest.get("history_scope") or {}).get("availability_verified")
    train, validation = grouped["train"], grouped["validation"]
    if len({row["target"]["meeting_done"] for row in train}) < 2:
        raise ValueError("verified first-contact training requires both completed-meeting classes; no identifiable classifier")
    if experimental_mode and sum(row["target"]["meeting_done"] for row in train) < 10:
        raise ValueError("experimental proxy classifier requires at least 10 training positives; sparse cohort remains untrained")
    timezone_name = manifest.get("timezone")
    if not timezone_name:
        raise ValueError("split manifest must specify explicit IANA timezone")
    output.mkdir(parents=True, exist_ok=True)
    labels = [row["target"]["meeting_done"] for row in validation]
    # Fit the transparent count baseline first; write the numerical acceptance
    # contract before any optimized supervised candidate is fitted or selected.
    baseline_model = {"family": "hour_day", "timezone": timezone_name, "smoothing": fit_smoothing(train, timezone_name)}
    baseline_scores = [predict(row, baseline_model) for row in validation]
    baseline = evaluate(labels, baseline_scores)
    kind = train[0]["target"]["label_kind"]
    contract = acceptance_contract(train, validation, baseline, kind, experimental_mode)
    write_json(output / "acceptance.json", contract)
    base = candidate_models(train, timezone_name)
    measured = []
    for model in base:
        scores = [predict(row, model) for row in validation]
        metrics = evaluate(labels, scores)
        measured.append({"candidate": model["candidate"], "family": model["family"], "metrics": metrics})
    admissible = [index for index, trial in enumerate(measured) if trial["metrics"]["brier"] <= baseline["brier"] + contract["predictive_criteria"]["max_brier_degradation"]]
    winner = min(admissible, key=lambda index: (measured[index]["metrics"]["log_loss"], index))
    chosen = deepcopy(base[winner])
    raw_selected_scores = [predict(row, chosen) for row in validation]
    chosen["calibration"] = fit_platt(labels, raw_selected_scores)
    model_sha = hashlib.sha256(json.dumps(chosen, sort_keys=True).encode()).hexdigest()
    dataset_sha, split_sha = digest(args.dataset), digest(args.splits)
    chosen.update({"schema_version": 1, "route": route, "primary_target": "meeting_done", "label_kind": kind,
                   "model_version": f"{route.replace('_', '-')}-{kind}-{dataset_sha[:12]}-{model_sha[:8]}",
                   "eligibility_policy": eligibility_policy, "experimental": experimental_mode, "trained_target": trained_target,
                   "history_scope": manifest.get("history_scope") if experimental_mode else None,
                   "lifetime_history_verified": not experimental_mode,
                   "historical_availability_verified": availability_verified, "canonical_label_verified": kind == "canonical",
                   "sequence_identity": "unavailable; synthetic erp-seller grouping is not a lead/retry chain" if general_mode else "immutable seller-disjoint first-observed cohort" if observed_mode else "strict extraction contract",
                   "trained_at": datetime.now(timezone.utc).isoformat(), "dataset_sha256": dataset_sha, "split_sha256": split_sha,
                   "training_as_of": args.as_of,
                   "evidence": {"training_attempts": len(train), "training_positives": sum(row["target"]["meeting_done"] for row in train),
                                "training_sellers": len({row["seller_id"] for row in train}), "metadata_source_policy": "verified_as_of_only"},
                   "feature_provenance": feature_provenance(train),
                   "deployment": {"approved": False, "reason": "offline candidate; independent test and label/coverage review required"},
                   "environment": environment()})
    # These remain raw metrics: the same validation labels fitted calibration.
    # Reporting calibrated validation quality here would reuse its fit labels.
    scores = raw_selected_scores
    experiment = {"selected_candidate": chosen["candidate"], "selection_split": "validation", "label_kind": kind,
                  "experiments": measured, "eligibility": exclusions,
                  "validation_metrics_kind": "raw_before_calibration_fit",
                  "trained_target": trained_target, "endpoint_kind": "observed_record_proxy" if experimental_mode else kind,
                  "calibration": chosen["calibration"],
                  "validation_uncertainty": bootstrap(validation, scores, baseline_scores),
                  "validation_cohorts": cohort_metrics(validation, scores),
                  "validation_metadata_coverage": metadata_coverage(validation, scores, chosen["feature_schema"]),
                  "validation_clock_support": clock_support_metrics(validation, scores, chosen),
                  "validation_link_coverage": link_coverage_metrics(validation, scores),
                  "rolling_development_validation": rolling_validation(train + validation, timezone_name),
                  "policy_lift_measured": False, "locked_test_accessed_for_scoring": False,
                  "metadata_exclusions": dict(Counter(reason for row in train + validation for reason in row["metadata_excluded"].values())),
                  "environment": environment()}
    write_json(output / "model.json", chosen)
    write_json(output / "experiments.json", experiment)
    write_json(output / "dataset-manifest.json", {"dataset_sha256": dataset_sha, "split_sha256": split_sha,
                                                  "as_of": args.as_of, "label_kind": kind, "timezone": timezone_name,
                                                  "eligibility_policy": eligibility_policy, "history_scope": chosen["history_scope"],
                                                  "trained_target": trained_target,
                                                  "eligibility": exclusions,
                                                  "development_counts": {"train": len(train), "validation": len(validation)},
                                                  "feature_provenance": chosen["feature_provenance"], "environment": environment()})
    write_json(output / "model-card.json", {"schema_version": 1, "route": route, "model_version": chosen["model_version"],
                                            "family": chosen["family"], "selected_candidate": chosen["candidate"],
                                            "training_evidence": chosen["evidence"], "training_attempts": len(train),
                                            "training_proxy_positives": chosen["evidence"]["training_positives"] if experimental_mode else None,
                                            "experimental": experimental_mode, "eligibility_policy": eligibility_policy, "trained_target": trained_target,
                                            "history_scope": chosen["history_scope"], "lifetime_history_verified": not experimental_mode,
                                            "historical_availability_verified": availability_verified,
                                            "canonical_label_verified": kind == "canonical",
                                            "sequence_identity": chosen["sequence_identity"],
                                            "trained": True, "artifact_status": "offline_frozen_pending_final_evaluation",
                                            "primary_target": "meeting_done", "label_kind": kind,
                                            "validation_metrics": measured[winner]["metrics"], "held_out_metrics": None,
                                            "validation_metrics_kind": "raw_before_calibration_fit", "calibration": chosen["calibration"],
                                            "deployment_approved": False, "policy_lift_measured": False,
                                            "feature_provenance": chosen["feature_provenance"],
                                            "limitations": ["Complete-history and label verification depend on extraction evidence.",
                                                            "Observational schedules do not identify causal policy lift.",
                                                            "Calibration reuses selection validation; its independent quality is assessed only on final test."] +
                                                           (["The named target measures linked physical meeting recording, not verified canonical completion.",
                                                             "Its zero class is observed snapshot absence; unrecorded, missing-link and revised meetings can differ.",
                                                             "Current-replica prior-call search does not establish lifetime or original decision-time availability.",
                                                             "Per-row extraction times form an assembled observation bundle, not a transactional database snapshot.",
                                                             "Fixed sampled dates omit training weekday support for some future/test calls; sparse slots return null."] if experimental_mode else [])})
    write_json(output / "freeze.json", {"model_sha256": digest(output / "model.json"), "split_sha256": split_sha,
                                         "dataset_sha256": dataset_sha, "as_of": args.as_of, "eligibility_policy": eligibility_policy,
                                         "test_evaluations": 0, "frozen_at": chosen["trained_at"]})
    return {"status": "trained_frozen_offline", "route": route, "experimental": experimental_mode, "trained_target": trained_target,
            "model_version": chosen["model_version"], "selected": chosen["candidate"],
            "training_attempts": len(train), "validation_metrics": measured[winner]["metrics"],
            "validation_metrics_kind": "raw_before_calibration_fit", "calibration": chosen["calibration"], "deployment_approved": False}


def evaluate_command(args: argparse.Namespace) -> dict:
    output = Path(args.output)
    freeze = json.loads((output / "freeze.json").read_text(encoding="utf-8"))
    model_path = output / "model.json"
    if digest(model_path) != freeze["model_sha256"]:
        raise ValueError("frozen model has changed; final test denied")
    if digest(args.dataset) != freeze["dataset_sha256"] or digest(args.splits) != freeze["split_sha256"]:
        raise ValueError("dataset/splits changed since model freeze")
    if instant(args.as_of) != instant(freeze["as_of"]):
        raise ValueError("eligibility cutoff changed since model freeze")
    observed_mode = getattr(args, "observed_first_contact_proxy", False)
    general_mode = getattr(args, "general_erp_proxy", False)
    experimental_mode = observed_mode or general_mode
    trained_target = getattr(args, "proxy_target", None) if experimental_mode else "meeting_done"
    policy = "observed_first_contact_proxy" if observed_mode else "general_erp_observed_proxy" if general_mode else "verified_first_contact"
    if freeze.get("eligibility_policy", "verified_first_contact") != policy:
        raise ValueError("eligibility policy changed since model freeze")
    grouped, manifest, exclusions = load_experiment(Path(args.dataset), Path(args.splits), args.as_of, args.allow_proxy, observed_mode, general_mode, trained_target)
    rows = grouped["test"]
    if not rows:
        raise ValueError("eligible cold-start final test is empty; no held-out result")
    # Atomic create protects against accidental repeated test access/concurrent runs.
    with (output / "test-lock.json").open("x", encoding="utf-8") as handle:
        json.dump({"model_sha256": freeze["model_sha256"], "started_at": datetime.now(timezone.utc).isoformat(),
                   "test_attempts": len(rows), "status": "evaluation_started"}, handle)
    model = json.loads(model_path.read_text(encoding="utf-8"))
    if model.get("trained_target", "meeting_done") != trained_target:
        raise ValueError("named training endpoint changed since model freeze")
    baseline = dict(model, family="hour_day", calibration={"kind": "none", "calibrated": False})
    raw_selected = dict(model, calibration={"kind": "none", "calibrated": False})
    scores, baseline_scores = [predict(row, model) for row in rows], [predict(row, baseline) for row in rows]
    labels = [row["target"]["meeting_done"] for row in rows]
    measured, reference = evaluate(labels, scores), evaluate(labels, baseline_scores)
    contract = json.loads((output / "acceptance.json").read_text(encoding="utf-8"))
    support = contract["development_support_sufficient"] and len(rows) >= 30 and sum(labels) >= 5
    predictive_pass = (support and measured["brier"] <= reference["brier"] + contract["predictive_criteria"]["max_brier_degradation"]
                       and measured["log_loss"] <= reference["log_loss"] + contract["predictive_criteria"]["max_log_loss_degradation"]
                       and measured["average_precision"] is not None and measured["average_precision"] >= measured["class_prevalence"])
    result = {"model_version": model["model_version"], "route": model["route"], "experimental": experimental_mode, "trained_target": trained_target,
              "eligibility_policy": policy, "history_scope": model["history_scope"], "lifetime_history_verified": not experimental_mode,
              "historical_availability_verified": model.get("historical_availability_verified"),
              "label_kind": model["label_kind"], "primary_target": "meeting_done",
              "split": "chronological_general_erp_final_test" if general_mode else "seller_disjoint_chronological_final_test", "model_sha256": freeze["model_sha256"],
              "selected_metrics": measured, "hour_day_baseline_metrics": reference,
              "selected_raw_metrics": evaluate(labels, [predict(row, raw_selected) for row in rows]),
              "calibration": model["calibration"], "calibration_quality_assessment_split": "locked_final_test",
              "uncertainty": bootstrap(rows, scores, baseline_scores), "cohorts": cohort_metrics(rows, scores),
              "metadata_coverage": metadata_coverage(rows, scores, model["feature_schema"]),
              "clock_support": clock_support_metrics(rows, scores, model),
              "link_coverage": link_coverage_metrics(rows, scores),
              "secondary_labels": {field: {"observed": sum(row["target"].get(field) in (0, 1) for row in rows),
                                          "positive": sum(row["target"].get(field) == 1 for row in rows)} for field in ("meeting_fixed", "connected")},
              "predictive_acceptance_met": predictive_pass, "support_sufficient": support,
              "policy_lift_measured": False, "aspirational_10pct_causal_lift_assessed": False,
              "canonical_objective_verified": model["label_kind"] == "canonical",
              "deployment_approved": False, "deployment_reason": "requires verified label/first-contact coverage and prospective policy review",
              "evaluated_at": datetime.now(timezone.utc).isoformat()}
    write_json(output / "test-results.json", result)
    card = json.loads((output / "model-card.json").read_text(encoding="utf-8"))
    card.update({"artifact_status": "offline_final_evaluated", "held_out_metrics": measured,
                 "predictive_acceptance_met": predictive_pass, "test_uncertainty": result["uncertainty"],
                 "baseline_metrics": reference, "clock_support": result["clock_support"], "link_coverage": result["link_coverage"],
                 "support_sufficient": support, "frozen_model_sha256": freeze["model_sha256"],
                 "final_result_sha256": digest(output / "test-results.json"), "final_test_evaluations": 1,
                 "test_completed_at": result["evaluated_at"]})
    write_json(output / "model-card.json", card)
    write_json(output / "test-lock.json", {"model_sha256": freeze["model_sha256"], "status": "evaluation_completed",
                                             "evaluated_at": result["evaluated_at"], "result_sha256": digest(output / "test-results.json")})
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("train", "evaluate", "audit"), nargs="?", default="train")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--splits", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--as-of", required=True, help="Extraction/evaluation cutoff, explicit ISO timezone required")
    parser.add_argument("--allow-proxy", action="store_true", help="Explicitly labelled separate proxy experiment")
    parser.add_argument("--observed-first-contact-proxy", action="store_true", help="Separate experimental ERP observed-scope first-contact cohort; requires --allow-proxy and verified history_scope")
    parser.add_argument("--general-erp-proxy", action="store_true", help="Separate time-only general ERP observed-record proxy population; requires --allow-proxy")
    parser.add_argument("--proxy-target", help="Explicit named registered proxy endpoint; canonical meeting_done remains unverified")
    args = parser.parse_args()
    try:
        result = train_command(args) if args.action == "train" else audit_command(args) if args.action == "audit" else evaluate_command(args)
        print(json.dumps(result, indent=2, allow_nan=False))
    except (ValueError, FileNotFoundError, FileExistsError, KeyError) as error:
        print(json.dumps({"status": "blocked", "reason": str(error)}), file=sys.stderr)
        raise SystemExit(2) from error


if __name__ == "__main__":
    main()
