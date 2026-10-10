"""Create a new immutable split manifest; never replace a used manifest."""
import argparse
import hashlib
import json
from pathlib import Path
from .prepare import build_splits
from .cold_start.contract import load_rows


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dataset", default=".data/best-time-to-call/attempts.jsonl")
    p.add_argument("--output", default=".data/best-time-to-call/splits-v2.json")
    args = p.parse_args()
    contract = build_splits(load_rows(args.dataset), hashlib.sha256(Path(args.dataset).read_bytes()).hexdigest())
    contract["manifest_revision"] = 2
    contract["revision_reason"] = "Pre-training embargo correction: Aug12 calls were not mature before Sep2 morning. No model fit/final scoring occurred under v1. Original manifest retained unchanged."
    with Path(args.output).open("x", encoding="utf-8") as handle:
        json.dump(contract, handle, indent=2, sort_keys=True)
    print(json.dumps({"output": args.output, "dataset_sha256": contract["dataset_sha256"], "split_counts": {track: {key: len(value) for key, value in contract[track].items()} for track in ("history", "cold_start")}}, indent=2))


if __name__ == "__main__":
    main()
