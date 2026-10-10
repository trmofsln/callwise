"""Retry-interval study: after an unanswered outbound call, how does the wait before the next
attempt relate to the chance it is answered and to a successful meeting within 14 days?

Reads the pseudonymized research-v4 extract (.data/btc-research-v4/raw), computes descriptive
aggregates only (counts, rates, Wilson intervals) and writes ml/retry/retry-policy.json, which the
app's retry ladder reads. Observational: reps choose when to retry, so these are associations, not
causal effects. No seller, employee or call identifiers leave this script.

Usage: .venv/bin/python -m ml.research.retry_policy
"""
import argparse
import glob
import gzip
import json
import math
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

RAW = Path(".data/btc-research-v4/raw")
OUT = Path("ml/retry/retry-policy.json")

# Minute buckets named by the retry interval they represent; later days are calendar-day buckets.
MINUTE_EDGES = [(0, 8, "5m"), (8, 22, "15m"), (22, 37, "30m"), (37, 52, "45m"), (52, 75, "60m"), (75, 105, "90m"),
                (105, 150, "120m"), (150, 210, "180m"), (210, 300, "240m"), (300, 24 * 60, "later_same_day")]
DAY_BUCKETS = [(1, 1, "next_day"), (2, 3, "2_3_days"), (4, 7, "4_7_days")]
BUCKETS = [b for _, _, b in MINUTE_EDGES] + [b for _, _, b in DAY_BUCKETS]
SEQUENCE_BREAK_DAYS = 7
MEETING_DAYS = 14


def wilson(k: int, n: int, z: float = 1.96):
    if n == 0:
        return None, None
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(c - h, 4), round(c + h, 4)


def stat(answered: pd.Series):
    n, k = int(answered.size), int(answered.sum())
    lo, hi = wilson(k, n)
    return {"n": n, "answered": k, "rate": round(k / n, 4) if n else None, "ci95": [lo, hi]}


def load(kind: str) -> pd.DataFrame:
    rows = []
    for f in sorted(glob.glob(str(RAW / kind / "*" / "*.json.gz"))):
        data = json.load(gzip.open(f))
        rows.extend(data.get("rows", data) if isinstance(data, dict) else data)
    return pd.DataFrame(rows)


def gap_bucket(gap_min: np.ndarray, day_diff: np.ndarray) -> np.ndarray:
    out = np.full(gap_min.shape, None, dtype=object)
    same = day_diff == 0
    for lo, hi, name in MINUTE_EDGES:
        out[same & (gap_min >= lo) & (gap_min < hi)] = name
    for lo, hi, name in DAY_BUCKETS:
        out[(day_diff >= lo) & (day_diff <= hi)] = name
    return out


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--output", default=str(OUT))
    args = p.parse_args()

    calls = load("calls")
    calls = calls[calls["status"].notna() & calls["call_start_time"].notna()].drop_duplicates("call_key")
    calls["t"] = pd.to_datetime(calls["call_start_time"], errors="coerce")
    calls = calls[calls["t"].notna()].sort_values(["seller_key", "t"]).reset_index(drop=True)
    calls["answered"] = calls["status"].eq("answered")
    calls["talk"] = calls["answered"] & (calls["call_duration"].fillna(0) >= 30)

    g = calls.groupby("seller_key", sort=False)
    prev_t, prev_ans = g["t"].shift(), g["answered"].shift()
    gap = (calls["t"] - prev_t).dt.total_seconds() / 60
    day_diff = (calls["t"].dt.normalize() - prev_t.dt.normalize()).dt.days
    # A retry sequence runs from a call after an answer (or a long silence) through the unanswered attempts that follow.
    reset = prev_t.isna() | prev_ans.fillna(True).astype(bool) | (gap > SEQUENCE_BREAK_DAYS * 1440)
    calls["block"] = reset.cumsum()
    calls["k"] = calls.groupby("block").cumcount()  # unanswered attempts immediately before this call
    calls["gap_min"] = gap
    calls["bucket"] = gap_bucket(gap.fillna(-1).to_numpy(), day_diff.fillna(-1).to_numpy())
    calls["hour"] = calls["t"].dt.hour
    # Seller propensity from earlier calls only (no look-ahead).
    calls["prior_n"] = g.cumcount()
    calls["prior_ans"] = g["answered"].cumsum() - calls["answered"].astype(int)
    rate = calls["prior_ans"] / calls["prior_n"].replace(0, np.nan)
    calls["tier"] = np.where(calls["prior_n"] < 5, "unknown", np.where(rate < 0.25, "low", np.where(rate < 0.5, "mid", "high")))

    # Successful meetings (ERP rule): result != 9 and (physical, or video verified with status 9).
    meetings = load("meetings")
    for c in ("mode", "result", "verify_status"):
        meetings[c] = pd.to_numeric(meetings[c], errors="coerce")
    ok = meetings["result"].notna() & meetings["result"].ne(9) & (meetings["mode"].eq(0) | (meetings["mode"].eq(1) & meetings["verify_status"].eq(9)))
    meetings = meetings[ok].assign(mt=pd.to_datetime(meetings["meeting_date"], errors="coerce")).dropna(subset=["mt"])
    by_seller = {s: np.sort(v.to_numpy(dtype="datetime64[ns]")) for s, v in meetings.groupby("seller_key")["mt"]}

    def meeting_after(seller: str, at) -> bool:
        times = by_seller.get(seller)
        if times is None:
            return False
        a = np.datetime64(at)
        i = np.searchsorted(times, a)
        return i < len(times) and times[i] <= a + np.timedelta64(MEETING_DAYS, "D")

    retries = calls[(calls["k"] >= 1) & calls["bucket"].notna()].copy()
    retries["k_group"] = np.where(retries["k"] >= 4, "4+", retries["k"].astype(str))
    first = calls[calls["k"] == 0]

    curve = {kg: {b: stat(part[part["bucket"] == b]["answered"]) for b in BUCKETS} for kg, part in retries.groupby("k_group")}
    pooled = {b: stat(retries[retries["bucket"] == b]["answered"]) for b in BUCKETS}
    tiers = {t: {"overall": stat(part["answered"]), "by_bucket": {b: stat(part[part["bucket"] == b]["answered"]) for b in BUCKETS}} for t, part in retries.groupby("tier")}
    retry_rate = retries["answered"].mean()
    hours = {int(h): {**stat(part["answered"]), "factor": round(part["answered"].mean() / retry_rate, 3)} for h, part in retries.groupby("hour") if len(part) >= 200}

    # Meeting value of a contact by how long the rep waited: answered retries followed by a successful meeting within 14 days.
    contacts = retries[retries["answered"]].copy()
    contacts["meeting"] = [meeting_after(s, t) for s, t in zip(contacts["seller_key"], contacts["t"])]
    meeting_by_bucket = {b: {**stat(contacts[contacts["bucket"] == b]["meeting"]), "talk_30s_rate": round(float(contacts[contacts["bucket"] == b]["talk"].mean()), 4) if (contacts["bucket"] == b).any() else None} for b in BUCKETS}
    first_contacts = first[first["answered"]]
    first_meeting = stat(pd.Series([meeting_after(s, t) for s, t in zip(first_contacts["seller_key"].head(60000), first_contacts["t"].head(60000))]))

    # Sequence strategies: sequences that start with a miss, grouped by how long the rep waited before the first retry.
    blocks = calls.groupby("block").agg(seller=("seller_key", "first"), start=("t", "first"), n=("k", "size"),
                                         first_answered=("answered", "first"), reached=("answered", "any"))
    blocks["reached_k"] = calls[calls["answered"]].groupby("block")["k"].min().reindex(blocks.index).fillna(-1).astype(int)
    blocks = blocks[~blocks["first_answered"] & (blocks["n"] >= 2)]
    second = calls[calls["k"] == 1].set_index("block")
    blocks = blocks.join(second[["bucket", "gap_min"]], how="inner")
    style = np.select([blocks["gap_min"] <= 60, blocks["bucket"].isin(["90m", "120m", "180m", "240m"]), blocks["bucket"].eq("later_same_day")], ["interval_within_1h", "interval_1_4h", "later_same_day"], "next_day_or_later")
    blocks["style"] = style
    blocks["meeting"] = [meeting_after(s, t) for s, t in zip(blocks["seller"], blocks["start"])]
    strategies = {}
    for s, part in blocks.groupby("style"):
        reached = part[part["reached"]]
        strategies[s] = {"sequences": int(len(part)), "reached": stat(part["reached"]), "reached_within_4_retries": stat(part["reached"] & (part["reached_k"] <= 4)),
                         "mean_attempts_to_reach": round(float((reached["reached_k"] + 1).mean()), 2) if len(reached) else None,
                         "meeting_within_14d": stat(part["meeting"])}

    result = {
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "research-v4 pseudonymized outbound click_to_call sample (seller-hash cluster) and DSR meetings",
        "window": {"from": str(calls["t"].min().date()), "to": str(calls["t"].max().date())},
        "volumes": {"calls": int(len(calls)), "sellers": int(calls["seller_key"].nunique()), "retries": int(len(retries)), "first_attempts": int(len(first)), "successful_meetings": int(len(meetings))},
        "definitions": {"retry": f"an outbound call to a seller whose previous call was unanswered, within {SEQUENCE_BREAK_DAYS} days", "k": "unanswered attempts in a row before this call",
                        "answered": "click_to_call status answered", "meeting": f"successful ERP meeting (physical, or verified video) for the seller within {MEETING_DAYS} days",
                        "tier": "seller answer rate on earlier calls in the window: low < 25%, mid 25-50%, high >= 50%; unknown under 5 earlier calls", "buckets": BUCKETS},
        "baseline": {"all_calls": stat(calls["answered"]), "first_attempts": stat(first["answered"]), "retries": stat(retries["answered"]),
                     "meeting_after_first_attempt_contact": first_meeting},
        "curve_by_attempt": curve, "curve_pooled": pooled, "seller_tiers": tiers, "retry_hour": hours,
        "meeting_after_contact_by_bucket": meeting_by_bucket, "first_retry_strategies": strategies,
        "caveats": ["Observational: reps choose when to retry, so intervals reflect their judgement as well as seller behaviour.",
                    "The research sample covers 46 days; seller tiers use only calls inside it.",
                    "Callback-at-a-told-time is not recorded in click_to_call, so it is not measured here."],
    }
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, indent=1), encoding="utf-8")
    print(json.dumps({k: result[k] for k in ("window", "volumes", "baseline")}, indent=1))
    print("pooled:", {b: (v["rate"], v["n"]) for b, v in pooled.items()})
    for kg, c in curve.items():
        print("k", kg, {b: (v["rate"], v["n"]) for b, v in c.items() if v["n"]})
    print("tiers:", {t: v["overall"]["rate"] for t, v in tiers.items()})
    print("hours:", {h: v["factor"] for h, v in hours.items()})
    print("meeting|contact:", {b: (v["rate"], v["n"]) for b, v in meeting_by_bucket.items()})
    print("strategies:", json.dumps(strategies, indent=1))


if __name__ == "__main__":
    main()
