"""Fail-closed first-contact eligibility and point-in-time metadata."""

from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
from pathlib import Path

CATEGORICAL_FIELDS = ("city", "state", "industry", "business_type", "segment")
METADATA_FIELDS = CATEGORICAL_FIELDS + ("account_created_at",)


def instant(value: str) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp must be an ISO string with timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("timestamp has no explicit timezone")
    return parsed


def safe_metadata(row: dict, at: datetime | None = None) -> tuple[dict, dict]:
    """Never accept a current snapshot simply because its value looks static."""
    at = at or instant(row["call_at"])
    metadata = row.get("metadata") or {}
    provenance = row.get("metadata_provenance") or {}
    accepted, excluded = {}, {}
    for field in METADATA_FIELDS:
        value = metadata.get(field)
        if value is None or value == "":
            excluded[field] = "missing"
            continue
        evidence = provenance.get(field)
        if not isinstance(evidence, dict) or not evidence.get("source"):
            excluded[field] = "unverified_provenance"
            continue
        if evidence.get("historical") is not True and evidence.get("verified_static") is not True:
            excluded[field] = "mutable_snapshot"
            continue
        try:
            known_at = instant(evidence["available_at"])
        except (ValueError, KeyError, TypeError):
            excluded[field] = "unknown_availability"
            continue
        if known_at > at:
            excluded[field] = "not_known_at_decision"
            continue
        if field == "account_created_at":
            try:
                if instant(value) > at:
                    excluded[field] = "account_created_after_decision"
                    continue
            except (ValueError, TypeError):
                excluded[field] = "invalid_timestamp"
                continue
        elif not isinstance(value, (str, int, float)) or isinstance(value, bool):
            excluded[field] = "invalid_category"
            continue
        accepted[field] = value if field == "account_created_at" else str(value)
    return accepted, excluded


def eligibility(row: dict, as_of: datetime, allow_proxy: bool = False) -> list[str]:
    issues = []
    for key in ("attempt_id", "seller_id", "lead_id"):
        if row.get(key) is None or not str(row.get(key)).strip():
            issues.append("missing_" + key)
    if row.get("history_complete") is not True:
        issues.append("history_not_verified_complete")
    # bool is not a count. Absence or failed retrieval must never imply zero.
    prior = row.get("prior_attempts")
    if isinstance(prior, bool) or not isinstance(prior, (int, float)) or prior != 0:
        issues.append("not_verified_first_contact")
    try:
        called = instant(row["call_at"])
        if called >= as_of:
            issues.append("not_historical_attempt")
    except (KeyError, ValueError, TypeError):
        called = None
        issues.append("invalid_call_time")
    try:
        if instant(row["available_at"]) > as_of:
            issues.append("observation_not_available")
    except (KeyError, ValueError, TypeError):
        issues.append("unknown_observation_availability")
    target = row.get("target") or {}
    kind = target.get("label_kind")
    if kind not in ("canonical", "proxy"):
        issues.append("unknown_label_kind")
    elif kind == "proxy" and not allow_proxy:
        issues.append("proxy_not_enabled")
    label = target.get("meeting_done")
    if isinstance(label, bool) or label not in (0, 1):
        issues.append("missing_completed_meeting_label")
    try:
        maturity = instant(target["mature_at"])
        if maturity > as_of:
            issues.append("immature_label")
        if called is not None and maturity < called:
            issues.append("maturity_before_call")
    except (KeyError, ValueError, TypeError):
        maturity = None
        issues.append("unknown_label_maturity")
    if label == 1:
        try:
            completion = instant(target["completion_at"])
            if called is not None and completion < called:
                issues.append("completion_before_call")
            if completion > as_of:
                issues.append("future_completion")
            if maturity is not None and completion > maturity:
                issues.append("completion_outside_attribution_horizon")
        except (KeyError, ValueError, TypeError):
            issues.append("missing_completion_time")
    return issues


def load_rows(path: str | Path) -> list[dict]:
    rows = []
    with Path(path).open(encoding="utf-8-sig") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"line {number}: attempt row must be an object")
            rows.append(row)
    return rows


def prepare_rows(rows: list[dict], as_of: datetime, allow_proxy: bool = False) -> tuple[list[dict], dict]:
    eligible, excluded = [], Counter()
    seen = set()
    first_seller_calls = defaultdict(list)
    for row in rows:
        attempt = str(row.get("attempt_id"))
        if attempt in seen:
            raise ValueError("duplicate attempt_id; deduplicate before training")
        seen.add(attempt)
        issues = eligibility(row, as_of, allow_proxy)
        if issues:
            excluded.update(issues)
            continue
        accepted, rejected = safe_metadata(row)
        copy = dict(row, safe_metadata=accepted, metadata_excluded=rejected)
        eligible.append(copy)
        first_seller_calls[str(row["seller_id"])].append(attempt)
    if any(len(ids) > 1 for ids in first_seller_calls.values()):
        raise ValueError("multiple claimed first calls for one seller; reconcile campaign scope/history")
    kinds = {row["target"]["label_kind"] for row in eligible}
    if len(kinds) > 1:
        raise ValueError("canonical and proxy experiments must be trained separately")
    return eligible, {"input_rows": len(rows), "eligible_rows": len(eligible), "excluded_reasons": dict(excluded)}


def split_rows(rows: list[dict], contract: dict) -> dict[str, list[dict]]:
    """Membership belongs to the shared immutable split manifest, never this trainer."""
    track = contract.get("cold_start")
    if not isinstance(track, dict):
        raise ValueError("missing cold_start split track")
    mapping = track.get("attempt_ids", track.get("assignments", track.get("attempts")))
    if mapping is None:
        mapping = {}
        for split in ("train", "validation", "test"):
            for key in track.get(split, []):
                identity = str(key)
                if identity in mapping:
                    raise ValueError("attempt appears more than once in split manifest")
                mapping[identity] = split
    if not isinstance(mapping, dict):
        raise ValueError("cold_start attempt membership must be a mapping")
    result = {name: [] for name in ("train", "validation", "test")}
    seller_split, lead_split = {}, {}
    for row in rows:
        name = mapping.get(str(row["attempt_id"]))
        if name in (None, "excluded", "embargo"):
            continue
        if name not in result:
            raise ValueError("invalid split name")
        for key, previous in (("seller_id", seller_split), ("lead_id", lead_split)):
            identity = str(row[key])
            if identity in previous and previous[identity] != name:
                raise ValueError(f"{key} crosses cold-start splits")
            previous[identity] = name
        result[name].append(row)
    for left, right in (("train", "validation"), ("validation", "test")):
        if result[left] and result[right]:
            last_call = max(instant(row["call_at"]) for row in result[left])
            next_call = min(instant(row["call_at"]) for row in result[right])
            if last_call >= next_call:
                raise ValueError("cold-start splits are not chronological")
            last_mature = max(instant(row["target"]["mature_at"]) for row in result[left])
            if last_mature > next_call:
                raise ValueError("label horizon crosses next split; add attribution embargo")
    return result
