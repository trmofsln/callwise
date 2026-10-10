"""Normalize the bounded extraction, audit uncertain labels, and lock splits."""
from __future__ import annotations
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo


def instant(value: str | None, zone: str = "Asia/Kolkata") -> datetime | None:
    if not value:
        return None
    try:
        at = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return at.replace(tzinfo=ZoneInfo(zone)) if at.tzinfo is None else at
    except (ValueError, TypeError):
        return None


def meaningful_ucid(value: object) -> str | None:
    result = str(value or "").strip()
    return result if result.lower() not in ("", "0", "null", "na", "n/a", "none") else None


def successful_proxy(meeting: dict) -> bool:
    result, mode = meeting.get("result"), str(meeting.get("mode"))
    return result is not None and str(result) != "9" and (mode == "0" or (mode == "1" and str(meeting.get("verify_status")) == "9"))


def normalize(raw: dict, extracted_at: str, horizon_days: int = 14, grace_days: int = 7) -> dict:
    at = instant(raw.get("call_start_time"))
    if at is None:
        raise ValueError("attempt lacks an actual call start")
    meetings = raw.get("meetings") or []
    if isinstance(meetings, str):
        meetings = json.loads(meetings)
    seller = str(raw.get("seller_id") or "")
    linked = raw.get("dsr_seller_id") is not None and str(raw["dsr_seller_id"]) == seller
    positive = []
    for m in meetings:
        if not successful_proxy(m):
            continue
        # Physical entry is a recording time; video verification observation time is unverified.
        recorded = instant(m.get("entry_at"))
        if recorded and at <= recorded <= at + timedelta(days=horizon_days) and linked:
            positive.append(m)
    ucid = meaningful_ucid(raw.get("click_ucid")) or meaningful_ucid(raw.get("dsr_ucid"))
    status = str(raw.get("lead_call_status") or "").lower()
    return {
        "attempt_id": "hotlead:" + str(raw["attempt_id"]), "seller_id": seller,
        "lead_id": str(raw.get("lead_id") or "unmatched:" + str(raw.get("lead_type_reference"))),
        "employee_id": raw.get("click_employee_id") or raw.get("dsr_employee_id"),
        "call_at": at.isoformat(), "available_at": extracted_at,
        "history_complete": False, "prior_attempts": None,
        "metadata": {}, "metadata_provenance": {},
        "target": {"meeting_done": None, "meeting_fixed": None,
                   "connected": 1 if status == "answered" else 0 if status == "notanswered" else None,
                   "label_kind": "proxy", "completion_at": None,
                   "mature_at": (at + timedelta(days=horizon_days + grace_days)).isoformat(),
                   "observed_linked_dsr_recording_proxy": 1 if positive else 0 if linked else None,
                   "label_available_at": extracted_at},
        "source": {"id": 13, "spine": "data_hotlead_disposition_dtl", "dedup_key": "ucid:" + ucid if ucid else "hotlead:" + str(raw["attempt_id"]),
                   "timezone_provenance": "Asia/Kolkata explicitly assumed for naive DB timestamps",
                   "attribution_contract": "Canonical target unknown; provisional recording proxy uses consistent direct/reverse FK, not proximity.",
                   "dsr_link_verified": linked, "lead_join_matched": raw.get("matched_lead_type_id") is not None,
                   "click_link_verified": raw.get("click_seller_id") is not None and str(raw["click_seller_id"]) == seller},
    }


def build_splits(rows: list[dict], checksum: str) -> dict:
    contract = {"schema_version": 1, "dataset_sha256": checksum, "timezone": "Asia/Kolkata", "label_kind": "proxy",
                "embargo_days": 21, "attribution_days_assumption": 14, "verification_grace_days_assumption": 7,
                "train_end": "2026-06-24T00:00:00+05:30", "validation_start": "2026-07-15T00:00:00+05:30",
                "validation_end": "2026-08-12T00:00:00+05:30", "test_start": "2026-09-02T00:00:00+05:30",
                "history": {"train": [], "validation": [], "test": []}, "cold_start": {"train": [], "validation": [], "test": []},
                "note": "Membership locked before training; cold membership does not assert complete prehistory/first-contact eligibility."}
    train_end = instant(contract["train_end"])
    val_start, val_end, test_start = [instant(contract[k]) for k in ("validation_start", "validation_end", "test_start")]
    lead_split, seller_split = {}, {}
    for row in sorted(rows, key=lambda r: (r["call_at"], r["attempt_id"])):
        at = instant(row["call_at"])
        name = "train" if at < train_end else "validation" if val_start <= at < val_end else "test" if at >= test_start else None
        if not name:
            continue
        previous = lead_split.get(row["lead_id"])
        # Exclude later observations of a chain rather than letting it cross partitions.
        if previous and previous != name:
            continue
        lead_split[row["lead_id"]] = name
        contract["history"][name].append(row["attempt_id"])
        previous_seller = seller_split.get(row["seller_id"])
        if previous_seller is None:
            seller_split[row["seller_id"]] = name
            contract["cold_start"][name].append(row["attempt_id"])
    return contract


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", default=".data/best-time-to-call/raw")
    parser.add_argument("--output", default=".data/best-time-to-call")
    args = parser.parse_args()
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    dataset, split_file = output / "attempts.jsonl", output / "splits.json"
    if dataset.exists() or split_file.exists():
        raise SystemExit("Dataset/splits already locked; use a new run directory.")
    rows, raw_count, missing_times, manifests = [], 0, 0, []
    for file in sorted(Path(args.raw).glob("*.json")):
        payload = json.loads(file.read_text(encoding="utf-8"))
        manifests.append({"file": file.name, "sha256": hashlib.sha256(file.read_bytes()).hexdigest(), "row_count": len(payload["rows"]), "query_sha256": payload.get("query_sha256"), "extracted_at": payload["extracted_at"]})
        for raw in payload["rows"]:
            raw_count += 1
            try:
                rows.append(normalize(raw, payload["extracted_at"]))
            except ValueError:
                missing_times += 1
    if not rows:
        raise SystemExit("No extracted attempts available.")
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["source"]["dedup_key"]].append(row)
    deduped, conflicts = [], 0
    for group in grouped.values():
        if len({r["seller_id"] for r in group}) != 1:
            conflicts += len(group)
            continue
        deduped.append(min(group, key=lambda r: (r["call_at"], r["attempt_id"])))
    deduped.sort(key=lambda r: (r["call_at"], r["attempt_id"]))
    content = "".join(json.dumps(r, sort_keys=True) + "\n" for r in deduped)
    dataset.write_text(content, encoding="utf-8", newline="\n")
    sha = hashlib.sha256(dataset.read_bytes()).hexdigest()
    contract = build_splits(deduped, sha)
    split_file.write_text(json.dumps(contract, indent=2, sort_keys=True), encoding="utf-8")
    quality = {"raw_attempts": raw_count, "distinct_attempts": len(deduped), "sellers": len({r["seller_id"] for r in deduped}),
               "deduplicated": len(rows) - len(deduped) - conflicts, "conflicting_seller_ucid_rows_excluded": conflicts,
               "missing_call_times_excluded": missing_times, "coverage": [min(r["call_at"] for r in deduped), max(r["call_at"] for r in deduped)],
               "canonical_known_labels": 0, "canonical_class_prevalence": None,
               "observed_linked_recording_proxy_positives": sum(r["target"]["observed_linked_dsr_recording_proxy"] == 1 for r in deduped),
               "observed_proxy_unknown": sum(r["target"]["observed_linked_dsr_recording_proxy"] is None for r in deduped),
               "validated_joins": {field: sum(r["source"][field] for r in deduped) for field in ("dsr_link_verified", "lead_join_matched", "click_link_verified")},
               "secondary_connect_counts": dict(Counter(str(r["target"]["connected"]) for r in deduped)),
               "metadata_missingness": 1.0, "verified_complete_histories": 0,
               "checksum": sha, "splits": {track: {k: len(v) for k, v in contract[track].items()} for track in ("history", "cold_start")},
               "limits": ["Sampling is capped within fixed hour/date strata, not population representative.", "Current snapshots and unreliable last-login excluded.", "Missing joins are unknown outcomes.", "Zero observed positives cannot identify a completed-meeting classifier.", "14-day attribution and 7-day grace are provisional assumptions, not verified business definitions."]}
    for filename, value in (("data-quality.json", quality), ("dataset-manifest.json", {"schema_version": 1, "dataset_sha256": sha, "source": 13, "inputs": manifests, "quality": quality})):
        (output / filename).write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(quality, indent=2))


if __name__ == "__main__":
    main()
