"""Explicit named ERP proxy target and time-only general-population experiment."""

from __future__ import annotations

from collections import Counter
from datetime import datetime

from .contract import eligibility, instant, safe_metadata
from .observed_scope import validate_history_scope

GENERAL_ROUTE = "erp_outbound_observed_proxy"
PHYSICAL_TARGET = "observed_linked_physical_recorded_met_within14days"


def map_proxy_training_target(rows: list[dict], manifest: dict, target_name: str | None) -> tuple[list[dict], str]:
    """Source canonical target is preserved; loss gets a labelled internal alias."""
    declared = manifest.get("target_name", manifest.get("proxy_target", manifest.get("target")))
    if not target_name:
        raise ValueError("experimental proxy training requires explicit --proxy-target")
    if target_name != PHYSICAL_TARGET or declared != target_name:
        raise ValueError("proxy target differs from the separately registered physical-record experiment")
    result = []
    for row in rows:
        target = row.get("target") or {}
        if target.get("label_kind") != "proxy":
            raise ValueError("named proxy dataset must not contain canonical labels")
        if target.get("meeting_done") is not None:
            raise ValueError("named experimental proxy must preserve canonical meeting_done:null on disk")
        copied = dict(target)
        copied["canonical_meeting_done"] = target.get("meeting_done")
        copied["meeting_done"] = target.get(target_name)
        copied["training_target"] = target_name
        # For this proxy, the event is recording, never physical completion time.
        if "proxy_recording_at" in target:
            copied["completion_at"] = target.get("proxy_recording_at")
        result.append(dict(row, target=copied))
    return result, target_name


def prepare_general_proxy_rows(rows: list[dict], as_of: datetime, scope: dict) -> tuple[list[dict], dict]:
    """All sampled outgoing ERP attempts, no personal-history predictors or claims."""
    validate_history_scope(scope, as_of)
    result, excluded, seen = [], Counter(), set()
    for row in rows:
        attempt = str(row.get("attempt_id"))
        if attempt in seen:
            raise ValueError("duplicate attempt_id; deduplicate general ERP proxy calls before training")
        seen.add(attempt)
        issues = [value for value in eligibility(row, as_of, True) if value not in ("history_not_verified_complete", "not_verified_first_contact")]
        if (row.get("target") or {}).get("label_kind") != "proxy":
            issues.append("general_erp_experiment_requires_proxy_label")
        if row.get("history_complete") is not False:
            issues.append("general_erp_requires_explicit_incomplete_lifetime_history")
        try:
            called = instant(row["call_at"])
            if not instant(scope["coverage_start"]) <= called < instant(scope["coverage_end"]):
                issues.append("call_outside_verified_history_scope")
            if row["target"]["meeting_done"] == 1 and instant(row["target"]["completion_at"]) <= called:
                issues.append("physical_recording_not_after_call")
        except (KeyError, ValueError, TypeError):
            # Existing eligibility records missing/invalid event timestamps.
            pass
        if issues:
            excluded.update(issues)
            continue
        _, rejected = safe_metadata(row)
        # This population path is deliberately clock-only; cohort audit variables
        # and all mutable current ERP fields remain outside model features.
        rejected.update({field: "general_erp_time_only_experiment" for field in (row.get("metadata") or {})})
        result.append(dict(row, safe_metadata={}, metadata_excluded=rejected))
    return result, {"input_rows": len(rows), "eligible_rows": len(result), "excluded_reasons": dict(excluded),
                    "eligibility_policy": "general_erp_observed_proxy", "history_scope_id": scope["scope_id"],
                    "lifetime_complete": False, "historical_availability_verified": False, "canonical_label_verified": False}


def split_general_proxy_rows(rows: list[dict], manifest: dict) -> dict[str, list[dict]]:
    track = manifest.get("history")
    if not isinstance(track, dict):
        raise ValueError("general ERP proxy requires immutable history-track membership")
    mapping = {}
    for name in ("train", "validation", "test"):
        for attempt in track.get(name, []):
            identity = str(attempt)
            if identity in mapping:
                raise ValueError("general ERP attempt repeats in split manifest")
            mapping[identity] = name
    result = {name: [] for name in ("train", "validation", "test")}
    lead_membership = {}
    for row in rows:
        name = mapping.get(str(row["attempt_id"]))
        if name is None:
            continue
        lead = str(row["lead_id"])
        # Operational preparation explicitly uses this synthetic seller group;
        # it is not a real lead/retry sequence and may recur in future periods.
        synthetic_seller_group = lead == f"erp-seller:{row['seller_id']}"
        if not synthetic_seller_group:
            if lead in lead_membership and lead_membership[lead] != name:
                raise ValueError("related ERP call chain crosses partitions")
            lead_membership[lead] = name
        result[name].append(row)
    for left, right in (("train", "validation"), ("validation", "test")):
        if result[left] and result[right]:
            latest_maturity = max(instant(row["target"]["mature_at"]) for row in result[left])
            latest_call = max(instant(row["call_at"]) for row in result[left])
            earliest_next_call = min(instant(row["call_at"]) for row in result[right])
            if latest_call >= earliest_next_call or latest_maturity > earliest_next_call:
                raise ValueError("general ERP partitions violate chronology/target-window embargo")
    return result
