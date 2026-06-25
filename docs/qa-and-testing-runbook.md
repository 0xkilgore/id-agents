# Kapelle QA & Testing Runbook

> Generated from code (`src/qa-runbook`). The taxonomy + regression sections are derived from `src/test-taxonomy` and `src/regression-coverage`; edit those, then regenerate. Do not hand-edit.

## Contents
- [1. Test taxonomy](#test-taxonomy) — `T-QA.1` · LIVE
- [2. Promotion gate](#promotion-gate) — `T-QA.1/Spec 054` · LIVE
- [3. Regression-coverage requirement](#regression-coverage) — `T-QA.5` · LIVE
- [4. Escape hatches (unrelated red suite)](#escape-hatches) — `T-QA.7` · LIVE
- [5. Per-agent pre-promotion requirements](#per-agent-requirements) — `T-QA.2` · PHASE 2
- [6. Live-UI / Vercel preview workflow](#vercel-preview) — `T-QA.3` · HELD
- [7. Standing verification cadence](#sentinel-cadence) — `T-QA.6` · PHASE 2

## 1. Test taxonomy

<a id="test-taxonomy"></a>_Track T-QA.1 · status: **LIVE**_

The six canonical test categories (`src/test-taxonomy`), fastest/most-local first:

- **Unit** (`unit`) — Catch logic regressions in a single module in isolation — the fastest, most local signal. _Gates promotion: yes; phases: local, ci, pre_promotion; invoke: `npm test`._
- **Integration** (`integration`) — Catch breakage across module boundaries and against real adapters/transports the unit layer stubs out. _Gates promotion: yes; phases: ci, pre_promotion; invoke: `npm run test:e2e`._
- **Smoke** (`smoke`) — Confirm a freshly built/deployed artifact boots and serves the basic happy path — a shallow go/no-go. _Gates promotion: yes; phases: pre_promotion, post_deploy; invoke: `id-agents promote-to-main --smoke "npm run build && npm test"`._
- **Regression** (`regression`) — Catch reintroduced or collateral breakage by re-running the EXISTING corpus broadly, not just the changed files. _Gates promotion: yes; phases: ci, pre_promotion; invoke: `npm test`._
- **Live-UI** (`live_ui`) — Catch UI/UX breakage that only appears in a real rendered browser (layout, interaction, console wiring). _Gates promotion: yes; phases: pre_promotion, scheduled; invoke: `(kapelle-site — Regina's lane: Playwright / manual browser verification)`._
- **Cross-system** (`cross_system`) — Catch divergence between two systems that must stay in contract/parity (id-agents ↔ Kapelle). _Gates promotion: conditional; phases: pre_promotion, scheduled; invoke: `npm test (parity suites) + the T-DEPLOY.6 weekly id-agents↔Kapelle parity lane`._

## 2. Promotion gate

<a id="promotion-gate"></a>_Track T-QA.1/Spec 054 · status: **LIVE**_

Pre-promotion gate (CLAUDE.md). All three must pass before any branch is promoted to `main`:

1. **Unit/regression**: `npm test` (vitest) — exit 0, all tests pass.
2. **Production build**: `npm run build` (tsc strict) — exit 0, no TypeScript errors.
3. **Dist artifacts**: `ls dist/<module>/` confirms compiled `.js` present.

Categories whose failure gates promotion: `unit`, `integration`, `smoke`, `regression`, `live_ui`.
vitest (swc, loose) passing is NOT sufficient — a clean tsc build is required.
Promote via `id-agents promote-to-main --smoke "npm run build && npm test"`.

## 3. Regression-coverage requirement

<a id="regression-coverage"></a>_Track T-QA.5 · status: **LIVE**_

Standing rule (`src/regression-coverage`): every typed failure mode must have a
regression test before its bug can reach `closed` (the bug-squash-log §4 gate).
A bug closed without a `regression_test_ref` — or with a ref that is not a real
test file — is a BLOCK violation; closing under the `other` mode is a WARN.

Catalogued failure modes:

- **`false_expire`** — An item is wrongly marked expired/stale/STALL when it is actually live — e.g. STALL reported while all build slots are full. _(e.g. continuous-orchestration false-STALL-on-full-slots)_
- **`rate_limit_cascade`** — A transport/connection failure is hardcoded/mislabeled as a provider rate limit (429), cascading into wrong retry/backoff behavior. _(e.g. provider_rate_limit_exhausted that was actually last_bounce_json.kind=transport)_
- **`deploy_gap`** — Correct shipped code is not actually loaded — a long-running orphan process or a missing restart/redeploy means the fix never took effect. _(e.g. 'fix isn't working' = orphan process (PPID 1) never cycled to load the new code)_
- **`backfill_defect`** — A backfill or read projection reads the wrong field or source — e.g. sorting by live fs mtime instead of the catalog's frozen produced_at. _(e.g. GET /artifacts sorted by fs.stat mtime not produced_at ('old artifacts landed at noon'))_
- **`agent_down_vs_provider_error`** — A down agent process is misattributed to a provider/server error, masking the real cause (process not listening on its port). _(e.g. provider_server_error/agent_unreachable that was the agent process being down)_
- **`placeholder_reuse`** — A query reuses a $N placeholder (each occurrence becomes a positional ?) or otherwise miscounts params → 'Too few parameter values'. _(e.g. SqliteAdapter $N reuse throwing on a routed query)_
- **`in_flight_leak`** — Dispatch in_flight rows are not reconciled out when their dispatch terminates, eventually strangling the scheduling loop. _(e.g. overnight loop-strangle fixed by reconciling in_flight items out on dispatch terminal)_
- **`other`** — A failure that does not yet have a typed mode. Still requires a regression test to close; type it (or add a new mode) when recurring. _(e.g. any one-off not yet a named class)_

## 4. Escape hatches (unrelated red suite)

<a id="escape-hatches"></a>_Track T-QA.7 · status: **LIVE**_

When a flaky or UNRELATED red test would block an otherwise-clean promotion
(the canonical case: a better-sqlite3 ABI break or a port-binding integration
flake reddening the full `npm test`), do NOT fall back to a manual force-push.
Use the T-QA.7 escape hatch (`src/cli/smoke-exempt.ts`):

```
id-agents promote-to-main --repo $REPO --branch $BR --execute \
  --smoke "npm run build && npm test" \
  --smoke-exempt "**/remote-heartbeat.test.ts"
```

If EVERY failing test file matches an exempt glob, the gate downgrades
abort→proceed and records `smoke.gate=passed_with_exempt_failures` +
`smoke.exempt_failures` in the promotion JSON (operator-visible). If ANY
non-exempt test fails — or none can be parsed — it aborts as before (exit 9).
Always confirm the exempted test is green IN ISOLATION before exempting it.

## 5. Per-agent pre-promotion requirements

<a id="per-agent-requirements"></a>_Track T-QA.2 · status: **PHASE 2**_

Each owning agent declares its required pre-promotion test set + threshold;
Spec 054 enforces the declared set per agent. Until the per-agent declarations
are ratified, the baseline for every code agent (Roger/Cane) is the §2 gate
(green `npm test` + clean tsc build + dist). Frontend (Regina) additionally
owns live-UI verification (§5). Paper agents (Maestra/CTO) are gated by no
code-test category — an unrelated red suite must not block a paper promotion.

## 6. Live-UI / Vercel preview workflow

<a id="vercel-preview"></a>_Track T-QA.3 · status: **HELD**_

**HELD (HC-15): needs a Vercel preview token from Chris (~5 min).** Once wired,
Sentinel hits the per-PR preview URL and runs smoke checks against the live UI,
so verification never has to say "flag for live-preview check". Until the token
lands, live-UI assertions are manual in the kapelle-site (Regina) lane; backend
changes a UI depends on are smoke/integration-gated here.

## 7. Standing verification cadence

<a id="sentinel-cadence"></a>_Track T-QA.6 · status: **PHASE 2**_

**Phase 2.** Standing verification cadence: the `id-agents-parity-weekly` loop
(T-DEPLOY.6) runs the `id-agents-compat` suite + reviews the parity ledger; the
Sentinel verification loop (L8) runs 2h/weekly/biweekly. Promote these from
ad-hoc to typed Loop runtime once the T10 substrate matures, budgeted via the
T-ORCH orchestration daemon. Sentinel retries under provider rate-limit rather
than re-firing (T-QA.4).
