# Fleet File-Drop Implementation Plan

Date: 2026-07-04
Owner: cto
Build owner: Roger
Source spec: `cto/output/fleet-file-drop-spec.md` (approved by Chris, dispatch `phid:disp-0cec9b71fd26255d`)
Dispatch (this plan): `phid:disp-43ec78706f33fdbb`
Repo: `cane/id-agents` (manager + glue scripts live here; this is also the repo checked out on both Chris's laptop and blitz via Dropbox, so the sender script and receiver watcher can both ship from the same tree)

## Goal

Replace Dropbox/Downloads as the agent file-intake path with a Tailscale-Taildrop-based
"drop signals agent X is ready to look" pipeline, per the approved spec. Chris runs one
command on his laptop; bytes are confirmed landed (not just "Dropbox says synced") at
send time; the target agent sees a task appear within seconds of the drop completing.

Three build slices, matching the spec's §4.1–4.3, plus the three design decisions the
spec left open (§6) are resolved below rather than left for Roger to guess.

## Design decisions (resolving spec §6 open items)

**1. Drop destination path — no new `~/AgentDrops/` convention; use the agent's own
working directory.** The manager's `GET /agents` already returns each agent's
canonical `workingDirectory` (e.g. `finances` → `/Users/kilgore/Dropbox/Code/finances`,
confirmed live from the running registry today). Land each batch at
`<agent.workingDirectory>/inbox/<batch_id>/` — this reuses the same per-agent-owns-its-directory
convention this fleet already follows for `./output/` (every agent writes its own
artifacts under its own working directory; `./inbox/` is the natural inbound
counterpart). No new top-level directory, no separate convention to document or drift
from.

**2. Confirmation channel — reuse the existing Telegram alert path, not the
`PushNotification` tool.** `PushNotification` is a Claude-Code-harness tool scoped to a
live agent session (it notifies whoever is watching that session/terminal/phone via
Remote Control) — it has no standalone HTTP surface a launchd script can call. The
fleet already has a working, plain-script-callable alert channel for exactly this class
of event: `sendTelegramAlert()` (`src/continuous-orchestration/telegram.ts:10-29`),
configured via `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` env vars and already used for
freshness/stall alerts. The watcher script calls the same Telegram HTTP endpoint
directly (`curl` to `api.telegram.org/bot<token>/sendMessage`) rather than depending on
a Claude session being open.

**3. Agent → host/directory resolution — no static config file; resolve live via
`GET /agents`.** A hardcoded map is exactly the kind of silently-driftable state this
feature exists to eliminate (see the Dropbox Smart Sync incident that started this
work). Every agent in this fleet currently shows `deploymentShape: "local-process"` on
blitz, so host resolution is moot for v1 — but even so, the watcher should resolve
`agent name → workingDirectory` by querying the manager's live registry
(`GET http://127.0.0.1:4100/agents`, already exists, already authoritative) at
drop-processing time, not from a file that can go stale. If a future agent runs
elsewhere, this same lookup keeps working without a config change.

## Scope

**In scope (spec §4.1–4.3):**
- `agentdrop` sender CLI (laptop-side).
- `agentdrop-watcher` — launchd-managed receiver process on blitz.
- `agentdrop.v1` manifest schema (shared contract between sender and watcher).
- Manager-side task-creation hook (`POST /tasks`) triggered by the watcher.
- Telegram confirmation on successful drop processing.
- Wiring `--for finances` end to end and retiring Dropbox/Downloads as the finances
  intake path once verified.

**Out of scope (defer to a follow-up, not this build):**
- iOS Share-Sheet / Shortcuts action (spec flagged as v2).
- The general-purpose Dropbox placeholder/hydration watchdog for non-agent-drop
  folders (spec §3, defense-in-depth only, unrelated build).
- Any change to how agents are provisioned/deployed (`deploymentShape` handling
  beyond `local-process`) — not needed until a non-local agent exists.

## Slice A — `agentdrop.v1` manifest schema + sender CLI

**What:** A small script Chris runs on his laptop:

```
agentdrop --for finances bank1.csv bank2.csv bank3.csv ...
```

**Behavior:**
1. Validate `--for <agent-name>` resolves to a real, running agent via
   `GET $MANAGER_URL/agents` (fail fast with a clear error if not — e.g. typo'd agent
   name — rather than sending bytes nowhere).
2. Generate `batch_id` (`<ISO-timestamp>-<short-random>`), write `_dropmeta.json`
   alongside the batch:
   ```json
   {
     "schema": "agentdrop.v1",
     "batch_id": "2026-07-04T22-41-00Z-a1b2c3",
     "agent": "finances",
     "sender": "chris",
     "files": ["bank1.csv", "bank2.csv", "bank3.csv"],
     "sent_at": "2026-07-04T22:41:00Z"
   }
   ```
3. Run `tailscale file cp <files...> _dropmeta.json blitz:` and block on it.
4. On exit 0: print byte count / file count summary — this is Chris's immediate,
   in-terminal confirmation. On non-zero exit: print the raw `tailscale` stderr and
   exit non-zero (no silent failure).

**Location:** `cane/id-agents/scripts/agentdrop` (executable; laptop and blitz both
have this repo checked out via Dropbox, so no separate install/distribution step).

**Acceptance criteria:**
- Running `agentdrop --for finances a.csv b.csv` against a real `blitz` Taildrop peer
  produces a `_dropmeta.json` with correct `batch_id`/`agent`/`files`/`sent_at`, and
  exits 0 only after `tailscale file cp` itself exits 0.
- `--for <unknown-agent>` fails before attempting any transfer, with a message naming
  the unresolvable agent.
- Killing the network mid-transfer (or an offline `blitz` peer) produces a non-zero
  exit and a visible error in the same terminal invocation — no silent hang, no
  90-minute timeout anywhere in this path.
- Unit test the manifest-construction logic in isolation (pure function: inputs →
  manifest dict) separately from the `tailscale` subprocess call, so manifest
  correctness doesn't require a real tailnet in CI.

## Slice B — `agentdrop-watcher` (receiver, blitz)

**What:** A persistent launchd job that drains the Taildrop inbox, verifies each
batch, delivers it to the target agent's own directory, and creates a task.

**Behavior:**
1. Run `tailscale file get --wait --loop <staging-dir>` as the drain loop
   (`KeepAlive: true` in the launchd plist — this is the only long-running new
   process this feature introduces).
2. On each drained batch: locate `_dropmeta.json`, validate it against the
   `agentdrop.v1` schema (required fields present, `files` list matches what actually
   landed — reject/log-and-alert on a mismatch rather than silently proceeding with a
   partial batch).
3. Resolve `manifest.agent` via `GET $MANAGER_URL/agents` (per Design Decision 3
   above). If the named agent doesn't exist in the live registry, do not guess — leave
   the batch in a `_failed/` staging subdirectory and fire a Telegram alert naming the
   problem, rather than silently dropping files nowhere.
4. Move the verified batch to `<agent.workingDirectory>/inbox/<batch_id>/` (per Design
   Decision 1).
5. `POST $MANAGER_URL/tasks`:
   ```json
   { "title": "Process file drop: finances (2026-07-04T22-41-00Z-a1b2c3, 3 files)",
     "name": "drop-finances-2026-07-04t2241-a1b2c3",
     "from": "agentdrop-watcher" }
   ```
   This is the "drop signals agent X is ready to look" hook — `finances` (or any
   agent) discovers new work exactly the way it discovers every other unit of work in
   this fleet: by seeing a task, per the standard task-lifecycle convention already in
   every agent's CLAUDE.md. No bespoke per-agent file-watcher needed.
6. Send a Telegram alert confirming processing completed: file count, total bytes,
   target agent, task name (per Design Decision 2).

**Location:** `cane/id-agents/scripts/agentdrop-watcher` + a launchd plist under
`cane/id-agents/scripts/launchd/com.kilgore.agentdrop-watcher.plist` (documented
install step: `launchctl load`, matching however other launchd-managed pieces of this
fleet are already installed — check `deploy-guard`/existing plists in this repo for
the established install convention before inventing a new one).

**Acceptance criteria:**
- A batch dropped via Slice A's CLI is fully drained from the Taildrop inbox, moved to
  `<finances-workingDirectory>/inbox/<batch_id>/`, and produces exactly one task via
  `POST /tasks`, within one drain-loop cycle (`tailscale file get --loop` reacts as
  files arrive — no polling interval to tune).
- A manifest naming a nonexistent agent is quarantined (not silently dropped, not
  guessed at) and raises a Telegram alert identifying the bad manifest.
- A batch missing `_dropmeta.json` entirely (e.g. a stray manual `tailscale file cp`
  without going through `agentdrop`) is quarantined with a clear alert rather than
  crashing the watcher loop or being silently ignored — the loop must keep draining
  subsequent batches even after a malformed one.
- The launchd job survives a `blitz` reboot (`RunAtLoad` + `KeepAlive` both set) — this
  is meant to be always-on infrastructure, not something Chris has to remember to
  start.
- Regression test for the failure mode that started this whole feature: simulate an
  agent-name/path resolution failure and confirm it surfaces loudly (Telegram alert)
  rather than the file sitting silently unprocessed the way the Dropbox placeholder
  did for 24+ hours.

## Slice C — retire Dropbox/Downloads as the finances intake path

**What:** Once Slice A+B are verified end-to-end with `--for finances`, update any
docs/CLAUDE.md pointers that currently tell the `finances` agent (or Chris) to expect
files in Dropbox/Downloads for this recurring case, so the new path is the documented
one going forward. Dropbox/Downloads remains the general-purpose file-drop location
for everything else (per the global CLAUDE.md convention) — this slice narrows scope
to just the recurring batch-CSV/export case this feature was built for.

**Acceptance criteria:**
- A real end-to-end run: Chris (or a test harness standing in for him) drops a batch
  of CSVs via `agentdrop --for finances`, and the `finances` agent picks up the
  resulting task and finds the files at the documented `inbox/<batch_id>/` path with
  no manual intervention.
- Any doc that previously told `finances` to watch Dropbox/Downloads for this case is
  updated to point at the new `inbox/` convention.

## Testing plan

- Slices A and B each get unit coverage for their pure logic (manifest construction,
  manifest validation, agent-resolution logic) independent of any real `tailscale`
  binary or live tailnet, so the suite runs in CI without tailnet access.
- One integration test (can be manual/documented rather than automated, given it
  needs a real Tailscale peer pair) exercising the full path: real `agentdrop` call →
  real watcher drain → real task appears via `GET /tasks`.
- Failure-path tests are not optional here — the entire point of this feature is
  closing a silent-failure gap, so "malformed manifest," "unknown agent," and
  "watcher restart mid-batch" all need explicit coverage, not just the happy path.

## Rollout

Ship Slice A + B together (the CLI is useless without the receiver, and vice versa),
verify with a throwaway agent name first, then Slice C once `--for finances` is
proven. Matches the spec's original 2–3 day estimate — no new information from this
planning pass changes that; if anything, resolving the three open items in advance
(rather than leaving them as in-build guesses) should keep Roger on that estimate
rather than adding a design-discussion detour mid-build.
