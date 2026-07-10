---
authored_by: cto
project: kapelle
track: KG-01/T-DECHRIS
kind: audit-and-fix
date: 2026-07-09
task: de-chris-grep-audit-id-agents
status: done
responds_to: query_1783652111152_a3ua3kw
scope: cane/id-agents (KG-01 next-48h slice 4)
---

# De-Chris audit — `cane/id-agents`

Grep/audit for hard-coded Chris-specific paths, user names, account/domain categories,
and Chris-only env defaults in `cane/id-agents`, per KG-01's next-48h slice 4
(`agent-platform/output/2026-07-08-kapelle-gideon-two-week-roadmap-reset.md:118`).

## Method

`grep -rl "/Users/kilgore\|kilgore@\|com\.kilgore\|Dropbox/Code"` across `src/`, `scripts/`,
`configs/` (excluding tests/fixtures), plus a second pass for literal `"chris"`/`"kilgore"`
string values (not just paths) in `src/`. 22 files matched the path pattern; 13 matched the
literal-identity pattern.

## Severity framing

The dispatch asked for two buckets (blocks fresh-account boot vs. cosmetic). I found a
third, real category worth naming rather than forcing into one of the two: **breaks first
meaningful use, but does not block boot**. Nothing found here prevents a fresh Gideon
account from booting the manager and reaching the cockpit — but several defaults would
silently misattribute a fresh account's own first actions to a person who doesn't exist on
their team. I fixed that category in this pass; it's distinct from both "boot-blocking"
(none found) and "cosmetic" (paths/fleet-topology, already gracefully handled or
irrelevant to the KG-01 first-run bar).

## Findings — boot-blocking (fixed or would need fixing to boot)

**None found.** Every hard-coded Chris-specific filesystem default I found already
degrades gracefully for a fresh account:

- `src/agent-manager-db.ts:1938-1941` (`FILESYSTEM_ARTIFACT_PROJECT_PARENT` default
  `${HOME}/Dropbox/Code`) — checked with `existsSync`; returns `[]` (no project artifact
  roots) rather than throwing when absent.
- `src/usage-meter/runtime-mix.ts:125` (`readWorkShareTargets` default configPath under
  Chris's exact repo path) — wrapped in try/catch that "never throws" per its own doc
  comment; returns `null` and the caller uses its own default.
- `src/harness/cursor-fallback-health.ts:30` (`DEFAULT_BINARY` at Chris's local cursor-agent
  path) — overridable via `CURSOR_AGENT_PATH`/`options.binary`; a missing binary at the
  fallback path just produces `status: "unavailable"`, which is the correct behavior for
  KG-01's R5 Claude-only-degradation requirement, not a crash.
- `src/workspaces/repo-registry.ts` (`DEFAULT_PROTECTED_ROOTS`, all Chris/Liz machine
  paths) — the module's own header comment says this is intentional: "the real absolute
  paths for Chris/Liz machines live in a private overlay (`IDAGENTS_REPO_REGISTRY`)... public
  kapelle ships synthetic fixtures." `RepoRegistry.resolve()` returns `null` (no match, not
  an error) for any path outside the seeded roots — a fresh account's repos are simply
  unprotected by default rather than blocked. Correct today; only matters once Gideon's own
  fleet does autonomous build dispatches (see deferred item below).

## Findings — first-use-breaking, fixed in this pass

Root cause: several routes/read-models fall back to the literal string `"chris"` when no
actor/owner is supplied by the caller. For Chris's own account this is invisible (he *is*
chris). For a fresh Gideon account, any call that omits an explicit actor would have its
item/approval/decision **silently attributed to a person who doesn't exist on their team**
— a real, visible correctness bug on first use, not a crash.

Fixed by adding `src/lib/default-actor.ts`: `DEFAULT_ACTOR_ID = process.env.KAPELLE_DEFAULT_ACTOR_ID
|| "chris"` — additive and zero-risk for Chris (unset env = byte-identical behavior to
before this change), and gives any other deployment a way to set their own fallback.
Applied at:

- `src/desk/needs-me.ts:96` (`normalizeOwner` fallback for the "needs me" digest filter).
- `src/continuous-orchestration/routes.ts:229,444,449,480` (four `approved_by`/`actor_ref`
  fallbacks on the backlog-promote and flesh-approve/reject routes).

Both areas are ones a fresh account's CoS/approval flow (scoped this morning in
`cto/output/2026-07-09-greenfield-cos-build-lane-acceptance.md`) would plausibly exercise
on day one.

## Findings — deferred, too large/coupled for this pass

Each gets a proposed owner/track rather than a fix here, per the dispatch's own escape
hatch:

1. **`src/decisions/*` owner defaults to `"chris"` in five places**, including a **SQL
   schema default** (`src/decisions/storage.ts:32`:
   `owner TEXT NOT NULL DEFAULT 'chris'`) plus `routes.ts:563`, `producer.ts:257`,
   `bootstrap.ts:155`, and the `types.ts:129` type comment. This is the same class of bug
   as the fixes above, but changing a `DEFAULT` on a live schema column touches migration
   territory and a cohesive 5-file subsystem — more review than this pass's "fix the
   boot-blockers" scope warrants. **Proposed owner: substrate-api-codex, track T-DECHRIS
   follow-up**, same `DEFAULT_ACTOR_ID` pattern, with a migration for the column default.
2. **`decision: "approved_by_chris"` literal** (`continuous-orchestration/routes.ts:452`)
   — an enum-like decision-code string with "chris" baked into its name. Left untouched:
   renaming risks breaking any downstream consumer that filters/reports on this exact
   string. **Proposed owner: whoever owns the decision-log consumers**, rename only after
   confirming no live report/filter depends on the literal string.
3. **`health-projection.ts:625` `owner_lane: "chris"` + `recommended_action: "ask Chris for
   the product or operator decision needed to resume"`** — a catch-all "ask the human
   operator" fallback in blocker-routing recommendation copy. Cosmetic (wrong name in a
   recommendation string, not a functional block) but worth genericizing alongside item 1.
   **Proposed owner: substrate-orch-codex, same follow-up track.**
4. **`dispatch-scheduler/manager-integration.ts:277-282` `CHRIS_DASHBOARD_ACTOR`** —
   defined but **unused** anywhere else in the codebase (dead code). Zero runtime impact;
   worth deleting on general hygiene grounds, not a de-Chris fix. No owner assigned, low
   priority.
5. **Chris's own multi-agent fleet topology** — `src/build-pools/registry.ts` (SEED pools
   keyed to Chris's specific agent names: roger, regina, brunel, etc.), `src/dispatch-scheduler/types.ts:299-307`
   (`CANONICAL_REPO_ALIASES` mapping Chris's specific codex-agent working dirs),
   `src/continuous-orchestration/config.ts:138` (`defaultFleshConfig`'s `rogerScopes`
   hardcoded to Chris's `id-agents` path, lane owner `"roger"`). All of this is Chris's own
   autonomous multi-agent build-fleet configuration — not exercised by KG-01's first-run-
   to-cockpit acceptance bar (a fresh Gideon account has no agents named "roger"/"regina"
   and isn't running autonomous build-pool dispatch on day one). Genuinely out of scope for
   this alpha; genericizing build-pool/dispatch-lane seeding is its own scope decision for
   whenever Gideon's product needs autonomous coding-fleet features. **Proposed owner: CTO
   to scope when that feature is greenlit; no action now.**
6. **`src/actor-identity.ts`** (`"Monday second-user actor identity foundation"`,
   hardcoded `"chris" | "liz"` actor type) — reviewed and **explicitly not a de-Chris
   issue**: this is a deliberately scoped, documented allowlist for a specific "Monday"
   household feature ("Liz build plan §1"), not the general Kapelle/Gideon actor system.
   Confirmed no cross-import into any Gideon-relevant route during this audit. Flagging
   here only so it isn't mistakenly re-flagged in a future de-Chris pass.
7. **Ops/deploy scripts** (`scripts/deploy-freshness-watchdog.mjs`,
   `scripts/ingest-decisions.ts`, `scripts/launchd/*.plist`,
   `scripts/lib/deploy-watchdog-closeout.mjs`, `scripts/reconcile-derived-evidence.mjs`,
   `scripts/reconcile-recovery-evidence.mjs`) — Chris's own operational tooling (launchd
   jobs, deploy watchdog, decision-log ingestion), not part of what ships to or runs inside
   a Gideon account. Not applicable to de-Chris scope; noted only for completeness of the
   grep.

## Regression note

**Fixed and landed this pass:**
- `src/lib/default-actor.ts` (new): `DEFAULT_ACTOR_ID`, env-overridable via
  `KAPELLE_DEFAULT_ACTOR_ID`, defaults to `"chris"` when unset (byte-identical behavior for
  Chris's existing account).
- `src/desk/needs-me.ts`: `normalizeOwner` fallback now uses `DEFAULT_ACTOR_ID`.
- `src/continuous-orchestration/routes.ts`: four `approved_by`/`actor_ref` fallbacks (backlog
  promote route, flesh approve route ×2, flesh reject route) now use `DEFAULT_ACTOR_ID`.

**Verified:** `tsc --noEmit` clean; `desk-tray.test.ts`,
`continuous-orchestration-admission.test.ts`, `orchestration-auto-promote-policy.test.ts`,
`promotion-rescue-admit.test.ts` (79 tests) green; full `npm test` run green (see closeout).

**Deferred, with proposed owner/track** (items 1-5 above): `decisions/*` owner-default
subsystem (schema + 4 call sites), the `approved_by_chris` decision-code literal,
`health-projection.ts`'s recommendation copy, dead `CHRIS_DASHBOARD_ACTOR` export, and
Chris's own build-pool/dispatch-lane fleet topology (out of scope for this alpha's
first-run bar entirely).

**Explicitly reviewed and NOT an issue:** `src/actor-identity.ts`'s Monday-specific
Chris/Liz allowlist (deliberately scoped, not cross-imported into Gideon-relevant routes);
all filesystem-path defaults found (all gracefully degrade already).
