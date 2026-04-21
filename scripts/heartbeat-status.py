#!/usr/bin/env python3
"""
Aggregate heartbeat smoke-test results for every agent in kilgore-team.yaml.

Data sources:
  - id-agents.db `schedule_runs` + `schedule_definitions` for when each heartbeat fired.
  - each agent's live `/news` endpoint for the corresponding response payload
    (the agent writes the scheduled query result into its in-memory news feed;
     the manager does not persist responses to the DB, so we read from the
     agent directly).

For each agent, walks the most recent N heartbeat runs, correlates each run
with a `query.completed` news item via the `schedule.received` event's
query_id, applies the success rule from spec 030 §2 (response contains
`HB-OK-`, embedded ISO timestamp parses, |fired_at - parsed_ts| ≤ 120s),
computes per-agent last_pass_at / last_fail_at / consecutive_fails, prints
a table, and writes reports/heartbeat-status.json.

Exit 0 if no agent has consecutive_fails >= 2, else 1.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = REPO_ROOT / "configs" / "kilgore-team.yaml"
REPORTS_DIR = REPO_ROOT / "reports"
REPORT_PATH = REPORTS_DIR / "heartbeat-status.json"

DB_CANDIDATES = [
    Path.home() / ".id-agents" / "id-agents.db",
    REPO_ROOT / "id-agents.db",
]

HB_OK_RE = re.compile(r"HB-OK-(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)")
MAX_RUNS_PER_AGENT = 10
CLOCK_TOLERANCE_SECONDS = 120
NEWS_FETCH_TIMEOUT = 5


def find_db() -> Path:
    for path in DB_CANDIDATES:
        if path.exists():
            return path
    print(f"error: id-agents.db not found (looked in {[str(p) for p in DB_CANDIDATES]})", file=sys.stderr)
    sys.exit(2)


def load_agent_names(config_path: Path) -> list[str]:
    """Parse agent names from the kilgore-team.yaml without pulling in PyYAML."""
    names: list[str] = []
    in_agents = False
    with config_path.open() as f:
        for line in f:
            stripped = line.rstrip("\n")
            if stripped.startswith("agents:"):
                in_agents = True
                continue
            if in_agents:
                if stripped and not stripped.startswith((" ", "\t", "#")):
                    break
                m = re.match(r"\s*-\s*name:\s*(\S+)", stripped)
                if m:
                    names.append(m.group(1))
    return names


def validate_response(message: str, fired_at: int) -> tuple[bool, str | None, str | None]:
    """Return (is_pass, parsed_ts_iso, error_reason)."""
    if not message:
        return False, None, "empty response"
    m = HB_OK_RE.search(message)
    if not m:
        preview = message.strip().replace("\n", " ")[:80]
        return False, None, f"response format invalid: {preview!r}"
    ts_str = m.group(1)
    try:
        parsed = datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        return False, None, f"timestamp unparsable: {ts_str}"
    delta = abs(int(parsed.timestamp()) - fired_at)
    if delta > CLOCK_TOLERANCE_SECONDS:
        return False, ts_str, f"timestamp drift Δ={delta}s (>{CLOCK_TOLERANCE_SECONDS}s)"
    return True, ts_str, None


def fetch_agent_news(endpoint: str) -> list[dict] | None:
    """GET /news on an agent. Returns news items or None on failure."""
    try:
        with urllib.request.urlopen(f"{endpoint}/news", timeout=NEWS_FETCH_TIMEOUT) as resp:
            payload = json.load(resp)
        if isinstance(payload, dict):
            return payload.get("items") or payload.get("news") or []
        return payload or []
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def index_agent_news(items: list[dict]) -> dict[str, dict]:
    """Build query_id -> {scheduled_key, schedule_id, response, completed_at} map.

    We walk all items, collecting:
      - `schedule.received` events → (query_id, scheduled_key, schedule_id)
      - `query.completed` events → (query_id, response message, timestamp)
    """
    by_qid: dict[str, dict] = {}
    for item in items:
        data = item.get("data") or {}
        qid = data.get("query_id")
        if not qid:
            continue
        entry = by_qid.setdefault(qid, {
            "scheduled_key": None,
            "schedule_id": None,
            "response": None,
            "completed_at": None,
        })
        t = item.get("type")
        if t == "schedule.received":
            sched = data.get("schedule") or {}
            entry["scheduled_key"] = sched.get("scheduledKey")
            entry["schedule_id"] = sched.get("id")
        elif t == "query.completed":
            result = data.get("result") or {}
            if isinstance(result, dict):
                entry["response"] = result.get("result")
            else:
                entry["response"] = result
            entry["completed_at"] = item.get("timestamp")
    return by_qid


def correlate_run_with_news(
    news_by_qid: dict[str, dict],
    schedule_id: str,
    scheduled_key: str,
) -> dict | None:
    """Find the news entry matching this schedule_run."""
    for entry in news_by_qid.values():
        if entry["schedule_id"] == schedule_id and entry["scheduled_key"] == scheduled_key:
            return entry
    return None


def fetch_runs(conn: sqlite3.Connection, agent_id: str, limit: int) -> list[dict]:
    rows = conn.execute(
        """
        SELECT r.scheduled_at, r.fired_at, r.status, r.error, r.scheduled_key, d.id
        FROM schedule_runs r
        JOIN schedule_definitions d ON d.id = r.schedule_id
        WHERE r.agent_id = ? AND d.kind = 'heartbeat'
        ORDER BY r.fired_at DESC
        LIMIT ?
        """,
        (agent_id, limit),
    ).fetchall()
    return [
        {
            "scheduled_at": r[0],
            "fired_at": r[1],
            "status": r[2],
            "error": r[3],
            "scheduled_key": r[4],
            "schedule_id": r[5],
        }
        for r in rows
    ]


def evaluate_run(run: dict, news_by_qid: dict[str, dict] | None) -> dict:
    fired_at = run["fired_at"]
    result = {
        "scheduled_at": run["scheduled_at"],
        "fired_at": fired_at,
        "schedule_status": run["status"],
        "schedule_error": run["error"],
        "passed": False,
        "error": None,
        "response_ts": None,
    }

    if run["status"] and run["status"] not in ("sent", "completed"):
        result["error"] = f"scheduler status={run['status']}: {run['error'] or 'no detail'}"
        return result

    if news_by_qid is None:
        result["error"] = "agent unreachable (cannot fetch /news)"
        return result

    entry = correlate_run_with_news(news_by_qid, run["schedule_id"], run["scheduled_key"])
    if not entry:
        result["error"] = "no matching news entry (agent may not have completed response yet)"
        return result
    if entry["response"] is None:
        result["error"] = "response not yet saved (query still processing?)"
        return result

    is_pass, parsed_ts, reason = validate_response(entry["response"], fired_at)
    result["response_ts"] = parsed_ts
    if not is_pass:
        result["error"] = reason
        return result

    result["passed"] = True
    return result


def iso_utc(ts: int | None) -> str | None:
    if ts is None:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def print_table(rows: list[dict]) -> None:
    header = ("AGENT", "LAST PASS", "CONSEC FAIL", "LATEST ERROR")
    widths = (20, 24, 13, 60)

    def fmt(parts):
        return "  ".join(str(p).ljust(w) for p, w in zip(parts, widths))

    print(fmt(header))
    print("  ".join("-" * w for w in widths))
    for r in rows:
        last_pass = r["last_pass_at"] or "—"
        err = r["latest_error"] or "—"
        print(fmt((r["name"], last_pass, r["consecutive_fails"], err[:widths[3]])))


def main() -> int:
    db_path = find_db()
    agent_names = load_agent_names(CONFIG_PATH)
    if not agent_names:
        print(f"error: no agents found in {CONFIG_PATH}", file=sys.stderr)
        return 2

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only = ON")

    agent_rows = conn.execute(
        """
        SELECT name, id, endpoint, status
        FROM agents
        WHERE deleted_at IS NULL
        """
    ).fetchall()
    by_name: dict[str, tuple[str, str | None, str]] = {
        r[0]: (r[1], r[2], r[3]) for r in agent_rows
    }

    rows_out: list[dict] = []
    any_alerting = False

    for name in agent_names:
        meta = by_name.get(name)
        if not meta:
            rows_out.append({
                "name": name,
                "last_pass_at": None,
                "last_fail_at": None,
                "consecutive_fails": 0,
                "latest_error": "agent not found in DB",
                "alerting": False,
                "runs_checked": 0,
            })
            continue

        agent_id, endpoint, status = meta

        runs = fetch_runs(conn, agent_id, MAX_RUNS_PER_AGENT)
        if not runs:
            rows_out.append({
                "name": name,
                "last_pass_at": None,
                "last_fail_at": None,
                "consecutive_fails": 0,
                "latest_error": "no heartbeat runs yet",
                "alerting": False,
                "runs_checked": 0,
            })
            continue

        news_items = fetch_agent_news(endpoint) if endpoint and status == "running" else None
        news_by_qid = index_agent_news(news_items) if news_items is not None else None

        evaluated = [evaluate_run(r, news_by_qid) for r in runs]
        evaluated.sort(key=lambda e: e["fired_at"], reverse=True)

        last_pass = next((e["fired_at"] for e in evaluated if e["passed"]), None)
        last_fail = next((e["fired_at"] for e in evaluated if not e["passed"]), None)
        latest_error = next((e["error"] for e in evaluated if not e["passed"]), None)

        consecutive_fails = 0
        for e in evaluated:
            if e["passed"]:
                break
            consecutive_fails += 1

        alerting = consecutive_fails >= 2
        if alerting:
            any_alerting = True

        rows_out.append({
            "name": name,
            "last_pass_at": iso_utc(last_pass),
            "last_fail_at": iso_utc(last_fail),
            "consecutive_fails": consecutive_fails,
            "latest_error": latest_error,
            "alerting": alerting,
            "runs_checked": len(evaluated),
        })

    report = {
        "generated_at": datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "agents": rows_out,
        "any_alerting": any_alerting,
    }

    REPORT_PATH.write_text(json.dumps(report, indent=2) + "\n")

    print_table(rows_out)
    print()
    print(f"Report: {REPORT_PATH}")
    print(f"Alerting: {any_alerting}")

    return 1 if any_alerting else 0


if __name__ == "__main__":
    sys.exit(main())
