"""Unit checks for research v4 code paths (synthetic fixtures exercise code, not results)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ml.research import dataset, metrics  # noqa: E402
from ml.research.models import HourDay, NestedPooling, Platt  # noqa: E402


def ts(text: str) -> pd.Timestamp:
    return pd.Timestamp(text)


def calls_fixture() -> pd.DataFrame:
    rows = [
        # seller A: two calls; meeting linked to the second call's UCID
        ("c1", "u1", "A", "2026-09-14 10:00", "2026-09-14 10:02", "answered"),
        ("c2", "u2", "A", "2026-09-14 15:00", "2026-09-14 15:05", "answered"),
        # seller B: a call whose linked meeting is entered after 14 days
        ("c3", "u3", "B", "2026-09-14 11:00", "2026-09-14 11:01", "notanswered"),
        # seller C: a call whose linked meeting belongs to another seller
        ("c4", "u4", "C", "2026-09-14 12:00", "2026-09-14 12:01", "answered"),
        # seller A again: same start as c2 (must not count as prior history for c2)
        ("c5", "u5", "A", "2026-09-14 15:00", "2026-09-14 15:01", "notanswered"),
    ]
    df = pd.DataFrame(rows, columns=["call_key", "ucid_join", "seller_key", "start", "call_end_time", "status"])
    df["start"] = pd.to_datetime(df["start"])
    df["call_end_time"] = pd.to_datetime(df["call_end_time"])
    df["call_duration"] = [120, 300, 0, 30, 0]
    return df


def meetings_fixture() -> pd.DataFrame:
    rows = [
        ("m1", "A", "2026-09-15 09:00", 0, 1, 0, "u2", "A"),   # credited to c2
        ("m1", "A", "2026-09-15 09:00", 0, 1, 0, "u2", "A"),   # duplicate row of m1
        ("m2", "B", "2026-09-29 11:00:01", 0, 1, 0, "u3", "B"),  # outside 14 d
        ("m3", "X", "2026-09-15 09:00", 0, 1, 0, "u4", "X"),   # seller mismatch
        ("m4", "A", "2026-09-14 14:00", 1, 1, 9, "u1", "A"),   # verified video, any-mode only; before c2
    ]
    m = pd.DataFrame(rows, columns=["meeting_key", "seller_key", "entered_at", "mode", "result", "verify_status",
                                    "dsr_ucid_key", "dsr_seller_key"]).drop_duplicates("meeting_key")
    m["entered_at"] = pd.to_datetime(m["entered_at"], format="mixed")
    result_ok = m["result"].notna() & (m["result"] != 9)
    m["physical_ok"] = result_ok & (m["mode"] == 0)
    m["any_mode_ok"] = result_ok & ((m["mode"] == 0) | ((m["mode"] == 1) & (m["verify_status"] == 9)))
    return m


def test_labels() -> None:
    calls, meetings = calls_fixture(), meetings_fixture()
    stats = dataset.attach_labels(calls, meetings)
    y = dict(zip(calls["call_key"], calls["y_physical"]))
    assert y == {"c1": 0, "c2": 1, "c3": 0, "c4": 0, "c5": 0}, y
    any_mode = dict(zip(calls["call_key"], calls["y_any_mode"]))
    assert any_mode["c1"] == 1 and any_mode["c2"] == 1, any_mode
    assert stats["rejected_seller_mismatch"] == 1 and stats["rejected_outside_14d_window"] == 1, stats
    assert calls["y_answered_60s"].tolist() == [1, 1, 0, 0, 0]


def test_history_is_strictly_prior() -> None:
    calls, meetings = calls_fixture(), meetings_fixture()
    dataset.attach_history(calls, meetings)
    row = calls.set_index("call_key")
    assert row.at["c1", "calls_7d"] == 0 and row.at["c1", "any_meetings_30d"] == 0
    # c2 and c5 start at the same instant: neither is history for the other
    assert row.at["c2", "calls_7d"] == 1 and row.at["c5", "calls_7d"] == 1
    assert row.at["c2", "answered_7d"] == 1 and row.at["c2", "last_call_answered"] == 1
    # m4 (entered 14:00) precedes c2 (15:00); m1 (next day) must not leak into any call
    assert row.at["c2", "any_meetings_30d"] == 1 and row.at["c2", "phys_meetings_30d"] == 0
    assert row.at["c1", "phys_meetings_30d"] == 0
    assert abs(row.at["c2", "hours_since_last_call"] - 5.0) < 1e-9


def test_metrics_and_bootstrap() -> None:
    rng = np.random.default_rng(1)
    s = np.round(rng.random(5000), 2)
    y = (rng.random(5000) < 0.02 + 0.05 * s).astype(int)
    r = metrics.Ranked(s, y)
    from sklearn.metrics import average_precision_score, roc_auc_score
    assert abs(r.average_precision() - average_precision_score(y, s)) < 1e-12
    assert abs(r.roc_auc() - roc_auc_score(y, s)) < 1e-12
    sellers = rng.integers(0, 500, 5000).astype(str)
    out = metrics.paired_bootstrap({"a": s, "b": np.full(5000, 0.5)}, y, sellers, [("a", "b")], reps=50)
    lo, hi = out["a-vs-b"]["intervals_95"]["ap"]
    assert lo <= out["a-vs-b"]["ap_difference"] <= hi
    zero = metrics.summary(np.full(10, 0.1), np.zeros(10, int))
    assert zero["average_precision"] is None and zero["roc_auc"] is None


def test_unseen_cells_back_off() -> None:
    df = pd.DataFrame({"weekday": [0] * 50 + [1] * 2, "hour": [10] * 50 + [11] * 2, "module_group": ["x"] * 52})
    y = np.r_[np.ones(5), np.zeros(47)].astype(int)
    hd = HourDay(20).fit(df, y)
    unseen = pd.DataFrame({"weekday": [6], "hour": [3], "module_group": ["zzz"]})
    assert abs(hd.predict(unseen)[0] - hd.rate) < 1e-12
    nested = NestedPooling().fit(df, y)
    assert 0 < nested.predict(unseen)[0] < 1
    cal = Platt().fit(np.clip(np.linspace(0.01, 0.2, 52), 0, 1), y)
    assert cal.slope >= 0


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
