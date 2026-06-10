# Kapelle B11 Chris Feedback Architecture Note

> **Imported into id-agents 2026-06-10** from `cto/output/2026-06-08-kapelle-b11-chris-feedback-architecture.md` with RD-001 (decision #49 — stable record identity is canonical; display IDs are derived; operations reference stable IDs only) encoded per `cto/output/2026-06-09-rd001-spec-language-scope.md`. RD-001 normative blocks live in the OutputInboxItem DTO section, the No-404 / Ghost File Behavior section, and the Acceptance Bar After Restart section. See `docs/specs/rd001-record-identity.md` for the cross-package summary.

Date: 2026-06-08
Owner: cto
Task: `process-kapelle-b11-architecture-feedback`

## Executive Recommendation

Incorporate Chris's feedback as a backend-contract cleanup before accepting B11 as green. The current Kapelle site branch is a useful frontend slice, and Cane's manager backend foundation is directionally right, but the architecture should be tightened in three places before restart/acceptance:

1. Treat usage as one manager-owned source of truth: existing `GET /usage`.
2. Put output-list display metadata directly in the manager `/outputs/inbox` read model, sourced from the artifact catalog/delivery log upstream.
3. Make ghost-file behavior explicit: missing artifacts should be rows with `artifact_status: "missing"` or equivalent, not route-level ambiguity or silent omission.

Manager restart is okay after these contract corrections are incorporated and the focused tests/build still pass. Restart alone is not enough if the contract still returns null display fields or ambiguous ghost-file semantics.

## Current Evidence

- Live manager on `http://127.0.0.1:4100` returns `200` for `/health`.
- Live manager returns `usage-meter-v2` for `/usage`; the response includes daily/weekly usage, gate state, model/agent buckets, and degraded concurrency state.
- Live manager still returns `404 Cannot GET /outputs/inbox`, which matches the B11 report and confirms the running process has not picked up Cane's new backend routes.
- Regina's Kapelle branch has two B11 commits ahead of origin:
  - `2c2fae4` - `Implement Kapelle B11 ops review surface`
  - `6414370` - `Align B11 ops with manager backend`
- Regina's closeout reports focused tests, typecheck, and build passing after the follow-on commit.
- Cane's backend artifact reports new `src/outputs/*` routes/storage/tests, but the live manager needs restart to mount them.

## Feedback Processing

### 1. Executors

Chris is right: no approve/ship executors exist yet.

Architecture decision:

- Keep `approve` as a durable review operation only.
- Keep `ship` blocked until a real executor contract exists.
- Record this as a future build item: **approve/ship executors and destination policy**.

Recommended future executor scope:

- Explicit executor registry.
- Destination policy: where a shipped output can go.
- Operator confirmation for irreversible external effects.
- Idempotency keys for executor actions.
- Audit rows tying ship attempts to artifact id, actor, destination, result, and any promotion/deploy evidence.

### 2. Usage Meter

Chris's "one usage meter/tracking path" feedback should be treated as accepted.

Current source of truth:

- `GET /usage` from the manager is the source of truth.
- It is already implemented and live as `schema_version: "usage-meter-v2"`.
- Kapelle should normalize that response for compact chrome, not create another usage meter, usage table, or duplicate tracking lane.

Prior dispatch coverage:

- Existing usage-meter work already covers the manager route and gate semantics.
- B11 should only consume and display it.
- A new usage dispatch is needed only if Chris wants a different product concept, such as per-artifact cost attribution. That would be a separate feature, not B11 cleanup.

Follow-up question:

- None needed unless Chris wants per-output/per-artifact cost attribution. Otherwise, proceed with `GET /usage` only.

### 3. Output Metadata In Projection

Chris is right that `/outputs/inbox` lacking `title`, `basename`, `agent`, and `produced_at` is important.

Recommendation:

- These fields belong directly in the `/outputs/inbox` projection/read model response.
- The upstream source of truth should remain the artifact catalog or delivery log/Reactor artifact record.
- The UI should not re-join or scrape these fields itself.

Reasoning:

- `/outputs/inbox` is a product read model: it answers "what should Chris review now?"
- That question cannot be answered well with null titles and null producers.
- Keeping the fields only upstream forces every consumer to duplicate joins and fallback logic.
- Duplicated joins are exactly what B11 is trying to remove from Kapelle.

Concrete contract adjustment:

```ts
type OutputInboxItem = {
  artifact_id: string; // stable operation target
  display_id: string | null; // derived/read-model only
  title: string;
  basename: string;
  agent: string;
  produced_at: string | null;
  artifact_status: "available" | "missing" | "too_large" | "unsupported";
  review_status: "unread" | "read" | "approved" | "commented" | "redirected" | "shipped";
  source_link: string | null;
  metadata_source: "artifact_catalog" | "delivery_log" | "reactor" | "fallback";
};
```

RD-001 identity rule:

- `artifact_id` is the stable operation target for output/review operations.
- `display_id`, titles, basenames, list indexes, queue positions, and source file names are presentation metadata only.
- Kapelle may show `display_id` or basename, but approve/read/comment/redirect/ship actions MUST post the stable `artifact_id`.
- The manager MUST reject display-only IDs as artifact operation targets with `400 invalid_artifact_id`.

Implementation guidance:

- Derive `basename`, `agent`, and delivery timestamp from the delivery log when available.
- Prefer a canonical Artifact/Reactor catalog when that lands.
- Use fallback labels such as `Untitled output`, `unknown-agent`, and `produced_at: null` only when the upstream record truly lacks the data.
- Include `metadata_source` or `source_status` so Kapelle can show degraded state without redoing the join.

### 4. No-404 / Ghost File Behavior

Chris is right that explicit no-404 behavior matters because ghost files happen.

Recommendation:

- For known artifact ids with missing backing files, return `200` with `artifact_status: "missing"` and a warning.
- For `/outputs/inbox`, include missing review-worthy artifacts when `include_unavailable=true`, sorted normally, with clear unavailable state.
- For `/artifacts/:id/review`, returning `200 state:null` is acceptable only for "no review row yet"; it must not be the only behavior for a known ghost artifact.

Important distinction:

- Unknown id: can be `404` or `200 state:null`, depending on route contract.
- Known artifact whose file disappeared: should not be invisible and should not look like "never viewed." It needs explicit `missing` state.

This means the manager route needs a source catalog lookup or delivery-log lookup before deciding whether an artifact is unknown versus known-but-missing.

Ghost-file handling still preserves stable identity. A known missing artifact row MUST keep its stable `artifact_id` in every unavailable-state response so future review, repair, or rehydrate operations can target the same record.

### 5. B11 Cleanup Items

Backend cleanup:

- Restart manager only after B11 backend routes are built into the running manager.
- Re-smoke `/outputs/inbox`, `/artifacts/:id/review`, `/artifacts/:id/operations`, `/artifacts/:id/approve`, and `/artifacts/:id/ship`.
- Update `/outputs/inbox` to populate display metadata from upstream source rows.
- Add explicit ghost-file tests.
- Align route/status vocabulary with Kapelle: current Cane backend uses `never_viewed/viewed`; Kapelle/B11 docs use `unread/read`. Pick one public vocabulary and normalize at the manager boundary.
- Keep ship blocker vocabulary stable, but consider mapping `no_executor_configured` to the earlier `executor_unavailable` product blocker if Kapelle already expects that.
- Fix the noted `dispatch-scheduler-talk-issuer-guard` allowlist line-number test drift as a separate cleanup, not mixed with B11 semantics.

Frontend cleanup:

- Rename the surface from `Outputs Inbox` to **Agent output**.
- Combine `Check fleet health` and `Agent review` into **Fleet status & output**.
- Keep buttons smaller and action-like; avoid large repeated CTA buttons on dense ops surfaces.
- Use floating windows/modals for focused actions instead of pushing the console layout around.
- Artifact viewing should default to a large floating window over the console, with a route/detail page still available as a durable deep link.
- Keep `ship` visible as future end-product affordance, but blocked and plainly non-executing until backend executors exist.

### 6. Browser Connector / Verification

Finding:

- Regina twice reported the in-app Browser backend as unavailable: `iab unavailable`.
- I reproduced the same issue in this session by bootstrapping the Browser plugin and calling `agent.browsers.get("iab")`; it failed with `Browser is not available: iab`.
- The Browser plugin files exist locally, including `scripts/browser-client.mjs`, so this is not a missing plugin file. It is a backend registration/session exposure problem for the `iab` browser.
- `agent-browser` is not currently on PATH.
- `/opt/homebrew/bin/playwright` is installed and works; Regina already used Playwright screenshots successfully for B10 smoke artifacts.

Standard fallback:

1. Try in-app Browser `iab` when available.
2. If `iab` is unavailable, use `agent-browser` if installed.
3. If `agent-browser` is unavailable, use `/opt/homebrew/bin/playwright` or `npx playwright` with authenticated storage state.
4. Always record the fallback in the closeout artifact and include screenshot paths when visual QA matters.

Recommended fix:

- Repair Browser backend registration so `iab` is exposed to agent sessions.
- Install or expose `agent-browser` on PATH as the documented CLI fallback.
- Keep Playwright CLI as the baseline fallback until the connector issue is fixed.

## Follow-Up Questions

Only one question is worth asking if Chris wants a product decision:

- Should the public review-status vocabulary be `unread/read` or `never_viewed/viewed`? Recommendation: use `unread/read` in `/outputs/inbox` because it matches the operator UX, and keep any lower-level storage terms private.

No clarification is needed for usage, executors, ghost-file behavior, or metadata placement.

## Recommended Next Dispatches

1. **Cane/backend cleanup:** finish `/outputs/inbox` metadata joins, no-404 ghost-file behavior, vocabulary alignment, and route smoke after manager restart.
2. **Regina/frontend cleanup:** rename/reframe UX labels, use floating artifact viewer/action windows, keep approve/ship affordances aligned with backend blockers.
3. **Ops/tooling cleanup:** restore `iab` browser backend availability or install `agent-browser` CLI; document Playwright fallback in agent verification standards.

## Acceptance Bar After Restart

B11 is green only when:

- `/outputs/inbox` returns `200` from live manager.
- Inbox items include non-null display metadata wherever upstream artifact data exists.
- Known missing artifacts render as explicit unavailable rows, not silent omissions.
- `/usage` remains the only usage source.
- Ship returns explicit executor blockers.
- Kapelle consumes manager-backed output/review routes and clearly labels fallback state.
- Browser or Playwright visual smoke covers `/ops`, the agent output surface, and artifact floating/detail view.
- RD-001 is enforced for output review: artifact operations use stable `artifact_id`; display IDs, queue positions, and filenames are rejected as mutation targets.
