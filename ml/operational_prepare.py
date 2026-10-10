"""Prepare immutable current-replica ERP observed-record proxy data, never canonical labels."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path

TARGET = "observed_linked_physical_recorded_met_within14days"
LOCAL = timezone(timedelta(hours=5, minutes=30))


def instant(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.replace(tzinfo=LOCAL) if parsed.tzinfo is None else parsed


def iso(value: datetime) -> str:
    return value.isoformat()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def frozen(path: Path, data: bytes) -> None:
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError(f"immutable output differs: {path.name}; use a new version")
    else:
        with path.open("xb") as handle:
            handle.write(data)


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()


def meaningful(value: object) -> str | None:
    text = str(value).strip() if value is not None else ""
    return text if text.lower() not in ("", "0", "null", "na", "n/a") else None


def prepare(root: Path) -> dict:
    plan = json.loads((root / "plan.json").read_text(encoding="utf-8"))
    raw, file_checksums, source_times = [], {}, []
    for date in [d for values in plan["dates"].values() for d in values]:
        complete = False
        for page in range(plan["chunks_per_day"]):
            path = root / "raw" / f"{date}-{page}.json"
            if not path.exists():
                if complete:
                    break
                raise ValueError(f"missing planned chunk {path.name}")
            encoded = path.read_bytes()
            payload = json.loads(encoded)
            if payload["source"] != 13 or payload["queryId"] != 47566:
                raise ValueError("unexpected source or persistent query")
            if digest(payload["query"].encode()) != payload["query_sha256"]:
                raise ValueError("query checksum mismatch")
            file_checksums[str(path.relative_to(root))] = digest(encoded)
            source_times.append(instant(payload["extracted_at"]))
            for row in payload["rows"]:
                raw.append(dict(row, extracted_at=payload["extracted_at"], sampled_date=date))
            if len(payload["rows"]) < plan["per_chunk_cap"]:
                complete = True
                break
    if not raw:
        raise ValueError("actual extraction is empty")
    as_of = max(source_times)
    version = plan["version"]
    scope_id = f"erp-outgoing-current-replica-since-2026-05-01-v{version}"
    scope = {
        "scope_id": scope_id, "population": "general_erp_employee_outbound",
        "coverage_start": "2026-05-01T00:00:00+05:30",
        "coverage_end": "2026-09-26T00:00:00+05:30",
        "complete_within_scope": True, "lifetime_complete": False,
        "availability_verified": False, "prior_call_search_verified": True,
        "source_ids": [13], "source_tables": ["redash.click_to_call"],
        "coverage_definition": "EXISTS searches all qualifying rows in exposed current replica over the stated event-time range, not just sampled rows; does not establish all real calls or historical availability",
    }
    groups = defaultdict(list)
    for row in raw:
        key = meaningful(row.get("ucid"))
        groups["ucid:" + key if key else "c2c:" + row["attempt_id"]].append(row)
    quality = Counter()
    cleaned = []
    for key, values in groups.items():
        if len({r["seller_id"] for r in values}) != 1 or len({r["employee_id"] for r in values}) != 1:
            quality["ucid_identity_conflict_rows"] += len(values)
            continue
        starts = [instant(r["call_start_time"]) for r in values]
        if (max(starts) - min(starts)).total_seconds() > 60:
            quality["ucid_time_conflict_rows"] += len(values)
            continue
        # Preserve one sampled physical-call identity; never multiply meetings.
        values.sort(key=lambda row: int(row["attempt_id"]))
        selected = dict(values[0])
        selected["meetings"] = list({m["meeting_id"]: m for row in values for m in row["meetings"]}.values())
        selected["dsr_calls"] = list({c["call_id"]: c for row in values for c in row["dsr_calls"]}.values())
        selected["prior_call_exists"] = any(row["prior_call_exists"] is True for row in values)
        quality["deduplicated_rows"] += len(values) - 1
        cleaned.append((key, selected))
    split_for_date = {d: split for split, dates in plan["dates"].items() for d in dates}
    prepared, credited_meetings = [], {}
    for key, row in sorted(cleaned, key=lambda pair: (instant(pair[1]["call_start_time"]), int(pair[1]["attempt_id"]))):
        called = instant(row["call_start_time"])
        mature = called + timedelta(days=14)
        if mature > as_of:
            quality["nominal_window_immature_rows"] += 1
            continue
        if row["prior_call_exists"] not in (True, False):
            quality["unknown_prior_search_rows"] += 1
            continue
        dsr_ids = {c["call_id"] for c in row["dsr_calls"] if c["seller_id"] == row["seller_id"]}
        positives = []
        for meeting in row["meetings"]:
            quality["joined_meeting_records"] += 1
            if meeting["seller_id"] != row["seller_id"]:
                quality["meeting_seller_mismatch_records"] += 1
                continue
            if meeting["call_id"] not in dsr_ids and not (meeting["call_id"] is None and meeting["link_method"] == "reverse"):
                quality["meeting_call_conflict_records"] += 1
                continue
            if str(meeting["mode"]) != "0" or meeting["result"] is None or str(meeting["result"]) == "9":
                continue
            if not meeting.get("recorded_at"):
                quality["missing_physical_recording_time"] += 1
                continue
            recorded = instant(meeting["recorded_at"])
            if not called < recorded <= mature:
                quality["physical_outside_recording_window"] += 1
                continue
            if meeting["meeting_id"] in credited_meetings and credited_meetings[meeting["meeting_id"]] != key:
                raise ValueError("meeting receives credit for multiple attempts; reconcile before training")
            credited_meetings[meeting["meeting_id"]] = key
            positives.append(meeting)
        observed = int(bool(positives))
        observed_at = row["extracted_at"]
        quality["rows_with_matched_dsr"] += bool(dsr_ids)
        quality["rows_with_matched_meeting"] += bool(row["meetings"])
        prepared.append({
            "attempt_id": "c2c:" + row["attempt_id"], "seller_id": row["seller_id"],
            "lead_id": "erp-seller:" + row["seller_id"], "call_key": key,
            "call_at": iso(called), "available_at": observed_at,
            "timezone": "Asia/Kolkata", "timezone_provenance": "assumed_naive_ERP_India",
            "history_complete": False, "prior_attempts": int(row["prior_call_exists"]),
            "prior_count_kind": "exists_indicator_not_exact_count",
            "history_verification": {"scope_id": scope_id, "prior_call_exists": row["prior_call_exists"],
                "prior_search_verified": True, "checked_before": iso(called),
                "available_at": observed_at, "observation_as_of": observed_at},
            "metadata": {}, "metadata_provenance": {},
            "target": {"label_kind": "proxy", "meeting_done": None, TARGET: observed,
                "completion_at": min(iso(instant(m["recorded_at"])) for m in positives) if positives else None,
                "completion_time_basis": "physical_DSR_recording_time_not_measured_end",
                "mature_at": iso(mature), "label_observed_at": observed_at,
                "canonical_label_verified": False, "negative_meaning": "no_observed_linked_physical_recorded_met_record",
                "availability_verified": False},
            "experiment_split": split_for_date[row["sampled_date"]],
            "evidence": {"matched_dsr_calls": len(dsr_ids), "joined_meetings": len(row["meetings"]),
                "qualifying_physical_meetings": len(positives), "label_source": "source13_ERP_current_replica",
                "historical_feature_availability_verified": False},
        })
        if version >= 3:
            prepared[-1]["target"].update({
                "connected": int(str(row["status"]).lower() == "answered"),
                "connected_basis": "provider_reported_Answered_status_snapshot_not_verified_seller_conversation",
                "meeting_fixed": None,
            })
    encoded = ("\n".join(json.dumps(row, sort_keys=True, separators=(",", ":")) for row in prepared) + "\n").encode()
    sha = digest(encoded)
    history = {split: [row["attempt_id"] for row in prepared if row["experiment_split"] == split] for split in ("train", "validation", "test")}
    cold = {split: [] for split in history}
    zero_sellers = defaultdict(list)
    for row in prepared:
        if row["prior_attempts"] == 0:
            zero_sellers[row["seller_id"]].append(row)
    for rows in zero_sellers.values():
        if len(rows) != 1:
            quality["ambiguous_multiple_first_observed_rows"] += len(rows)
            continue
        row = rows[0]
        cold[row["experiment_split"]].append(row["attempt_id"])
    splits = {"version": version, "dataset_sha256": sha, "timezone": "Asia/Kolkata", "label_kind": "proxy",
        "target_name": TARGET, "proxy_target": TARGET, "history_scope": scope,
        "history": history, "cold_start": cold,
        "embargo_days": 14, "observation_grace_days": 0,
        "grace_definition": "nominal recording-window snapshot experiment; no verified canonical finality",
        "planned_dates": plan["dates"]}
    by_attempt = {row["attempt_id"]: row for row in prepared}
    def counts(track: dict) -> dict:
        return {split: {"rows": len(ids), "sellers": len({by_attempt[key]["seller_id"] for key in ids}),
                        "positives": sum(by_attempt[key]["target"][TARGET] for key in ids)} for split, ids in track.items()}
    manifest = {"version": version, "target_name": TARGET, "proxy_target": TARGET, "label_kind": "proxy",
        "dataset_sha256": sha, "source_ids": [13], "source_query_id": 47566,
        "as_of": iso(as_of), "canonical_label_verified": False, "historical_availability_verified": False,
        "timezone": "Asia/Kolkata", "timezone_provenance": "assumed_naive_ERP_India",
        "history_scope": scope, "raw_rows": len(raw), "deduplicated_rows": len(prepared),
        "sellers": len({row["seller_id"] for row in prepared}), "positives": sum(row["target"][TARGET] for row in prepared),
        "history_counts": counts(history), "cold_start_counts": counts(cold), "quality": dict(quality),
        "raw_file_checksums": file_checksums, "plan_sha256": digest((root / "plan.json").read_bytes()),
        "primary_objective": "canonical_meeting_done_unverified_and_deployment_blocked",
        "experimental_objective": "observed_linked_physical_recorded_met_association",
        "features_allowed": ["prospective_local_hour", "prospective_weekday"],
        "features_excluded": ["current_call_outcome", "current_call_duration", "seller_id", "employee_id", "mutable_metadata", "prior_answer_status", "prior_meeting_yield"],
        "selection": "hash-random capped eligible general ERP outgoing calls per preregistered date; no outcome-based balancing",
        "negative_definition": "no qualifying linked physical recorded-met record in extraction snapshot; not actual completion negative",
        "prehistory": "exact EXISTS in exposed current replica since May1; incomplete lifetime and historical availability",
        "caller_availability": "not assumed from mutable entered_on; employee omitted from modeling",
        "policy_lift_identified": False}
    if version >= 3:
        manifest.update({
            "preregistered_at": plan["preregistered_at"],
            "expansion_reason": plan["expansion_reason"],
            "parent_dataset_sha256": plan["parent_dataset_sha256"],
            "extraction_started_at": iso(min(source_times)),
            "single_transaction_database_snapshot": False,
            "collection_definition": "immutable bundle of per-chunk current-replica observations, with exact nested v2 checkpoints",
            "weekday_support_limit": "Monday is present in test and absent from training fixed-date sample",
            "lead_group_definition": "erp-seller:<seller_id> is a seller grouping key for split isolation, not a real source lead ID",
        })
    frozen(root / "attempts.jsonl", encoded)
    frozen(root / "splits.json", json_bytes(splits))
    frozen(root / "dataset-manifest.json", json_bytes(manifest))
    return {key: manifest[key] for key in ("raw_rows", "deduplicated_rows", "sellers", "positives", "history_counts", "cold_start_counts", "dataset_sha256", "as_of")}


def verify(root: Path) -> dict:
    """Independent artifact checks without fitting or scoring a test set."""
    manifest = json.loads((root / "dataset-manifest.json").read_text(encoding="utf-8"))
    splits = json.loads((root / "splits.json").read_text(encoding="utf-8"))
    encoded = (root / "attempts.jsonl").read_bytes()
    rows = [json.loads(line) for line in encoded.splitlines() if line.strip()]
    by_id = {row["attempt_id"]: row for row in rows}
    assert len(by_id) == len(rows), "duplicate attempts"
    assert digest(encoded) == manifest["dataset_sha256"] == splits["dataset_sha256"], "dataset checksum mismatch"
    assert all(row["target"]["meeting_done"] is None for row in rows), "proxy overwrote canonical label"
    assert all(row["metadata"] == {} and row["metadata_provenance"] == {} for row in rows), "mutable metadata entered features"
    for row in rows:
        assert instant(row["target"]["mature_at"]) <= instant(manifest["as_of"]), "immature recording window"
        if row["target"][manifest["target_name"]] == 1:
            assert instant(row["call_at"]) < instant(row["target"]["completion_at"]) <= instant(row["target"]["mature_at"]), "recording outside target window"
    cold_sellers = []
    for split in ("train", "validation", "test"):
        values = [by_id[identity] for identity in splits["cold_start"][split]]
        assert all(row["prior_attempts"] == 0 and row["history_verification"]["prior_call_exists"] is False for row in values), "cold scope lacks zero-prior evidence"
        ids = {row["seller_id"] for row in values}
        assert len(ids) == len(values), "duplicate first-observed seller"
        assert not any(ids & earlier for earlier in cold_sellers), "cold seller crosses splits"
        cold_sellers.append(ids)
    for left, right in (("train", "validation"), ("validation", "test")):
        before, after = splits["history"][left], splits["history"][right]
        if before and after:
            assert max(instant(by_id[identity]["target"]["mature_at"]) for identity in before) < min(instant(by_id[identity]["call_at"]) for identity in after), "14-day embargo violated"
    for relative, expected in manifest["raw_file_checksums"].items():
        assert digest((root / relative).read_bytes()) == expected, "raw checkpoint checksum mismatch"
    return {"status": "passed", "rows": len(rows), "checks": ["immutable_checksums", "unique_attempts", "canonical_label_null", "mutable_metadata_excluded", "target_window_maturity", "cold_prior_search", "cold_seller_disjoint", "recording_window_embargo", "raw_source_checksums"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".data/btc-operational-v2")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    print(json.dumps(verify(Path(args.root)) if args.verify else prepare(Path(args.root)), indent=2))
