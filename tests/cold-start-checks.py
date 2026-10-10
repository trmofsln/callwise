"""Unit fixtures only. These synthetic records never become reported ML evidence."""

import argparse
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import math
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.cold_start.contract import eligibility, instant, prepare_rows, safe_metadata, split_rows
from ml.cold_start.calibration import apply_calibration, fit_platt
from ml.cold_start.metrics import budget_yield, evaluate
from ml.cold_start.models import features, fit_feature_schema, fit_smoothing, predict, score_windows
from ml.cold_start.train import audit_command, digest, evaluate_command, train_command
from ml.cold_start.observed_scope import observed_eligibility, prepare_observed_rows, score_observed_scope_windows
from ml.cold_start.experimental_proxy import PHYSICAL_TARGET, map_proxy_training_target


def attempt(index=0, called="2026-01-05T10:00:00+05:30", label=0):
    time = instant(called)
    return {"attempt_id": f"a{index}", "seller_id": f"s{index}", "lead_id": f"l{index}", "employee_id": "emp",
            "call_at": called, "available_at": (time + timedelta(minutes=1)).isoformat(),
            "history_complete": True, "prior_attempts": 0,
            "metadata": {"industry": "hardware", "state": "Maharashtra", "account_created_at": "2025-01-01T00:00:00+05:30"},
            "metadata_provenance": {field: {"source": "verified_fixture", "available_at": "2025-01-01T00:00:00+05:30", "historical": True}
                                    for field in ("industry", "state", "account_created_at")},
            "target": {"meeting_done": label, "meeting_fixed": None, "connected": None, "label_kind": "canonical",
                       "completion_at": (time + timedelta(days=1)).isoformat() if label else None,
                       "mature_at": (time + timedelta(days=7)).isoformat()}, "source": "unit_fixture"}


class ColdStartContractTests(unittest.TestCase):
    as_of = instant("2026-10-10T00:00:00+05:30")

    def test_missing_fetch_is_not_cold_start(self):
        row = attempt()
        del row["history_complete"]
        self.assertIn("history_not_verified_complete", eligibility(row, self.as_of))
        row["history_complete"] = True
        row["prior_attempts"] = False
        self.assertIn("not_verified_first_contact", eligibility(row, self.as_of))

    def test_proxy_requires_explicit_opt_in(self):
        row = attempt()
        row["target"]["label_kind"] = "proxy"
        self.assertIn("proxy_not_enabled", eligibility(row, self.as_of))
        self.assertEqual(eligibility(row, self.as_of, True), [])

    def test_positive_requires_attributable_timestamp(self):
        row = attempt(label=1)
        row["target"]["completion_at"] = "2026-01-04T10:00:00+05:30"
        self.assertIn("completion_before_call", eligibility(row, self.as_of))
        row["target"]["completion_at"] = "2026-02-04T10:00:00+05:30"
        self.assertIn("completion_outside_attribution_horizon", eligibility(row, self.as_of))

    def test_immature_and_unavailable_rows_excluded(self):
        row = attempt()
        row["target"]["mature_at"] = "2027-01-01T00:00:00+05:30"
        row["available_at"] = "2027-01-01T00:00:00+05:30"
        self.assertIn("immature_label", eligibility(row, self.as_of))
        self.assertIn("observation_not_available", eligibility(row, self.as_of))

    def test_naive_call_timezone_rejected(self):
        with self.assertRaises(ValueError):
            instant("2026-01-01T10:00:00")

    def test_mutable_late_unknown_metadata_excluded(self):
        row = attempt()
        row["metadata_provenance"]["industry"]["historical"] = False
        row["metadata_provenance"]["state"]["available_at"] = "2026-02-01T00:00:00+05:30"
        del row["metadata_provenance"]["account_created_at"]
        safe, excluded = safe_metadata(row)
        self.assertEqual(safe, {})
        self.assertEqual(excluded["industry"], "mutable_snapshot")
        self.assertEqual(excluded["state"], "not_known_at_decision")
        self.assertEqual(excluded["account_created_at"], "unverified_provenance")

    def test_verified_static_still_needs_available_timestamp(self):
        row = attempt()
        row["metadata_provenance"]["industry"] = {"source": "fixture", "verified_static": True}
        self.assertNotIn("industry", safe_metadata(row)[0])

    def test_duplicates_and_multiple_first_contacts_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            prepare_rows([attempt(), attempt()], self.as_of)
        other = attempt(1)
        other["seller_id"] = "s0"
        with self.assertRaisesRegex(ValueError, "multiple claimed first"):
            prepare_rows([attempt(), other], self.as_of)

    def test_label_kinds_never_mixed(self):
        second = attempt(1)
        second["target"]["label_kind"] = "proxy"
        with self.assertRaisesRegex(ValueError, "separately"):
            prepare_rows([attempt(), second], self.as_of, True)

    def test_split_isolation_and_label_embargo(self):
        first, second = attempt(), attempt(1, "2026-02-01T10:00:00+05:30")
        second["seller_id"] = first["seller_id"]
        manifest = {"cold_start": {"train": ["a0"], "validation": ["a1"], "test": []}}
        with self.assertRaisesRegex(ValueError, "seller_id crosses"):
            split_rows([first, second], manifest)
        second["seller_id"] = "s1"
        first["target"]["mature_at"] = "2026-02-02T00:00:00+05:30"
        with self.assertRaisesRegex(ValueError, "embargo"):
            split_rows([first, second], manifest)


class ColdStartNumericalTests(unittest.TestCase):
    def rows(self):
        return prepare_rows([attempt(index, label=index % 2) for index in range(10)], ColdStartContractTests.as_of)[0]

    def test_train_fit_categories_and_unseen_mapping(self):
        rows = self.rows()
        schema = fit_feature_schema(rows, "Asia/Kolkata")
        changed = deepcopy(rows[0])
        changed["safe_metadata"]["industry"] = "held_out_only"
        vector = features(changed, schema)
        self.assertNotIn("held_out_only", schema["categories"]["industry"])
        self.assertEqual(vector[schema["feature_names"].index("industry=__other__")], 1)
        self.assertTrue(all(isinstance(value, float) for value in vector))

    def test_periodic_feature_and_account_age(self):
        row = self.rows()[0]
        schema = fit_feature_schema([row], "Asia/Kolkata")
        vector = dict(zip(schema["feature_names"], features(row, schema)))
        self.assertAlmostEqual(vector["hour_sin"], .5)
        self.assertEqual(vector["weekday_0"], 1)
        self.assertGreater(vector["account_age_log1p"], 0)
        self.assertEqual(vector["account_age_missing"], 0)

    def test_ties_do_not_inflate_budget_yield(self):
        measured = evaluate([1, 0, 0, 0], [.25] * 4)
        self.assertEqual(measured["average_precision"], .25)
        self.assertEqual(measured["roc_auc"], .5)
        self.assertEqual(budget_yield([1, 0, 0, 0], [.25] * 4)["yield"], .25)

    def test_perfect_and_single_class_metrics(self):
        measured = evaluate([1, 0], [1, 0])
        self.assertEqual(measured["average_precision"], 1)
        self.assertEqual(measured["roc_auc"], 1)
        self.assertEqual(measured["brier"], 0)
        self.assertIsNone(evaluate([0], [.1])["average_precision"])
        self.assertIsNone(evaluate([0], [.1])["roc_auc"])

    def test_unsupported_window_has_null_score_and_route_guard(self):
        rows = self.rows()
        artifact = {"timezone": "Asia/Kolkata", "family": "hour_day", "smoothing": fit_smoothing(rows, "Asia/Kolkata")}
        context = dict(rows[0], as_of="2026-01-11T09:00:00+05:30")
        windows = [{"start": "2026-01-12T10:00:00+05:30", "end": "2026-01-12T11:00:00+05:30"},
                   {"start": "2026-01-12T11:00:00+05:30", "end": "2026-01-12T12:00:00+05:30"}]
        scored = score_windows(artifact, context, windows)
        self.assertIsNotNone(scored[0]["probability"])
        self.assertIsNone(scored[1]["probability"])
        self.assertEqual(scored[1]["score_status"], "insufficient_support")
        context["history_complete"] = False
        with self.assertRaisesRegex(ValueError, "verified complete"):
            score_windows(artifact, context, windows)

    def test_metadata_cutoff_is_decision_not_future_window(self):
        rows = self.rows()
        artifact = {"timezone": "Asia/Kolkata", "family": "hour_day", "smoothing": fit_smoothing(rows, "Asia/Kolkata")}
        context = dict(rows[0], as_of="2026-01-11T09:00:00+05:30")
        context["metadata_provenance"]["industry"]["available_at"] = "2026-01-12T09:00:00+05:30"
        windows = [{"start": "2026-01-12T10:00:00+05:30", "end": "2026-01-12T11:00:00+05:30"}]
        result = score_windows(artifact, context, windows)[0]
        self.assertEqual(result["metadata_excluded"]["industry"], "not_known_at_decision")

    def test_freeze_checksum_and_single_test_access(self):
        # Temporary fixture output is removed, and never checked in or used as evidence.
        with tempfile.TemporaryDirectory(prefix="cold-start-unit-fixture-") as directory:
            root = Path(directory)
            rows = []
            membership = {"train": [], "validation": [], "test": []}
            index = 0
            for name, date, count in (("train", "2026-01-05", 40), ("validation", "2026-01-30", 15), ("test", "2026-02-25", 15)):
                for local in range(count):
                    row = attempt(index, date + f"T{10 + local % 2:02}:00:00+05:30", int(local % 4 == 0))
                    rows.append(row)
                    membership[name].append(row["attempt_id"])
                    index += 1
            dataset = root / "fixture.jsonl"
            dataset.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            splits = root / "splits.json"
            splits.write_text(json.dumps({"schema_version": 1, "dataset_sha256": digest(dataset), "timezone": "Asia/Kolkata", "label_kind": "canonical", "cold_start": membership}), encoding="utf-8")
            args = argparse.Namespace(dataset=str(dataset), splits=str(splits), output=str(root / "model"), as_of="2026-10-10T00:00:00+05:30", allow_proxy=False)
            result = train_command(args)
            self.assertFalse(result["deployment_approved"])
            self.assertEqual(result["calibration"]["kind"], "none")
            final = evaluate_command(args)
            self.assertFalse(final["policy_lift_measured"])
            self.assertFalse(final["support_sufficient"])
            with self.assertRaises(FileExistsError):
                evaluate_command(args)
            with self.assertRaisesRegex(ValueError, "already frozen"):
                train_command(args)


class ColdStartCalibrationTests(unittest.TestCase):
    def test_calibration_requires_twenty_per_class(self):
        result = fit_platt([1] * 19 + [0] * 20, [.6] * 19 + [.4] * 20)
        self.assertEqual(result["kind"], "none")
        self.assertFalse(result["calibrated"])
        self.assertEqual(result["validation_positives"], 19)
        self.assertEqual(apply_calibration(.4, result), .4)
        self.assertFalse(fit_platt([1] * 19 + [0] * 20, [.6] * 19 + [.4] * 20, minimum_per_class=1)["calibrated"])

    def test_perfectly_separated_extreme_scores_stay_finite(self):
        result = fit_platt([1] * 20 + [0] * 20, [1.] * 20 + [0.] * 20)
        self.assertEqual(result["kind"], "platt")
        self.assertTrue(result["calibrated"])
        self.assertTrue(math.isfinite(result["slope"]))
        self.assertTrue(math.isfinite(result["intercept"]))
        for probability in (0., .1, .5, .9, 1.):
            score = apply_calibration(probability, result)
            self.assertTrue(math.isfinite(score))
            self.assertGreater(score, 0)
            self.assertLess(score, 1)

    def test_constant_scores_are_finite_and_order_is_preserved(self):
        result = fit_platt([1] * 20 + [0] * 20, [.01] * 40)
        self.assertEqual(result["kind"], "platt")
        self.assertGreaterEqual(result["slope"], 0)
        self.assertAlmostEqual(apply_calibration(.01, result), .5, places=4)
        self.assertLessEqual(apply_calibration(.1, result), apply_calibration(.9, result))

    def test_nonfinite_probability_rejected(self):
        with self.assertRaisesRegex(ValueError, "outside"):
            fit_platt([1] * 20 + [0] * 20, [math.nan] + [.5] * 39)

    def test_only_validation_fits_and_frozen_test_never_refits(self):
        with tempfile.TemporaryDirectory(prefix="cold-start-calibration-fixture-") as directory:
            root, rows = Path(directory), []
            membership = {"train": [], "validation": [], "test": []}
            for name, date, count in (("train", "2026-01-05", 40), ("validation", "2026-01-30", 40), ("test", "2026-02-25", 30)):
                for local in range(count):
                    row = attempt(len(rows), date + f"T{10 + local % 2:02}:00:00+05:30", int(local % 2 == 0))
                    rows.append(row)
                    membership[name].append(row["attempt_id"])
            dataset = root / "fixture.jsonl"
            dataset.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            splits = root / "splits.json"
            splits.write_text(json.dumps({"schema_version": 1, "dataset_sha256": digest(dataset), "timezone": "Asia/Kolkata", "label_kind": "canonical", "cold_start": membership}), encoding="utf-8")
            args = argparse.Namespace(dataset=str(dataset), splits=str(splits), output=str(root / "model"), as_of="2026-10-10T00:00:00+05:30", allow_proxy=False)
            with patch("ml.cold_start.train.fit_platt", wraps=fit_platt) as fitted:
                result = train_command(args)
            self.assertEqual(fitted.call_count, 1)
            self.assertEqual(len(fitted.call_args.args[0]), 40)
            self.assertEqual(fitted.call_args.args[0], [row["target"]["meeting_done"] for row in rows[40:80]])
            self.assertEqual(result["calibration"]["kind"], "platt")
            self.assertEqual(result["validation_metrics_kind"], "raw_before_calibration_fit")
            self.assertTrue(result["calibration"]["validation_reused_for_selection"])
            self.assertFalse(result["calibration"]["independent_calibrated_validation_metrics"])
            artifact = root / "model" / "model.json"
            frozen_sha = digest(artifact)
            with patch("ml.cold_start.train.fit_platt", side_effect=AssertionError("test must never fit calibration")):
                final = evaluate_command(args)
            self.assertEqual(final["calibration"], result["calibration"])
            self.assertEqual(final["calibration_quality_assessment_split"], "locked_final_test")
            self.assertIn("selected_raw_metrics", final)
            self.assertEqual(digest(artifact), frozen_sha)


class ObservedScopeProxyTests(unittest.TestCase):
    def scope(self):
        return {"scope_id": "unit-erp-scope", "population": "general_erp_employee_outbound",
                "coverage_start": "2026-01-01T00:00:00+05:30", "coverage_end": "2026-03-01T00:00:00+05:30",
                "complete_within_scope": True, "lifetime_complete": False, "prior_call_search_verified": True,
                "availability_verified": False,
                "source_ids": [13], "source_tables": ["redash.click_to_call", "redash.sts_dsr_call"]}

    def row(self, index=0, called="2026-01-05T10:00:00+05:30", label=0):
        row = attempt(index, called, label)
        row["target"]["label_kind"] = "proxy"
        row["history_complete"] = False
        row["history_verification"] = {"scope_id": "unit-erp-scope", "prior_call_exists": False,
                                       "prior_search_verified": True, "checked_before": called,
                                       "available_at": row["available_at"], "observation_as_of": row["available_at"]}
        return row

    def test_explicit_scope_does_not_change_strict_eligibility(self):
        row = self.row()
        self.assertIn("history_not_verified_complete", eligibility(row, ColdStartContractTests.as_of, True))
        self.assertEqual(observed_eligibility(row, ColdStartContractTests.as_of, self.scope()), [])

    def test_missing_prior_search_and_unknown_prior_never_qualify(self):
        row = self.row()
        row["history_verification"]["prior_search_verified"] = False
        row["history_verification"]["prior_call_exists"] = None
        issues = observed_eligibility(row, ColdStartContractTests.as_of, self.scope())
        self.assertIn("prior_call_search_not_verified", issues)
        self.assertIn("prior_call_in_scope_or_unknown", issues)
        del row["history_verification"]
        self.assertIn("missing_observed_scope_verification", observed_eligibility(row, ColdStartContractTests.as_of, self.scope()))

    def test_search_boundary_scope_and_availability_checked(self):
        row = self.row()
        row["history_verification"].update(scope_id="different", checked_before="2026-01-06T00:00:00+05:30", available_at="2027-01-01T00:00:00+05:30")
        issues = observed_eligibility(row, ColdStartContractTests.as_of, self.scope())
        self.assertIn("history_scope_mismatch", issues)
        self.assertIn("prior_call_search_boundary_mismatch", issues)
        self.assertIn("history_verification_unavailable", issues)

    def test_incomplete_scope_or_canonical_promotion_rejected(self):
        scope = self.scope()
        scope["complete_within_scope"] = False
        with self.assertRaisesRegex(ValueError, "coverage"):
            prepare_observed_rows([self.row()], ColdStartContractTests.as_of, scope)
        row = self.row()
        row["target"]["label_kind"] = "canonical"
        self.assertIn("observed_scope_experiment_requires_proxy_label", observed_eligibility(row, ColdStartContractTests.as_of, self.scope()))
        row = self.row(called="2025-12-31T10:00:00+05:30")
        self.assertIn("call_outside_verified_history_scope", observed_eligibility(row, ColdStartContractTests.as_of, self.scope()))

    def test_new_route_freezes_and_evaluates_separately(self):
        with tempfile.TemporaryDirectory(prefix="observed-scope-proxy-unit-fixture-") as directory:
            root, rows = Path(directory), []
            membership = {"train": [], "validation": [], "test": []}
            for name, date, count in (("train", "2026-01-05", 40), ("validation", "2026-01-30", 40), ("test", "2026-02-25", 30)):
                for local in range(count):
                    row = self.row(len(rows), date + f"T{10 + local % 2:02}:00:00+05:30", int(local % 2 == 0))
                    row["target"][PHYSICAL_TARGET] = row["target"]["meeting_done"]
                    row["target"]["meeting_done"] = None
                    rows.append(row)
                    membership[name].append(row["attempt_id"])
            dataset, splits = root / "fixture.jsonl", root / "splits.json"
            dataset.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            splits.write_text(json.dumps({"schema_version": 1, "dataset_sha256": digest(dataset), "timezone": "Asia/Kolkata",
                                          "label_kind": "proxy", "history_scope": self.scope(), "cold_start": membership}), encoding="utf-8")
            payload = json.loads(splits.read_text(encoding="utf-8"))
            payload["target_name"] = PHYSICAL_TARGET
            splits.write_text(json.dumps(payload), encoding="utf-8")
            args = argparse.Namespace(dataset=str(dataset), splits=str(splits), output=str(root / "model"), as_of="2026-10-10T00:00:00+05:30", allow_proxy=False, observed_first_contact_proxy=True, proxy_target=PHYSICAL_TARGET)
            with self.assertRaisesRegex(ValueError, "explicit --allow-proxy"):
                train_command(args)
            args.allow_proxy = True
            audited = audit_command(args)
            self.assertFalse(audited["trained"])
            self.assertFalse(audited["test_scores_accessed"])
            self.assertIsNone(audited["held_out_metrics"])
            result = train_command(args)
            self.assertEqual(result["route"], "cold_start_observed_scope")
            self.assertTrue(result["experimental"])
            model = json.loads((root / "model" / "model.json").read_text(encoding="utf-8"))
            self.assertFalse(model["lifetime_history_verified"])
            self.assertFalse(model["historical_availability_verified"])
            self.assertEqual(model["feature_schema"]["categories"], {})
            self.assertEqual(model["label_kind"], "proxy")
            self.assertEqual(model["trained_target"], PHYSICAL_TARGET)
            args.observed_first_contact_proxy = False
            with self.assertRaisesRegex(ValueError, "policy changed"):
                evaluate_command(args)
            args.observed_first_contact_proxy = True
            final = evaluate_command(args)
            self.assertFalse(final["canonical_objective_verified"])
            self.assertFalse(final["deployment_approved"])
            with self.assertRaisesRegex(ValueError, "cannot replace"):
                audit_command(args)
            self.assertEqual(final["history_scope"]["scope_id"], "unit-erp-scope")
            context = dict(self.row(), as_of="2026-10-11T00:00:00+05:30")
            context["history_verification"].update(checked_before=context["as_of"], available_at=context["as_of"], observation_as_of=context["as_of"])
            scored = score_observed_scope_windows(model, context, [{"start": "2026-10-12T10:00:00+05:30", "end": "2026-10-12T11:00:00+05:30"}])
            self.assertTrue(scored[0]["experimental"])
            self.assertFalse(scored[0]["canonical_label_verified"])
            with self.assertRaisesRegex(ValueError, "verified complete"):
                score_windows(model, context, [{"start": "2026-10-12T10:00:00+05:30", "end": "2026-10-12T11:00:00+05:30"}])

    def test_named_proxy_alias_preserves_canonical_source(self):
        row = self.row(label=1)
        row["target"].update(meeting_done=None, observed_linked_physical_recorded_met_within14days=1)
        mapped, name = map_proxy_training_target([row], {"target_name": PHYSICAL_TARGET}, PHYSICAL_TARGET)
        self.assertEqual(name, PHYSICAL_TARGET)
        self.assertIsNone(row["target"]["meeting_done"])
        self.assertEqual(mapped[0]["target"]["meeting_done"], 1)
        self.assertIsNone(mapped[0]["target"]["canonical_meeting_done"])
        with self.assertRaisesRegex(ValueError, "explicit --proxy-target"):
            map_proxy_training_target([row], {"target_name": PHYSICAL_TARGET}, None)

    def test_general_erp_time_only_route_can_repeat_sellers_without_claiming_cold(self):
        with tempfile.TemporaryDirectory(prefix="general-erp-proxy-unit-fixture-") as directory:
            root, rows = Path(directory), []
            membership = {"train": [], "validation": [], "test": []}
            for name, date in (("train", "2026-01-05"), ("validation", "2026-01-30"), ("test", "2026-02-25")):
                for local in range(40):
                    row = self.row(len(rows), date + f"T{10 + local % 2:02}:00:00+05:30", int(local % 2 == 0))
                    row["seller_id"] = "repeated-seller"
                    row["prior_attempts"] = local + 1
                    row["target"][PHYSICAL_TARGET] = row["target"]["meeting_done"]
                    row["target"]["meeting_done"] = None
                    rows.append(row)
                    membership[name].append(row["attempt_id"])
            dataset, splits = root / "fixture.jsonl", root / "splits.json"
            dataset.write_text("\n".join(json.dumps(row) for row in rows) + "\n", encoding="utf-8")
            splits.write_text(json.dumps({"schema_version": 1, "dataset_sha256": digest(dataset), "timezone": "Asia/Kolkata",
                                          "label_kind": "proxy", "target_name": PHYSICAL_TARGET, "history_scope": self.scope(),
                                          "cold_start": {"train": [], "validation": [], "test": []}, "history": membership}), encoding="utf-8")
            args = argparse.Namespace(dataset=str(dataset), splits=str(splits), output=str(root / "model"), as_of="2026-10-10T00:00:00+05:30",
                                      allow_proxy=True, observed_first_contact_proxy=False, general_erp_proxy=True, proxy_target=PHYSICAL_TARGET)
            result = train_command(args)
            self.assertEqual(result["route"], "erp_outbound_observed_proxy")
            model = json.loads((root / "model" / "model.json").read_text(encoding="utf-8"))
            self.assertFalse(model["lifetime_history_verified"])
            self.assertEqual(model["feature_schema"]["categories"], {})
            self.assertEqual(model["evidence"]["training_sellers"], 1)
            final = evaluate_command(args)
            self.assertEqual(final["split"], "chronological_general_erp_final_test")
            self.assertFalse(final["canonical_objective_verified"])
            self.assertFalse(final["deployment_approved"])


if __name__ == "__main__":
    unittest.main()
