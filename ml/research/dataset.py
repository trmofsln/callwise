"""Build research dataset v4 from pseudonymized raw extracts.

One example = one eligible outbound click-to-call at its actual start. History features use
only events that both happened and were recorded before the decision timestamp. Labels use
meetings entered within 14 days after the call. Outputs (ignored, under .data/btc-research-v4/):

* ``dataset/examples.parquet``: train + dev examples (features, labels, cohort, split).
* ``dataset/test-sealed.parquet``: final-test examples; read only by ``evaluate.py`` after freezing.
* ``dataset/manifest.json``: provenance, exclusions, hashes, aggregate coverage (no identifiers).

Usage: ``python -m ml.research.dataset``
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd

from ml.research.redash_client import ROOT, pseudonym_salt

BASE = ROOT / ".data" / "btc-research-v4"
RAW, OUT = BASE / "raw", BASE / "dataset"
TZ = "Asia/Kolkata"
SPLITS = {  # inclusive local call-start dates
    "warmup": ("2026-08-11", "2026-08-17"),
    "train": ("2026-08-18", "2026-08-24"),
    "dev": ("2026-08-25", "2026-08-31"),
    "embargo": ("2026-09-01", "2026-09-13"),
    "test": ("2026-09-14", "2026-09-25"),
}
HORIZON = pd.Timedelta(days=14)
MEETING_LOOKBACK = pd.Timedelta(days=30)
PRIOR_TEST_DATES = ("2026-09-21", "2026-09-23", "2026-09-25")
TOP_MODULES = 12
POLICY_HOURS = range(10, 18)  # app default business hours 10:00-18:00 -> 1 h windows starting 10..17
FEATURES_CLOCK = ["hour", "weekday"]
FEATURES_CONTEXT = ["module_group", "custtype_id", "vertical_id", "is_sts_assigned", "flag_call_type", "vendor"]
FEATURES_HISTORY = [
    "calls_24h", "calls_7d", "answered_7d", "answered_rate_7d", "answered_same_hour_7d", "calls_same_hour_7d",
    "calls_today", "hours_since_last_call", "last_call_answered", "has_call_7d",
    "phys_meetings_30d", "any_meetings_30d", "days_since_meeting", "has_meeting_30d",
]


def _rows(kind: str) -> list[dict]:
    rows: list[dict] = []
    for path in sorted((RAW / kind).rglob("*.json.gz")):
        with gzip.open(path, "rt", encoding="utf-8") as handle:
            rows.extend(json.load(handle)["rows"])
    return rows


def _ts(series: pd.Series) -> pd.Series:
    """Naive ERP timestamps are interpreted as Asia/Kolkata wall time (existing contract)."""
    return pd.to_datetime(series, errors="coerce", format="mixed")


def load_calls() -> tuple[pd.DataFrame, dict]:
    df = pd.DataFrame(_rows("calls"))
    stats = {"raw_rows": int(len(df))}
    df = df.drop_duplicates("call_key")
    stats["after_call_key_dedup"] = int(len(df))
    for column in ("call_start_time", "call_end_time", "entered_on", "last_modified_date"):
        df[column] = _ts(df[column])
    df["start"] = df["call_start_time"]
    df["date"] = df["start"].dt.strftime("%Y-%m-%d")
    entered_date = df["entered_on"].dt.strftime("%Y-%m-%d")
    eligible = (
        df["employee_key"].notna() & df["status"].isin(["answered", "notanswered"]) & df["start"].notna()
        & (df["date"] == entered_date)
    )
    stats["ineligible_rows"] = {
        "employee_missing": int(df["employee_key"].isna().sum()),
        "status_other": int((~df["status"].isin(["answered", "notanswered"])).sum()),
        "start_missing": int(df["start"].isna().sum()),
        "start_not_on_entry_date": int((df["start"].notna() & (df["date"] != entered_date)).sum()),
    }
    df["eligible"] = eligible
    ucid_ok = df["ucid_key"].notna() & ~df["ucid_placeholder"].fillna(False).astype(bool)
    dup = df[ucid_ok].duplicated("ucid_key", keep=False)
    stats["duplicate_ucid_rows"] = int(dup.sum())
    df["ucid_join"] = df["ucid_key"].where(ucid_ok)
    df.loc[df[ucid_ok][dup].index, "ucid_join"] = None  # ambiguous UCIDs never receive credit
    lag = (df["last_modified_date"] - df["entered_on"]).dt.total_seconds() / 3600
    stats["last_modified_minus_entered_hours_quantiles"] = {
        str(q): (None if np.isnan(v) else round(float(v), 2)) for q, v in zip((0.5, 0.9, 0.99), lag.quantile([0.5, 0.9, 0.99]))
    }
    return df, stats


def load_meetings() -> tuple[pd.DataFrame, dict]:
    m = pd.DataFrame(_rows("meetings"))
    stats = {"raw_rows": int(len(m))}
    m = m.drop_duplicates("meeting_key")
    stats["after_meeting_key_dedup"] = int(len(m))
    for column in ("entered_at", "meeting_date", "verify_date", "dsr_entered_at", "dsr_app_date"):
        m[column] = _ts(m[column])
    result_ok = m["result"].notna() & (m["result"] != 9)
    m["physical_ok"] = result_ok & (m["mode"] == 0)
    m["any_mode_ok"] = result_ok & ((m["mode"] == 0) | ((m["mode"] == 1) & (m["verify_status"] == 9)))
    stats["physical_ok"] = int(m["physical_ok"].sum())
    stats["any_mode_ok"] = int(m["any_mode_ok"].sum())
    stats["with_dsr_ucid"] = int(m["dsr_ucid_key"].notna().sum())
    return m, stats


def attach_labels(calls: pd.DataFrame, meetings: pd.DataFrame) -> dict:
    """Credit each meeting once to the call sharing its forward DSR call's UCID."""
    stats = {}
    link = meetings[meetings["dsr_ucid_key"].notna()].merge(
        calls.loc[calls["ucid_join"].notna(), ["call_key", "ucid_join", "seller_key", "start"]],
        left_on="dsr_ucid_key", right_on="ucid_join", how="inner", suffixes=("_m", "_c"))
    stats["meeting_call_ucid_matches"] = int(len(link))
    seller_ok = (link["seller_key_m"] == link["seller_key_c"]) & (link["dsr_seller_key"] == link["seller_key_c"])
    stats["rejected_seller_mismatch"] = int((~seller_ok).sum())
    window_ok = (link["entered_at"] > link["start"]) & (link["entered_at"] <= link["start"] + HORIZON)
    stats["rejected_outside_14d_window"] = int((seller_ok & ~window_ok).sum())
    link = link[seller_ok & window_ok]
    # One credit per meeting (latest eligible call before entry); UCIDs are unique, so this is a guard.
    link = link.sort_values("start").drop_duplicates("meeting_key", keep="last")
    for target, flag in (("y_physical", "physical_ok"), ("y_any_mode", "any_mode_ok")):
        positive = set(link.loc[link[flag], "call_key"])
        calls[target] = calls["call_key"].isin(positive).astype(np.int8)
    calls["y_answered"] = (calls["status"] == "answered").astype(np.int8)
    calls["y_answered_60s"] = ((calls["status"] == "answered") & (pd.to_numeric(calls["call_duration"], errors="coerce") >= 60)).astype(np.int8)
    stats["credited_meetings_physical"] = int(link["physical_ok"].sum())
    stats["credited_meetings_any_mode"] = int(link["any_mode_ok"].sum())
    return stats


def attach_history(calls: pd.DataFrame, meetings: pd.DataFrame) -> None:
    calls.sort_values(["seller_key", "start", "call_key"], inplace=True, kind="mergesort")
    calls.reset_index(drop=True, inplace=True)
    n = len(calls)
    out = {name: np.zeros(n) for name in FEATURES_HISTORY}
    out["hours_since_last_call"][:] = np.nan
    out["days_since_meeting"][:] = np.nan
    out["last_call_answered"][:] = np.nan
    out["prior_calls_observed"] = np.zeros(n)
    for ph_ in POLICY_HOURS:  # per-hour seller history, for counterfactual hour scoring in policy analysis
        out[f"calls_h{ph_}_7d"] = np.zeros(n)
        out[f"answered_h{ph_}_7d"] = np.zeros(n)
    start_ns = calls["start"].values.astype("datetime64[ns]").astype(np.int64)
    end = calls["call_end_time"].fillna(calls["start"])
    end_ns = np.maximum(end.values.astype("datetime64[ns]").astype(np.int64), start_ns)
    answered = (calls["status"] == "answered").values
    hour = calls["start"].dt.hour.values
    day = calls["start"].dt.normalize().values.astype("datetime64[ns]").astype(np.int64)
    hour_ns, day_ns = 3_600 * 10**9, 86_400 * 10**9
    meet = meetings.dropna(subset=["entered_at"]).sort_values("entered_at")
    meet_groups = {k: (g["entered_at"].values.astype("datetime64[ns]").astype(np.int64), g["physical_ok"].values, g["any_mode_ok"].values)
                   for k, g in meet.groupby("seller_key")}
    bounds = np.flatnonzero(np.r_[True, calls["seller_key"].values[1:] != calls["seller_key"].values[:-1], True])
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        s, e, a, h, d = start_ns[lo:hi], end_ns[lo:hi], answered[lo:hi], hour[lo:hi], day[lo:hi]
        mt = meet_groups.get(calls.at[lo, "seller_key"])
        for j in range(hi - lo):
            t = s[j]
            # A prior call counts once it started before t; its outcome only once it ended before t.
            started = s[:j][s[:j] < t]
            prior = np.flatnonzero(s[:j] < t)
            i = lo + j
            out["prior_calls_observed"][i] = len(prior)
            if len(prior):
                ps, pe, pa, ph, pd_ = s[prior], e[prior], a[prior], h[prior], d[prior]
                known = pe <= t
                w7 = ps >= t - 7 * day_ns
                out["calls_24h"][i] = np.sum(ps >= t - day_ns)
                out["calls_7d"][i] = np.sum(w7)
                out["has_call_7d"][i] = float(np.any(w7))
                out["answered_7d"][i] = np.sum(w7 & known & pa)
                k7 = np.sum(w7 & known)
                out["answered_rate_7d"][i] = (out["answered_7d"][i] + 0.5) / (k7 + 1.0)
                out["calls_same_hour_7d"][i] = np.sum(w7 & (ph == h[j]))
                out["answered_same_hour_7d"][i] = np.sum(w7 & known & pa & (ph == h[j]))
                out["calls_today"][i] = np.sum(pd_ == d[j])
                for ph_ in POLICY_HOURS:
                    at = w7 & (ph == ph_)
                    out[f"calls_h{ph_}_7d"][i] = np.sum(at)
                    out[f"answered_h{ph_}_7d"][i] = np.sum(at & known & pa)
                out["hours_since_last_call"][i] = (t - started.max()) / hour_ns
                last_known = np.flatnonzero(known)
                if len(last_known):
                    out["last_call_answered"][i] = float(pa[last_known[np.argmax(ps[last_known])]])
            else:
                out["answered_rate_7d"][i] = 0.5
            if mt is not None:
                mts, mphys, many = mt
                upto = np.searchsorted(mts, t, side="left")  # entered strictly before t
                if upto:
                    recent = mts[:upto] >= t - 30 * day_ns
                    out["phys_meetings_30d"][i] = np.sum(recent & mphys[:upto])
                    out["any_meetings_30d"][i] = np.sum(recent & many[:upto])
                    out["has_meeting_30d"][i] = float(np.any(recent & many[:upto]))
                    out["days_since_meeting"][i] = (t - mts[upto - 1]) / day_ns
    for name, values in out.items():
        calls[name] = values


def cohort(prior: pd.Series) -> pd.Series:
    return pd.cut(prior, [-1, 0, 9, np.inf], labels=["no_observed_history", "sparse_observed_history", "substantial_observed_history"]).astype(str)


def split_of(date: pd.Series) -> pd.Series:
    out = pd.Series("outside", index=date.index)
    for name, (lo, hi) in SPLITS.items():
        out[(date >= lo) & (date <= hi)] = name
    return out


def prior_test_keys() -> set[str]:
    salt = pseudonym_salt()
    keys = set()
    for date in PRIOR_TEST_DATES:
        for path in (ROOT / ".data" / "btc-operational-v3" / "raw").glob(f"{date}-*.json"):
            for row in json.loads(path.read_text())["rows"]:
                keys.add(hashlib.md5(f"{salt}c{int(row['attempt_id'])}".encode()).hexdigest())
    return keys


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    calls, call_stats = load_calls()
    meetings, meeting_stats = load_meetings()
    label_stats = attach_labels(calls, meetings)
    attach_history(calls, meetings)
    calls["hour"] = calls["start"].dt.hour
    calls["weekday"] = calls["start"].dt.weekday  # Monday = 0, matching the app
    top = calls.loc[calls["eligible"], "module"].value_counts().index[:TOP_MODULES]
    calls["module_group"] = calls["module"].where(calls["module"].isin(top), "other").fillna("missing")
    calls["cohort"] = cohort(calls["prior_calls_observed"])
    calls["split"] = split_of(calls["date"])
    excluded = prior_test_keys()
    calls["prior_published_test"] = calls["call_key"].isin(excluded)
    examples = calls[calls["eligible"] & calls["split"].isin(["train", "dev", "test"])].copy()
    exclusions = {"prior_published_test_calls_removed_from_test": int((examples["prior_published_test"] & (examples["split"] == "test")).sum())}
    examples = examples[~((examples["split"] == "test") & examples["prior_published_test"])]
    keep = ["call_key", "seller_key", "employee_key", "start", "date", "split", "cohort", "prior_calls_observed",
            "status", "module", *FEATURES_CLOCK, *FEATURES_CONTEXT, *FEATURES_HISTORY,
            *[f"{k}_h{h}_7d" for h in POLICY_HOURS for k in ("calls", "answered")],
            "y_physical", "y_any_mode", "y_answered", "y_answered_60s"]
    examples = examples[keep].sort_values(["start", "call_key"]).reset_index(drop=True)
    for column in ("custtype_id", "vertical_id", "is_sts_assigned"):
        examples[column] = pd.to_numeric(examples[column], errors="coerce")
    for column in ("flag_call_type", "vendor", "module"):
        examples[column] = examples[column].astype(str)
    dev = examples[examples["split"] != "test"]
    test = examples[examples["split"] == "test"]
    dev.to_parquet(OUT / "examples.parquet", index=False)
    test.to_parquet(OUT / "test-sealed.parquet", index=False)
    split_summary = {name: {"rows": int(len(g)), "sellers": int(g["seller_key"].nunique()), "dates": sorted(g["date"].unique().tolist())}
                     for name, g in examples.groupby("split")}
    # Outcome counts for the sealed test are deliberately not computed here.
    for name in ("train", "dev"):
        g = examples[examples["split"] == name]
        split_summary[name]["positives"] = {t: int(g[t].sum()) for t in ("y_physical", "y_any_mode", "y_answered", "y_answered_60s")}
        split_summary[name]["cohorts"] = {c: {"rows": int(len(x)), "y_physical": int(x["y_physical"].sum())} for c, x in g.groupby("cohort")}
    split_summary["test"]["cohort_rows"] = {c: int(len(x)) for c, x in test.groupby("cohort")}
    manifest = {
        "dataset_version": "btc-research-v4",
        "built_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "decision_unit": "eligible outbound click_to_call at call_start_time (Asia/Kolkata wall time)",
        "sample": "md5(seller_id) first 28 bits mod 100 < 8 (seller cluster sample)",
        "splits": SPLITS, "label_horizon_days": 14, "meeting_lookback_days": 30,
        "targets": {"y_physical": "observed_linked_physical_recorded_met_within14days",
                    "y_any_mode": "observed_linked_any_mode_met_within14days",
                    "y_answered": "status == answered (current-call outcome; label only)",
                    "y_answered_60s": "answered and call_duration >= 60 s (named proxy)"},
        "features": {"clock": FEATURES_CLOCK, "context": FEATURES_CONTEXT, "history": FEATURES_HISTORY},
        "module_groups": [str(x) for x in top],
        "call_stats": call_stats, "meeting_stats": meeting_stats, "label_stats": label_stats,
        "exclusions": exclusions, "splits_summary": split_summary,
        "files": {p.name: sha256_file(p) for p in (OUT / "examples.parquet", OUT / "test-sealed.parquet")},
        "split_membership_sha256": hashlib.sha256("\n".join(examples["call_key"] + ":" + examples["split"]).encode()).hexdigest(),
        "raw_files": {kind: len(list((RAW / kind).rglob("*.json.gz"))) for kind in ("calls", "meetings")},
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    print(json.dumps({k: manifest[k] for k in ("call_stats", "meeting_stats", "label_stats", "exclusions")}, indent=1, default=str))
    print(json.dumps(split_summary, indent=1, default=str)[:3000])


if __name__ == "__main__":
    main()
