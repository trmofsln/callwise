"""Compute pre-call history only from prior events known by the decision time."""
from copy import deepcopy
from collections import defaultdict
from .cold_start.contract import instant, safe_metadata


def build_asof_features(rows: list[dict]) -> list[dict]:
    history = defaultdict(list)
    result = []
    # Sorting is deterministic; simultaneous calls never see one another's outcome.
    for raw in sorted(rows, key=lambda r: (instant(r["call_at"]), str(r["attempt_id"]))):
        row = deepcopy(raw)
        at = instant(row["call_at"])
        observed = [prior for prior in history[str(row["seller_id"])]
                    if instant(prior["call_at"]) < at and instant(prior["available_at"]) <= at]
        row["safe_metadata"], row["metadata_excluded"] = safe_metadata(row, at)
        if row.get("history_complete") is True:
            row["prior_attempts"] = len(observed)
            row["prior_retry_gap_minutes"] = (at - max(instant(p["call_at"]) for p in observed)).total_seconds() / 60 if observed else None
        else:
            row["prior_attempts"] = None
            row["prior_retry_gap_minutes"] = None
        # Historical outcomes are only diagnostics and require their own reliable availability.
        known_labels = [p for p in observed if p.get("target", {}).get("label_kind") == "canonical"
                        and p["target"].get("label_available_at")
                        and instant(p["target"]["label_available_at"]) <= at
                        and instant(p["target"]["mature_at"]) <= at]
        row["prior_known_canonical_completed_meetings"] = sum(p["target"]["meeting_done"] == 1 for p in known_labels)
        row["feature_provenance"] = {"history": "strictly prior call_at and available_at; complete-history scope must be separately verified", "outcomes": "canonical only; label_available_at and maturity before decision"}
        result.append(row)
        history[str(row["seller_id"])].append(row)
    return result
