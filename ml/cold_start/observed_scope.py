"""Explicit proxy experiment for first contacts within a verified observed ERP scope.

This is separate from the lifetime/complete-history cold-start eligibility contract.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime

from .contract import eligibility, instant, safe_metadata

ROUTE = "cold_start_observed_scope"


def validate_history_scope(scope: dict, as_of: datetime) -> None:
    if not isinstance(scope, dict) or not isinstance(scope.get("scope_id"), str) or not scope["scope_id"].strip():
        raise ValueError("observed first-contact experiment requires a named history_scope")
    if scope.get("population") != "general_erp_employee_outbound":
        raise ValueError("observed history scope must identify the separate general ERP outbound population")
    if scope.get("complete_within_scope") is not True or scope.get("prior_call_search_verified") is not True:
        raise ValueError("observed scope requires verified coverage and DB prior-call search")
    if scope.get("lifetime_complete") is not False:
        raise ValueError("observed scope must explicitly disclose lifetime_complete:false")
    if scope.get("availability_verified") is not False:
        raise ValueError("observed scope must disclose availability_verified:false for the current-record experiment")
    if not isinstance(scope.get("source_ids"), list) or not scope["source_ids"]:
        raise ValueError("observed scope source IDs are missing")
    if not isinstance(scope.get("source_tables"), list) or not scope["source_tables"] or any(not isinstance(value, str) or not value.strip() for value in scope["source_tables"]):
        raise ValueError("observed scope source tables are missing")
    try:
        starts, ends = instant(scope["coverage_start"]), instant(scope["coverage_end"])
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError("observed scope requires explicit coverage timestamps") from error
    if starts >= ends or ends > as_of:
        raise ValueError("observed scope coverage must be ordered and available by extraction cutoff")


def verification_issues(row: dict, at: datetime, as_of: datetime, scope_id: str) -> list[str]:
    issues = []
    # A current data fetch or a sampled first row cannot supply this evidence.
    verification = row.get("history_verification")
    if not isinstance(verification, dict):
        return ["missing_observed_scope_verification"]
    if verification.get("scope_id") != scope_id:
        issues.append("history_scope_mismatch")
    if verification.get("prior_search_verified") is not True:
        issues.append("prior_call_search_not_verified")
    if verification.get("prior_call_exists") is not False:
        issues.append("prior_call_in_scope_or_unknown")
    try:
        if instant(verification["checked_before"]) != at:
            issues.append("prior_call_search_boundary_mismatch")
        if instant(verification["available_at"]) > as_of:
            issues.append("history_verification_unavailable")
        if instant(verification["observation_as_of"]) > as_of:
            issues.append("history_scope_observation_in_future")
    except (KeyError, ValueError, TypeError):
        issues.append("unknown_history_verification_timestamps")
    return issues


def observed_eligibility(row: dict, as_of: datetime, scope: dict) -> list[str]:
    validate_history_scope(scope, as_of)
    # Preserve all identity, zero-prior-count, observation and label safeguards.
    # Only the complete-lifetime requirement is replaced by named scope evidence.
    issues = [value for value in eligibility(row, as_of, allow_proxy=True) if value != "history_not_verified_complete"]
    if row.get("history_complete") is not False:
        issues.append("observed_scope_requires_explicit_incomplete_lifetime_history")
    if (row.get("target") or {}).get("label_kind") != "proxy":
        issues.append("observed_scope_experiment_requires_proxy_label")
    try:
        called = instant(row["call_at"])
    except (KeyError, ValueError, TypeError):
        return issues
    if not instant(scope["coverage_start"]) <= called < instant(scope["coverage_end"]):
        issues.append("call_outside_verified_history_scope")
    issues.extend(verification_issues(row, called, as_of, scope["scope_id"]))
    return issues


def prepare_observed_rows(rows: list[dict], as_of: datetime, scope: dict) -> tuple[list[dict], dict]:
    validate_history_scope(scope, as_of)
    eligible, excluded, seen = [], Counter(), set()
    first_seller_calls = defaultdict(list)
    for row in rows:
        attempt = str(row.get("attempt_id"))
        if attempt in seen:
            raise ValueError("duplicate attempt_id; deduplicate before observed-scope training")
        seen.add(attempt)
        issues = observed_eligibility(row, as_of, scope)
        if issues:
            excluded.update(issues)
            continue
        accepted, rejected = safe_metadata(row)
        # Current observed ERP replicas provide no CDC/as-of metadata proof.
        # Only independently verified static fields can augment this experiment.
        for field in list(accepted):
            if row.get("metadata_provenance", {}).get(field, {}).get("verified_static") is not True:
                del accepted[field]
                rejected[field] = "observed_scope_requires_verified_static_metadata"
        eligible.append(dict(row, safe_metadata=accepted, metadata_excluded=rejected))
        first_seller_calls[str(row["seller_id"])].append(attempt)
    if any(len(ids) > 1 for ids in first_seller_calls.values()):
        raise ValueError("multiple claimed first calls for one seller in observed history scope")
    return eligible, {"input_rows": len(rows), "eligible_rows": len(eligible), "excluded_reasons": dict(excluded),
                      "eligibility_policy": "observed_first_contact_proxy", "history_scope_id": scope["scope_id"],
                      "lifetime_complete": False, "historical_availability_verified": False, "canonical_label_verified": False}


def score_observed_scope_windows(artifact: dict, context: dict, windows: list[dict], minimum_slot_support: int = 5) -> list[dict]:
    """Numerical experimental scoring; backend separately owns scheduling constraints."""
    from .models import predict, smooth_score
    if artifact.get("route") != ROUTE or artifact.get("label_kind") != "proxy":
        raise ValueError("observed-scope scoring requires its separate proxy artifact")
    if context.get("history_complete") is not False or isinstance(context.get("prior_attempts"), bool) or context.get("prior_attempts") != 0:
        raise ValueError("observed-scope scoring requires explicit incomplete lifetime and zero scoped prior calls")
    at = instant(context["as_of"])
    scope = artifact["history_scope"]
    issues = verification_issues(context, at, at, scope["scope_id"])
    if issues:
        raise ValueError("observed-scope inference history checks failed: " + ", ".join(issues))
    metadata, excluded = safe_metadata(dict(context, call_at=context["as_of"]), at)
    for field in list(metadata):
        if context.get("metadata_provenance", {}).get(field, {}).get("verified_static") is not True:
            del metadata[field]
            excluded[field] = "observed_scope_requires_verified_static_metadata"
    scored = []
    for window in windows:
        starts, ends = instant(window["start"]), instant(window["end"])
        if starts <= at or ends <= starts:
            raise ValueError("window must be future and have positive duration")
        row = dict(context, call_at=window["start"], safe_metadata=metadata)
        _, support, source = smooth_score(row, artifact, artifact["family"] == "cohort_hour_day")
        probability = predict(row, artifact) if support >= minimum_slot_support else None
        calibrated = artifact.get("calibration", {}).get("calibrated") is True
        scored.append(dict(window, probability=probability, observed_slot_support=support, support_source=source,
                           metadata_excluded=excluded, experimental=True, route=ROUTE, label_kind="proxy",
                           lifetime_history_verified=False, canonical_label_verified=False,
                           score_status=("experimental_validation_calibrated" if calibrated else "experimental_uncalibrated") if probability is not None else "insufficient_support"))
    return sorted(scored, key=lambda row: (row["probability"] is None, -(row["probability"] or 0), row["start"]))
