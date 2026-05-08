#!/usr/bin/env python3
"""Stuck-dispatch detector — Decision 3.1 (2026-05-04 session).

Scans the id-agents queries table for dispatches that have been pending
longer than HANG_THRESHOLD_MIN. For each, emits a markdown diagnostic to
`~/Dropbox/Code/cane/output/dispatch-hangs/<utc_timestamp>.md` with:

  * query_id, agent target, age, message preview
  * manager process PID + child-process state
  * last log lines from /tmp/id-agents-manager.log
  * time since last news_items row for the same query_id

Intended to run on demand the next time CTO (or any other dispatch) hangs:
we want diagnostics on disk, not guessing. Stdlib-only.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path.home() / ".id-agents" / "id-agents.db"
LOG_PATH = Path("/tmp/id-agents-manager.log")
OUT_DIR = Path.home() / "Dropbox" / "Code" / "cane" / "output" / "dispatch-hangs"
MANAGER_PORT = 4100
HANG_THRESHOLD_MIN = 5
LOG_TAIL_LINES = 40


def manager_pid() -> int | None:
    """Return PID of process listening on the manager port, or None."""
    try:
        out = subprocess.check_output(
            ["lsof", "-nP", "-iTCP", f"-i:{MANAGER_PORT}", "-sTCP:LISTEN", "-t"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None
    pids = [p for p in out.split() if p.isdigit()]
    return int(pids[0]) if pids else None


def child_processes(pid: int) -> list[dict[str, str]]:
    """Return list of {pid, state, etime, cmd} for descendants of pid."""
    try:
        # -g <pid> selects the whole process group; falls back to direct
        # children on systems where that doesn't include grandchildren.
        out = subprocess.check_output(
            ["ps", "-ax", "-o", "pid=,ppid=,state=,etime=,command="],
            text=True,
            stderr=subprocess.DEVNULL,
        )
    except (subprocess.CalledProcessError, FileNotFoundError):
        return []
    descendants: set[int] = {pid}
    rows: list[tuple[int, int, str, str, str]] = []
    for line in out.splitlines():
        parts = line.strip().split(None, 4)
        if len(parts) < 5:
            continue
        try:
            cpid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        rows.append((cpid, ppid, parts[2], parts[3], parts[4]))
    # Walk the parent map until no new descendants get added.
    changed = True
    while changed:
        changed = False
        for cpid, ppid, _, _, _ in rows:
            if ppid in descendants and cpid not in descendants:
                descendants.add(cpid)
                changed = True
    out_rows: list[dict[str, str]] = []
    for cpid, ppid, state, etime, cmd in rows:
        if cpid in descendants and cpid != pid:
            out_rows.append({
                "pid": str(cpid),
                "ppid": str(ppid),
                "state": state,
                "etime": etime,
                "cmd": cmd[:200],
            })
    return out_rows


def tail_log(path: Path, lines: int) -> str:
    if not path.exists():
        return f"(log not found: {path})"
    try:
        out = subprocess.check_output(["tail", "-n", str(lines), str(path)], text=True)
    except subprocess.CalledProcessError:
        return f"(tail failed on {path})"
    return out.rstrip()


def stuck_dispatches(db: sqlite3.Connection, threshold_ms: int, now_ms: int) -> list[sqlite3.Row]:
    cutoff = now_ms - threshold_ms
    rows = db.execute(
        """
        SELECT q.team_id, q.query_id, q.agent_id, q.prompt, q.status, q.created,
               COALESCE(a.name, q.agent_id) AS agent_name
        FROM queries q
        LEFT JOIN agents a ON a.id = q.agent_id
        WHERE q.status IN ('pending', 'processing')
          AND q.created < ?
        ORDER BY q.created ASC
        """,
        (cutoff,),
    ).fetchall()
    return rows


def last_news_for_query(db: sqlite3.Connection, query_id: str) -> int | None:
    row = db.execute(
        "SELECT MAX(timestamp) FROM news_items WHERE query_id = ?",
        (query_id,),
    ).fetchone()
    return row[0] if row and row[0] is not None else None


def fmt_ms_age(now_ms: int, then_ms: int | None) -> str:
    if then_ms is None:
        return "n/a"
    secs = max(0, (now_ms - then_ms) / 1000.0)
    if secs < 60:
        return f"{secs:.0f}s"
    if secs < 3600:
        return f"{secs / 60:.1f}m"
    return f"{secs / 3600:.2f}h"


def build_report(stuck: list[sqlite3.Row], db: sqlite3.Connection, now_ms: int,
                 pid: int | None, children: list[dict[str, str]], log_tail: str) -> str:
    iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines: list[str] = [f"# Stuck-dispatch report — {iso}", ""]
    lines.append(f"- threshold: {HANG_THRESHOLD_MIN} min")
    lines.append(f"- manager pid: {pid if pid is not None else 'NOT FOUND (port ' + str(MANAGER_PORT) + ' not listening)'}")
    lines.append(f"- stuck dispatches found: {len(stuck)}")
    lines.append("")
    if stuck:
        lines.append("## Stuck dispatches")
        for q in stuck:
            age = fmt_ms_age(now_ms, q["created"])
            news_ts = last_news_for_query(db, q["query_id"])
            news_age = fmt_ms_age(now_ms, news_ts)
            preview = (q["prompt"] or "").replace("\n", " ")[:160]
            lines.extend([
                f"### query {q['query_id']}",
                f"- agent: `{q['agent_name']}` (id `{q['agent_id']}`)",
                f"- team: `{q['team_id']}`",
                f"- status: `{q['status']}`",
                f"- age since dispatch: {age}",
                f"- last news_items row for this query: {news_age} ago",
                f"- prompt preview: `{preview}`",
                "",
            ])
    lines.append("## Manager child processes")
    if pid is None:
        lines.append("- (manager not running)")
    elif not children:
        lines.append("- (no descendants found)")
    else:
        lines.append("| pid | ppid | state | etime | cmd |")
        lines.append("|---|---|---|---|---|")
        for c in children:
            cmd = c["cmd"].replace("|", "\\|")
            lines.append(f"| {c['pid']} | {c['ppid']} | {c['state']} | {c['etime']} | {cmd} |")
    lines.append("")
    lines.append(f"## Last {LOG_TAIL_LINES} lines of {LOG_PATH}")
    lines.append("```")
    lines.append(log_tail)
    lines.append("```")
    return "\n".join(lines) + "\n"


def main(argv: list[str]) -> int:
    if not DB_PATH.exists():
        print(f"[dispatch-hang-detector] DB not found: {DB_PATH}", file=sys.stderr)
        return 2
    now_ms = int(time.time() * 1000)
    threshold_ms = HANG_THRESHOLD_MIN * 60 * 1000

    db = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    try:
        stuck = stuck_dispatches(db, threshold_ms, now_ms)
        force = "--force" in argv
        if not stuck and not force:
            print("[dispatch-hang-detector] no stuck dispatches; nothing to report (use --force to write anyway)")
            return 0

        pid = manager_pid()
        children = child_processes(pid) if pid is not None else []
        log_tail = tail_log(LOG_PATH, LOG_TAIL_LINES)
        report = build_report(stuck, db, now_ms, pid, children, log_tail)
    finally:
        db.close()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_path = OUT_DIR / f"{ts}.md"
    out_path.write_text(report, encoding="utf-8")
    print(f"[dispatch-hang-detector] wrote {out_path} ({len(stuck)} stuck dispatch(es))")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
