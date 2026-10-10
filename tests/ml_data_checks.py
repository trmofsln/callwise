"""Synthetic contract tests; no outputs are retained or used as measured ML results."""
import unittest
from copy import deepcopy
from datetime import datetime, timezone
from ml.prepare import normalize, meaningful_ucid, build_splits
from ml.asof import build_asof_features
from ml.history_train import eligible, partitions, calibrate, features


def attempt(aid="1", call="2026-05-01T10:00:00+05:30"):
    return {"attempt_id": aid, "seller_id": "s", "lead_id": "l", "call_at": call, "available_at": "2026-05-01T04:40:00Z", "history_complete": True, "prior_attempts": 1,
            "metadata": {}, "metadata_provenance": {}, "target": {"meeting_done": 0, "meeting_fixed": None, "label_kind": "canonical", "completion_at": None, "mature_at": "2026-05-15T00:00:00Z", "label_available_at": "2026-05-15T00:00:00Z"}}


class ContractTests(unittest.TestCase):
    def test_meaningful_ucid_dedup_keys(self):
        for value in (None, "", "0", "NULL", " NA ", "n/a"):
            self.assertIsNone(meaningful_ucid(value))
        self.assertEqual(meaningful_ucid("  abc  "), "abc")

    def test_missing_call_join_is_unknown_outcome_not_negative(self):
        raw = {"attempt_id": "1", "seller_id": "s", "call_start_time": "2026-05-01T10:00:00", "lead_call_status": "Initiated", "meetings": []}
        row = normalize(raw, "2026-10-01T00:00:00Z")
        self.assertIsNone(row["target"]["meeting_done"])
        self.assertIsNone(row["target"]["observed_linked_dsr_recording_proxy"])
        self.assertIsNone(row["target"]["connected"])
        self.assertFalse(row["history_complete"])
        self.assertIsNone(row["prior_attempts"])

    def test_linked_recording_proxy_never_promotes_canonical_target(self):
        raw = {"attempt_id": "1", "seller_id": "s", "dsr_seller_id": "s", "call_start_time": "2026-05-01T10:00:00", "meetings": [{"mode": 0, "result": 1, "entry_at": "2026-05-02T12:00:00"}]}
        row = normalize(raw, "2026-10-01T00:00:00Z")
        self.assertEqual(row["target"]["observed_linked_dsr_recording_proxy"], 1)
        self.assertIsNone(row["target"]["meeting_done"])
        raw["dsr_seller_id"] = "another-seller"
        self.assertIsNone(normalize(raw,"2026-10-01T00:00:00Z")["target"]["observed_linked_dsr_recording_proxy"])

    def test_asof_never_uses_current_or_future_outcomes(self):
        first = attempt("1")
        first["target"]["meeting_done"] = 1
        first["target"]["completion_at"] = "2026-05-02T00:00:00Z"
        second = attempt("2", "2026-05-01T12:00:00+05:30")
        second["available_at"] = "2026-05-01T07:00:00Z"
        rows = build_asof_features([second, first])
        self.assertEqual(rows[0]["prior_attempts"], 0)
        self.assertEqual(rows[1]["prior_attempts"], 1)
        self.assertEqual(rows[1]["prior_known_canonical_completed_meetings"], 0)
        first["available_at"] = "2026-05-03T00:00:00Z"
        self.assertEqual(build_asof_features([first,second])[1]["prior_attempts"],0)

    def test_current_snapshot_metadata_is_excluded(self):
        row = attempt()
        row["metadata"] = {"industry": "future-category"}
        row["metadata_provenance"] = {"industry": {"source": "current", "historical": False, "available_at": "2026-05-01T00:00:00Z"}}
        self.assertEqual(build_asof_features([row])[0]["safe_metadata"],{})

    def test_split_rejects_retry_chain_crossing_and_horizon_overlap(self):
        a,b = attempt("a"),attempt("b", "2026-07-15T10:00:00+05:30")
        m = {"history": {"train":["a"],"validation":["b"],"test":[]}}
        with self.assertRaisesRegex(ValueError,"chain"):
            partitions([a,b],m)
        b["lead_id"] = "different"
        a["target"]["mature_at"] = "2026-07-16T00:00:00Z"
        with self.assertRaisesRegex(ValueError,"embargo"):
            partitions([a,b],m)

    def test_locked_membership_keeps_cold_sellers_disjoint(self):
        a,b = attempt("a"),attempt("b", "2026-09-02T10:00:00+05:30")
        b["lead_id"] = "new-lead"
        c = deepcopy(b); c["seller_id"] = "new";c["attempt_id"] = "c";c["lead_id"] = "newer"
        splits = build_splits([a,b,c], "a"*64)
        self.assertEqual(splits["cold_start"]["train"],["a"])
        self.assertEqual(splits["cold_start"]["test"],["c"])

    def test_immature_unknown_labels_and_missing_history_are_excluded(self):
        row = attempt()
        row["target"]["mature_at"] = "2027-01-01T00:00:00Z"
        self.assertEqual(eligible([row],"2026-10-01T00:00:00Z",False)[0],[])
        row["target"]["meeting_done"] = None
        row["history_complete"] = False
        audit=eligible([row],"2026-10-01T00:00:00Z",False)[1]
        self.assertIn("unknown_completed_meeting_label",audit["exclusions"])

    def test_calibration_requires_measured_positive_negative_support(self):
        self.assertFalse(calibrate([0]*50,[.1]*50)["calibrated"])
        result=calibrate([0,1]*30,[.1,.4]*30)
        self.assertTrue(result["calibrated"])
        self.assertTrue(all(isinstance(result[k],float) for k in ("slope","intercept")))


if __name__ == "__main__":
    unittest.main()
