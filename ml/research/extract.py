"""Resumable, chunked, read-only, pseudonymized extraction for research dataset v4.

Source: Redash data source 13 (ERP read replica). The replica enforces a 5 s statement
timeout, so work is split into small index-driven chunks run concurrently against the
dedicated research query id (see ``redash_client``):

* ``calls``: outbound click-to-call rows for an md5 seller-hash cluster sample (8% of
  sellers), 30-minute ``entered_on`` blocks (``sql/calls_day.sql``).
* ``meetings``: DSR meetings entered per date for the same sampled sellers, with the
  forward-linked DSR call's UCID (``sql/meetings_day.sql``); re-split by company id on timeout.

All identifiers are salted md5 pseudonyms computed inside SQL; the salt stays in the ignored
``.data/btc-research-v4/pseudonym-salt`` and is redacted from the audit log. No names, phone
numbers, recordings or transcripts are selected. Every chunk is checkpointed as gzip JSON
under ``.data/btc-research-v4/raw/<kind>/``; existing chunks are skipped, so re-running resumes.

Usage: ``python -m ml.research.extract [calls|meetings|all]``
"""
from __future__ import annotations

import datetime as dt
import gzip
import hashlib
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ml.research.redash_client import ROOT, RedashError, pseudonym_salt, run

SOURCE = 13  # pg-main-prod-live (ERP read replica)
SAMPLE_MOD, SAMPLE_KEEP = 100, 8  # keep md5 seller-hash buckets 0..7 of 100 (8% of sellers)
CALL_DAYS = ("2026-08-11", "2026-09-25")  # click_to_call retention starts 2026-08-11
MEETING_DAYS = ("2026-07-12", "2026-10-09")
BLOCK_MINUTES = 30
WORKERS = int(__import__("os").environ.get("BTC_EXTRACT_WORKERS", "6"))
RAW = ROOT / ".data" / "btc-research-v4" / "raw"
SQL = Path(__file__).with_name("sql")


def days(start: str, end: str) -> list[str]:
    first, last = dt.date.fromisoformat(start), dt.date.fromisoformat(end)
    return [(first + dt.timedelta(n)).isoformat() for n in range((last - first).days + 1)]


def load_rows(path: Path) -> list[dict]:
    with gzip.open(path, "rt", encoding="utf-8") as handle:
        return json.load(handle)["rows"]


def execute(kind: str, template_name: str, target: Path, **params) -> int:
    if target.exists():
        return -1
    template = (SQL / template_name).read_text()
    sql = template.format(mod=SAMPLE_MOD, keep=SAMPLE_KEEP, salt=pseudonym_salt(), **params)
    for attempt in range(4):
        try:
            rows = run(sql, SOURCE, label=f"extract-{kind}", timeout=1800)
            break
        except RedashError as error:
            if "statement timeout" in str(error) or attempt == 3:
                raise
            time.sleep(10 * (attempt + 1))
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as handle:
        json.dump({"kind": kind, "source": SOURCE, "sample": {"mod": SAMPLE_MOD, "keep": SAMPLE_KEEP},
                   "template_sha256": hashlib.sha256(template.encode()).hexdigest(), "params": params,
                   "extracted_at": dt.datetime.now(dt.timezone.utc).isoformat(), "rows": rows}, handle, default=str)
    tmp.rename(target)
    return len(rows)


def call_block(day: str, index: int) -> str:
    start = dt.datetime.fromisoformat(day) + dt.timedelta(minutes=BLOCK_MINUTES * index)

    def block(begin: dt.datetime, minutes: float, name: str) -> int:
        end = begin + dt.timedelta(minutes=minutes)
        return execute("calls", "calls_day.sql", RAW / "calls" / day / f"{name}.json.gz",
                       start=begin.isoformat(sep=" "), end=end.isoformat(sep=" "))

    try:
        return f"calls {day} #{index}: {block(start, BLOCK_MINUTES, f'{index:02d}')}"
    except RedashError as error:  # split once more on timeout
        if "statement timeout" not in str(error):
            raise
        half = BLOCK_MINUTES / 2
        got = [block(start + dt.timedelta(minutes=half * h), half, f"{index:02d}-{h}") for h in range(2)]
        return f"calls {day} #{index} (split): {got}"


def meeting_day(day: str) -> str:
    folder = RAW / "meetings" / day
    for parts in (1, 4, 16):
        try:
            got = [execute("meetings", "meetings_day.sql", folder / f"{parts:02d}-{part:02d}.json.gz",
                           day=day, part=part, parts=parts) for part in range(parts)]
            return f"meetings {day} parts={parts}: {got}"
        except RedashError as error:
            if "statement timeout" not in str(error):
                raise
            for stale in folder.glob(f"{parts:02d}-*.json.gz"):
                stale.unlink()  # never mix partitions of different split factors
    raise RedashError(f"meetings {day}: timeout even at 16 parts")


def parallel(fn, items: list[tuple]) -> None:
    with ThreadPoolExecutor(WORKERS) as pool:
        futures = [(item, pool.submit(fn, *item)) for item in items]
        for item, future in futures:
            try:
                print(future.result(), flush=True)
            except Exception as error:  # noqa: BLE001 - logged; a rerun resumes
                print(f"FAILED {fn.__name__} {item}: {error}", flush=True)


def main() -> None:
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which in ("calls", "all"):
        parallel(call_block, [(d, i) for d in days(*CALL_DAYS) for i in range(24 * 60 // BLOCK_MINUTES)])
    if which in ("meetings", "all"):
        parallel(meeting_day, [(d,) for d in reversed(days(*MEETING_DAYS))])


if __name__ == "__main__":
    main()
