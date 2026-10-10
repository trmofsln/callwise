"""Read-only Redash client for the calling-time research branch.

Runs statements through one dedicated saved query created for this research
(name ``hackathon-btc-research-2026-10-10``). Its id is kept in the ignored
``.data/btc-research-v4/redash-query.json`` (override: ``REDDASH_RESEARCH_QUERY_ID``)
and is distinct from the interactive adhoc/user/training query ids, which are
never read or overwritten here. Credentials
come from ``.env``/environment and are never printed. Every call is appended to
an ignored audit log with SQL hash, source id, row count and timings.
"""
from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
AUDIT_LOG = ROOT / ".data" / "btc-research-v4" / "query-audit.jsonl"
QUERY_FILE = ROOT / ".data" / "btc-research-v4" / "redash-query.json"
QUERY_NAME = "hackathon-btc-research-2026-10-10"
_PROTECTED_ENV = ("REDDASH_ADHOC_QUERY_ID", "REDDASH_USER_QUERY_ID", "REDDASH_TRAINING_QUERY_ID")
_FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|call)\b", re.I)


def _env() -> dict[str, str]:
    values: dict[str, str] = {}
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip()
    values.update({k: v for k, v in os.environ.items() if k.startswith(("REDASH", "REDDASH"))})
    return values


class RedashError(RuntimeError):
    pass


def _research_query_id(env: dict[str, str], request, sql: str, source: int) -> int:
    configured = env.get("REDDASH_RESEARCH_QUERY_ID", "").strip()
    if not configured and QUERY_FILE.exists():
        configured = str(json.loads(QUERY_FILE.read_text())["query_id"])
    if configured:
        query_id = int(configured)
    else:
        created = request("queries", {"query": sql, "data_source_id": source, "name": QUERY_NAME})
        query_id = int(created["id"])
        QUERY_FILE.parent.mkdir(parents=True, exist_ok=True)
        QUERY_FILE.write_text(json.dumps({"query_id": query_id, "name": QUERY_NAME,
                                          "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}))
    protected = {env.get(name, "").strip() for name in _PROTECTED_ENV} - {""}
    if str(query_id) in protected:
        raise RedashError("Research query id collides with an interactive query id; refusing.")
    return query_id


def _strip_literals(sql: str) -> str:
    return re.sub(r"'(?:[^']|'')*'", "''", re.sub(r"--[^\n]*", "", sql))


def pseudonym_salt() -> str:
    """Local secret used inside SQL to pseudonymize identifiers; never logged."""
    path = AUDIT_LOG.parent / "pseudonym-salt"
    if not path.exists():
        import secrets
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_hex(16))
        path.chmod(0o600)
    return path.read_text().strip()


def run(sql: str, source: int, *, label: str = "adhoc", timeout: float = 900.0, max_age: int = 0) -> list[dict]:
    """Execute a read-only statement and return rows."""
    body_sql = _strip_literals(sql)
    if _FORBIDDEN.search(body_sql):
        raise RedashError("Refusing non-read-only statement.")
    env = _env()
    key = env.get("REDDASH_API_KEY") or env.get("REDASH_API_KEY")
    if not key:
        raise RedashError("REDDASH_API_KEY is not configured.")
    base = (env.get("REDASH_URL") or "").rstrip("/")
    if not base.startswith(("https://", "http://")):
        raise RedashError("REDASH_URL is not configured.")

    def request(endpoint: str, payload: dict | None = None) -> dict:
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(
            f"{base}/api/{endpoint}", data=data, method="POST" if data else "GET",
            headers={"Authorization": f"Key {key}", "Content-Type": "application/json"},
        )
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as response:
                    return json.loads(response.read())
            except urllib.error.HTTPError as error:
                detail = error.read()[:400].decode(errors="replace")
                if error.code in (502, 503, 504) and attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise RedashError(f"HTTP {error.code} on {endpoint.split('/')[0]}: {detail}") from None
            except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead, ConnectionError) as error:
                if attempt < 3:
                    time.sleep(5 * (attempt + 1))
                    continue
                raise RedashError(f"Connection failed: {error}") from None
        raise RedashError("unreachable")

    started = time.time()
    digest = hashlib.sha256(sql.encode()).hexdigest()
    status, rows, error_text = "ok", [], None
    try:
        query_id = _research_query_id(env, request, sql, source)
        timeout_setting = (env.get("REDASH_STATEMENT_TIMEOUT") or "120s").strip()
        pg_sources = {int(x) for x in (env.get("REDASH_POSTGRES_SOURCE_IDS") or "13,21").split(",") if x.strip().isdigit()}
        if source in pg_sources and re.fullmatch(r"\d+(ms|s|min)", timeout_setting):
            sql = f"SET statement_timeout = '{timeout_setting}';\n{sql}"  # replica default is 5 s
        # Execute the statement text against the dedicated research query id without
        # rewriting its saved definition, so concurrent bounded chunks do not race.
        result = request("query_results", {"query": sql, "data_source_id": source,
                                           "max_age": max_age, "query_id": query_id})
        if "query_result" not in result:
            job = result.get("job") or {}
            while True:
                if time.time() - started > timeout:
                    raise RedashError("Redash job timed out.")
                time.sleep(2)
                job = request(f"jobs/{job['id']}")["job"]
                if job["status"] == 3:
                    result = request(f"query_results/{job['query_result_id']}")
                    break
                if job["status"] in (4, 5):
                    raise RedashError(f"Redash job failed: {str(job.get('error'))[:600]}")
        rows = result["query_result"]["data"]["rows"]
        return rows
    except Exception as error:  # noqa: BLE001 - recorded then re-raised
        status, error_text = "error", str(error)[:600]
        raise
    finally:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        with AUDIT_LOG.open("a", encoding="utf-8") as log:
            log.write(json.dumps({
                "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "label": label, "source": source,
                "sql_sha256": digest, "sql": _redact(sql), "status": status, "rows": len(rows),
                "seconds": round(time.time() - started, 2), "error": error_text,
            }) + "\n")


def _redact(sql: str) -> str:
    path = AUDIT_LOG.parent / "pseudonym-salt"
    return sql.replace(path.read_text().strip(), "<salt>") if path.exists() else sql


if __name__ == "__main__":
    # Usage: python -m ml.research.redash_client <source> "<sql>" [label]
    out = run(sys.argv[2], int(sys.argv[1]), label=sys.argv[3] if len(sys.argv) > 3 else "cli")
    print(json.dumps(out[:200], default=str, indent=1))
    print(f"-- {len(out)} rows", file=sys.stderr)
