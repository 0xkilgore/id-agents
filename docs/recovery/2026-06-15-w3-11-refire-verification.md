# W3-11 refire — verification (work already landed)

**Date:** 2026-06-15
**Refire dispatch:** phid:disp-5b04adac9be9e613
**Original (expired):** phid:disp-21cacf932ee3e212

## Finding

W3-11 entity-substrate Phase 1 is **already fully built, promoted, and green on
`main`** — no rebuild needed. The original dispatch was marked
`"linked query terminated expired"` by the over-aggressive in-flight sweep
(the incident fixed in commit 9ac1af7), which masked the successful closeout.
The "no branch/closeout" view was the wrong repo: W3-11 lives in the
**agent-platform** repo (the `@kilgore/task` package under `task-package/`),
not id-agents (which only holds the plan file).

## Evidence

- Repo: `agent-platform-task-package-v0` (remote: agent-platform.git).
- `origin/main` tip = **`d42e71ca78cb331238e1f584ac2447035c9335ff`** (W3-11),
  with `d42e71c` confirmed as an ancestor of (== tip of) `origin/main`.
- Remote branch `feat/entity-substrate-phase1` present at `d42e71c`.
- Files on main: `task-package/entity-relations/registry.ts`,
  `document-models/{goal,track,idea}/v1/`, `processors/entity-index/`,
  `subgraphs/entities/`, Task extended in place.
- Focused tests at `d42e71c` (Node 23): **298 passed / 0 failed** across
  entity-relations + goal + track + idea + entity-index + entities.
- Full package suite when built: **533 passed / 0 failed**.
- Closeout: `~/Dropbox/Code/roger/completed/2026-06-15-w3-11-entity-substrate-phase1.md`.

## Phase 1A status

Phase 1A (shared entity-relations types/registry/helpers + tests) — the
"survivable first landing" requested — is **complete and on main** (15 tests
green), along with the rest of Phase 1.

## Action taken

Verified rather than rebuilt (rebuilding would duplicate landed work and risk
conflicts). No new code committed for this refire; this note is the artifact.
The local main *working checkout* is stale at `9ace0c7` — a `git pull` (or
fetch+reset to origin/main) brings it to `d42e71c`; the remote is correct.
