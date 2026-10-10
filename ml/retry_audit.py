"""Descriptive sampled retry gaps; never claim an actual retry ordinal or causal lift."""
import argparse
from collections import defaultdict, Counter
import json
from pathlib import Path
from .cold_start.contract import instant, load_rows


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dataset", default=".data/best-time-to-call/attempts.jsonl")
    p.add_argument("--output", default=".data/best-time-to-call/retry-audit.json")
    args = p.parse_args()
    groups = defaultdict(list)
    for row in load_rows(args.dataset):
        groups[(row["seller_id"], row["lead_id"])].append(row)
    buckets = Counter()
    for group in groups.values():
        group.sort(key=lambda r: instant(r["call_at"]))
        for before, after in zip(group, group[1:]):
            if before["target"].get("connected") != 0:
                continue
            gap = (instant(after["call_at"]) - instant(before["call_at"])).total_seconds() / 60
            bucket = "0_15" if gap <= 15 else "15_30" if gap <= 30 else "30_60" if gap <= 60 else "60_120" if gap <= 120 else "same_day_over120" if gap < 1440 else "later_day"
            buckets[bucket] += 1
    result = {"observed_consecutive_sampled_pairs_after_unanswered": dict(buckets), "true_retry_sequences_verified": False, "completed_meeting_policy_comparison": None,
              "rule_recommendation": "keep current rule pending randomized pilot; supplement only with verified eligibility/stop constraints",
              "candidate_delays_minutes": [15, 30, 60, 120, 1440], "reason": "Full retry chains, canonical labels, production rule configuration, and propensity/overlap evidence are unavailable.",
              "causal_lift_measured": False, "configured_app_cooldown_is_assumption": True}
    Path(args.output).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
