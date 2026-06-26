# Canonical Artifact Read-Model Contract

> Refactor plan W3-11. This is the implementation-ready contract for the 2026-06-14 Kapelle dashboard outage class: Desk 404 plus "No renderable body" from bodyless manager-catalog rows winning over local file rows.

**Date:** 2026-06-15  
**Project:** Kapelle  
**Scope:** `id-agents` manager read model plus `kapelle-site` ops adapters  
**Primary goal:** Make the manager the only product source of artifact truth. Kapelle consumes a stable manager-owned `ArtifactReadModel`; local filesystem scanning remains available only as a labeled diagnostic/fallback path.

## Scope Decision

**Approved scope.** This plan is the right W3-11 boundary and should not be bounced.

The outage root cause is already validated by both architecture reviews and by the 2026-06-14 incident: the same artifact exists as multiple rows with incompatible IDs and incomplete data. The fix is not another app-layer join. The fix is one manager-owned read model with one stable ID scheme, one availability model, one provenance model, and one review/operation surface.

**In scope:**

- Define canonical `ArtifactReadModel` v1 in `id-agents`.
- Make manager `/artifacts`, `/artifacts/:id`, `/outputs/inbox`, `/artifacts/:id/review`, and artifact operation routes serve the same canonical ID and row shape.
- Move product artifact list/detail reads in `kapelle-site` to the manager contract.
- Demote `kapelle-site` local delivery-log/output-root scanning to a visible diagnostic/fallback surface.
- Add a shared cross-repo fixture pack consumed by both manager route tests and Kapelle adapter tests.
- Migrate without breaking `/ops` list, detail, outputs inbox, review, approve, and ship flows.

**Out of scope:**

- Building executors for `ship`.
- Full team isolation for output review tables. This plan must leave explicit extension points for `team_id`, but the separate Axis E dispatch owns multi-team enforcement.
- Replacing all task/dispatch/dashboard read models. This plan only fixes artifact ownership.

## Existing Problem

There are currently three competing artifact projections:

1. `kapelle-site/app/ops/_lib/artifactAdapter.ts`
   - Scans local `output/` roots.
   - Parses `cane/taskview/delivery-log.md`.
   - Reads artifact bodies from disk during list/detail normalization.
   - Uses a base64url absolute-path ID.

2. `id-agents/src/dispatch-scheduler/read-model.ts`
   - Synthesizes `/artifacts` from `dispatch_scheduler_queue.result_json`, `queries.result`, and `agents.working_directory/output`.
   - Uses IDs such as `dispatch:<dispatch_phid>`, `query:<query_id>:<basename>`, and `output:<agent_id>:<basename>`.
   - Can return rows without renderable body fields.

3. `id-agents/src/outputs/storage.ts`
   - Owns catalog/review/operation tables.
   - Uses `artifactIdFromPath(absPath)` returning `art-<sha256(abs_path).slice(0,16)>`.
   - `/outputs/inbox` is anchored on `artifact_review_state`, so catalog-only rows can be invisible.

These projections do not reconcile. Review state can attach to one ID while the UI opens another. Manager-only rows can outrank local rows but lack hydrated renderable content. Local fallback joins by basename/path can silently pick the wrong producer.

## Canonical Contract

### Ownership

`id-agents` owns `ArtifactReadModel` v1. Kapelle treats it as a remote contract, not as an implementation detail.

The manager is responsible for:

- ID assignment.
- Artifact metadata.
- Availability and body status.
- Provenance links to agent, task, dispatch, and query.
- Review state.
- Operation history.
- Registration and backfill.
- Detail body hydration when allowed.

Kapelle is responsible for:

- Rendering canonical rows.
- Calling canonical review/operation routes.
- Showing explicit degraded/fallback state.
- Running local filesystem diagnostics only when the manager route is unavailable or an operator opens a diagnostic panel.

### Stable ID Scheme

Use one artifact ID everywhere:

```ts
type ArtifactId = `art-${string}`;
```

ID derivation for v1:

```ts
artifact_id = "art-" + sha256(normalized_abs_path).hex.slice(0, 16)
```

Store this location key alongside the ID:

```text
file:<normalized_abs_path>
```

Normalization rules:

- Resolve `.` and `..`.
- Preserve case.
- Use absolute paths.
- Do not include file mtime, size, title, task, dispatch, or basename.
- Do not derive IDs from manager query ID, dispatch ID, base64 path IDs, or output basename.

Rationale: the current `outputs/storage.ts` path hash is the least disruptive canonical ID because review operations already use artifact IDs and it converges all writers that know the absolute path. The prefixed `normalized_location_key` is stored for future non-file artifact types, but it is not part of the v1 hash. Dispatch/query IDs remain provenance fields, not primary identity.

Future extension:

```text
blob:<sha256_bytes>
doc:<external_system>:<external_id>
url:<normalized_url>
```

Do not implement future keys in this dispatch. Add the enum/type shape so the extension does not require changing route semantics.

### Canonical DTO

Add a shared manager type in `id-agents/src/artifacts/read-model-types.ts`:

```ts
export type ArtifactReadModelSchemaVersion = "artifact.read-model.v1";

export type ArtifactAvailability =
  | "present"
  | "missing"
  | "blocked"
  | "unsupported"
  | "too_large"
  | "unknown";

export type ArtifactBodyStatus =
  | "renderable"
  | "not_loaded"
  | "missing"
  | "blocked"
  | "unsupported"
  | "too_large";

export type ArtifactReviewStatus =
  | "never_viewed"
  | "viewed"
  | "approved"
  | "shipped"
  | "ship_blocked";

export interface ArtifactReadModel {
  schema_version: ArtifactReadModelSchemaVersion;
  artifact_id: string;
  stable_id: string;
  title: string;
  basename: string;
  media_type: "text/markdown" | "text/plain" | "unknown";
  location: {
    kind: "file";
    abs_path: string;
    normalized_key: string;
    is_private_path: boolean;
  };
  availability: ArtifactAvailability;
  body: {
    status: ArtifactBodyStatus;
    markdown: string | null;
    preview: string | null;
    truncated: boolean;
    size_bytes: number | null;
    max_body_bytes: number;
    error: string | null;
  };
  provenance: {
    source: "agent-done" | "delivery-log" | "dispatch-result" | "query-result" | "output-scan" | "manual";
    agent_id: string | null;
    agent_name: string | null;
    task_id: string | null;
    task_name: string | null;
    dispatch_id: string | null;
    query_id: string | null;
    manager_query_id: string | null;
    source_link: string | null;
  };
  review: {
    status: ArtifactReviewStatus;
    first_viewed_at: string | null;
    last_viewed_at: string | null;
    viewed_by_last: string | null;
    viewed_count: number;
    approved_at: string | null;
    approved_by: string | null;
    approval_note: string | null;
    shipped_at: string | null;
    shipped_by: string | null;
    ship_blockers: string[];
  };
  operations: {
    count: number;
    last_op_at: string | null;
  };
  timestamps: {
    produced_at: string;
    modified_at: string | null;
    created_at: string;
    updated_at: string;
  };
  diagnostics: {
    legacy_ids: string[];
    warnings: string[];
  };
}
```

Required route response wrappers:

```ts
export interface ArtifactListResponse {
  schema_version: "artifact.list.v1";
  generated_at: string;
  items: ArtifactReadModel[];
  artifacts: ArtifactReadModel[]; // compatibility alias during migration
  limit: number;
  offset: number;
  count: number;
  source_metadata: {
    canonical: true;
    source: "manager-artifacts-catalog";
    fallback_used: false;
  };
}

export interface ArtifactDetailResponse {
  schema_version: "artifact.detail.v1";
  generated_at: string;
  artifact: ArtifactReadModel | null;
}
```

Compatibility aliases are allowed for one migration window:

- `id` equals `artifact_id`.
- `path` equals `location.abs_path`.
- `agent` equals `provenance.agent_name ?? provenance.agent_id`.
- `status` maps from `availability`.
- `tl_dr` equals `title`.

Kapelle may read aliases during migration but must store/render the canonical fields.

### Storage Model

Extend the existing `outputs/storage.ts` tables rather than introducing a second catalog.

`artifacts` becomes the canonical catalog table:

```sql
artifact_id TEXT PRIMARY KEY
team_id TEXT NULL
basename TEXT NOT NULL
agent TEXT NOT NULL
agent_id TEXT NULL
tag TEXT NULL
abs_path TEXT NOT NULL
normalized_location_key TEXT NOT NULL
title TEXT
media_type TEXT NOT NULL DEFAULT 'unknown'
produced_at TEXT NOT NULL
modified_at TEXT NULL
size_bytes INTEGER NULL
source TEXT NOT NULL
source_link TEXT NULL
task_id TEXT NULL
task_name TEXT NULL
dispatch_id TEXT NULL
query_id TEXT NULL
manager_query_id TEXT NULL
availability TEXT NOT NULL DEFAULT 'unknown'
body_status TEXT NOT NULL DEFAULT 'not_loaded'
body_preview TEXT NULL
body_error TEXT NULL
legacy_ids_json TEXT NOT NULL DEFAULT '[]'
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

Indexes:

- `artifacts(normalized_location_key)` unique.
- `artifacts(team_id, produced_at DESC)` when `team_id` lands.
- `artifacts(dispatch_id)`.
- `artifacts(query_id)`.
- `artifacts(agent, produced_at DESC)`.
- `artifacts(basename)`.

`artifact_review_state` remains one row per `artifact_id`. It should not create product list rows by itself. Orphan review rows are diagnostic rows only and must not outrank catalog rows.

`artifact_operations` remains append-only and always uses canonical `artifact_id`.

### Availability and Body Rules

List routes may include body previews but must not require full body reads. Detail routes may load full body up to `max_body_bytes`.

Rules:

- `availability=present` means the manager verified the location exists at read time or registration time.
- `availability=missing` means a catalog row exists but the backing location does not.
- `availability=blocked` means the path is outside allowed artifact roots.
- `availability=unsupported` means the file type is not renderable as text.
- `availability=too_large` means the body exceeds `max_body_bytes`; preview may be present.
- `availability=unknown` is allowed only during migration or for orphan review rows.

Body status:

- `renderable`: `body.markdown` is non-null and safe to render.
- `not_loaded`: list route did not hydrate the full body.
- `missing`, `blocked`, `unsupported`, `too_large`: match the availability reason.

The UI must never infer renderability from ID shape, basename, or provenance. It must use `body.status`.

### Provenance Rules

Every canonical artifact row must carry as many of these fields as the writer knows:

- `agent_id`
- `agent_name`
- `task_id`
- `task_name`
- `dispatch_id`
- `query_id`
- `manager_query_id`
- `source_link`

Writers must not encode provenance into `artifact_id`.

Merge precedence for duplicate writes to the same `normalized_location_key`:

1. Preserve `artifact_id`, `normalized_location_key`, and earliest `produced_at`.
2. Prefer non-null `dispatch_id`, `query_id`, `manager_query_id`, `task_id`, and `task_name`.
3. Prefer a non-empty `title` from `agent-done` or `delivery-log` over a generated basename title.
4. Update `availability`, `modified_at`, `size_bytes`, `body_status`, and `body_preview` from the newest filesystem check.
5. Append legacy IDs to `legacy_ids_json` without duplicates.

### Operations

Canonical operations:

- `POST /artifacts/register`
- `GET /artifacts`
- `GET /artifacts/:id`
- `GET /outputs/inbox`
- `GET /artifacts/:id/review`
- `POST /artifacts/:id/view`
- `GET /artifacts/:id/operations`
- `POST /artifacts/:id/approve`
- `POST /artifacts/:id/ship`
- `POST /artifacts/catalog/backfill`

All operation routes take canonical `artifact_id`. During migration, read/detail routes may resolve legacy IDs through `legacy_ids_json`, but mutations must respond with the canonical ID and include a warning:

```json
{
  "warning": "legacy_artifact_id_resolved",
  "artifact_id": "art-..."
}
```

## Manager Implementation Plan

### Files

Create:

- `src/artifacts/read-model-types.ts`
- `src/artifacts/id.ts`
- `src/artifacts/mapper.ts`
- `src/artifacts/routes.ts`
- `tests/fixtures/artifact-read-model/v1/`
- `tests/unit/artifact-read-model-id.test.ts`
- `tests/unit/artifact-read-model-mapper.test.ts`
- `tests/integration/artifact-read-model-routes.test.ts`

Modify:

- `src/outputs/storage.ts`
- `src/outputs/types.ts`
- `src/outputs/routes.ts`
- `src/dispatch-scheduler/read-model.ts`
- `src/agent-manager-db.ts`
- `tests/unit/outputs-storage-ops.test.ts`
- `tests/integration/manager-dispatch-read-routes.test.ts`

### Route Behavior

`GET /artifacts`

- Reads from canonical `artifacts` table.
- Left joins review state and grouped operation aggregates.
- Returns `ArtifactListResponse`.
- Supports `limit`, `offset`, `agent`, `status`, `availability`, `dispatch_id`, `query_id`.
- Does not scan `agents.working_directory/output` on the product path.

`GET /artifacts/:id`

- Resolves canonical ID first.
- Resolves legacy aliases only during migration.
- Hydrates body from the allowlisted file path.
- Returns `ArtifactDetailResponse`.
- Returns 404 only when neither canonical ID nor legacy alias resolves.

`GET /outputs/inbox`

- Drives from `artifacts` when `includeNeverViewed=true`.
- Left joins `artifact_review_state`.
- Left joins grouped operation aggregates.
- Returns the same canonical ID and enough canonical fields for Kapelle to build output review lanes without rejoining `/artifacts`.

`POST /artifacts/register`

- Computes canonical ID from normalized file path if omitted.
- Upserts by `normalized_location_key`, not just `artifact_id`.
- Records legacy source IDs when supplied.
- Updates availability/body preview from a filesystem stat/read when the path is allowed.

`POST /artifacts/catalog/backfill`

- Uses the same quote-aware delivery-log parser as Kapelle's current parser.
- Registers rows through the same canonical upsert path.
- Does not create review state rows.

### Retire Synthetic `/artifacts`

Keep `readDispatchResultArtifacts`, `readQueryResultArtifacts`, and `readAgentOutputArtifacts` only as backfill/diagnostic helpers.

New behavior:

- Dispatch result artifact path registration writes to `artifacts`.
- Query result output path extraction writes to `artifacts`.
- Agent output directory scan is an explicit admin backfill or diagnostic, not the default `/artifacts` list implementation.

`source_metadata.sources` for product `/artifacts` becomes:

```json
["manager-artifacts-catalog"]
```

Diagnostic route, if retained:

```text
GET /artifacts/diagnostics/local-scan
```

It must return `source_metadata.canonical=false` and `fallback_used=true`.

## Kapelle Implementation Plan

### Files

Modify:

- `kapelle-site/app/ops/_lib/types.ts`
- `kapelle-site/app/ops/_lib/provenanceAdapter.ts`
- `kapelle-site/app/ops/_lib/artifactAdapter.ts`
- `kapelle-site/app/ops/_lib/artifactDetailAdapter.ts`
- `kapelle-site/app/ops/_lib/outputsInboxAdapter.ts`
- `kapelle-site/app/ops/_lib/summaryAdapter.ts`
- `kapelle-site/tests/ops-artifact-adapter.test.ts`
- `kapelle-site/tests/ops-outputs-inbox-adapter.test.ts`
- `kapelle-site/tests/ops-provenance-adapter.test.ts`

Create:

- `kapelle-site/app/ops/_lib/artifactReadModelAdapter.ts`
- `kapelle-site/tests/fixtures/artifact-read-model/v1/README.md` as a symlink or copied fixture mirror from `id-agents`.

### Product Path

Kapelle product reads use manager routes in this order:

1. `GET /artifacts` for list/summary/provenance artifact rows.
2. `GET /artifacts/:id` for detail, including renderable body.
3. `GET /outputs/inbox` for review lanes.
4. Operation routes for view/approve/ship.

Kapelle must stop using local filesystem rows as the first source for artifact list/detail pages. The local adapter remains available as:

- fallback when manager `/artifacts` is unavailable, labeled `projection: "local-filesystem-fallback"`;
- diagnostics in provenance/health, labeled `source_detail: "local delivery-log/output-root diagnostic"`;
- a temporary body-hydration fallback only when `GET /artifacts/:id` returns a canonical row with `body.status="not_loaded"` during migration.

### UI Semantics

Kapelle displays:

- Canonical ID in links.
- `body.status` driven render state.
- `availability` warnings when not `present`.
- `diagnostics.legacy_ids` only in debug/provenance panels.
- A visible degraded banner when local fallback is active.

Kapelle must not:

- Generate product artifact IDs from local absolute paths.
- Merge manager rows and local rows by basename as the default path.
- Prefer a manager row with `body.status!="renderable"` over a renderable canonical detail response.
- Hide `availability=unknown`.

## Cross-Repo Fixture Pack

Create the same fixture pack in `id-agents/tests/fixtures/artifact-read-model/v1/` and make `kapelle-site` consume it by path or mirrored copy.

Files:

```text
tests/fixtures/artifact-read-model/v1/
  README.md
  artifact-list.json
  artifact-detail-renderable.json
  artifact-detail-missing.json
  outputs-inbox.json
  operations.json
  delivery-log.txt
  legacy-id-map.json
```

Fixture cases:

1. Renderable artifact
   - `artifact_id=art-78f6ecaee54d6eff` for `$FIXTURE_ROOT/output/renderable.md`
   - markdown body present on detail.
   - provenance includes `agent_name=cto`, `task_name=spec-artifact-read-model-contract`, `dispatch_id=phid:disp-acc5a9e55f4fa945`, and query ID.

2. Catalog-only never-viewed artifact
   - Exists in `artifacts`.
   - No review state row.
   - Appears in `/outputs/inbox` as `review.status=never_viewed`.

3. Missing artifact
   - Catalog row exists.
   - `availability=missing`.
   - `body.status=missing`.
   - Detail renders a clear unavailable state.

4. Legacy alias artifact
   - `legacy_ids` include `dispatch:phid:...`, `query:<qid>:<basename>`, `output:<agent>:<basename>`, and `local-base64:<...>`.
   - Detail lookup by legacy ID resolves to canonical ID during migration.

5. Delivery-log row with quoted pipe
   - `tl_dr` contains `A | B`.
   - Manager parser preserves the full title.
   - Kapelle parser fixture expects the same title.

Fixture requirements:

- Fixtures must be valid JSON and checked by tests.
- Tests must assert exact canonical IDs, not just shape.
- Fixture timestamps are fixed ISO strings.
- No absolute local machine path is used except within an explicit fixture temp root token such as `$FIXTURE_ROOT/output/renderable.md`.

## TDD Acceptance

Implement in this order.

### Red Tests First

`id-agents`:

- `artifactIdFromLocationKey()` normalizes path keys and returns the expected `art-...` fixture ID.
- Registering the same abs path from dispatch, query, and delivery-log writers produces one artifact row.
- `/artifacts` returns canonical table rows and does not include synthetic `dispatch:`/`query:`/`output:` IDs.
- Catalog-only artifact appears in `/outputs/inbox` as `never_viewed`.
- `/outputs/inbox` uses grouped operation counts, not per-row operation queries.
- `/artifacts/:id` hydrates markdown body for an allowed text file.
- `/artifacts/:legacyId` resolves to canonical ID during migration.
- Delivery-log parser preserves quoted pipes.
- Missing file returns `availability=missing` and `body.status=missing`.

`kapelle-site`:

- Artifact list adapter maps fixture `ArtifactReadModel` rows to `OpsArtifact` without local scan.
- Artifact detail adapter renders fixture detail body from manager response.
- Outputs inbox adapter preserves canonical artifact IDs in `detail_href`.
- Manager unavailable path returns degraded `local-filesystem-fallback` with visible warning metadata.
- Legacy base64 local ID is not emitted for manager-backed rows.
- Bodyless manager list rows do not produce "No renderable body" on detail; detail route is called.

### Verification Commands

Manager:

```bash
cd /Users/kilgore/Dropbox/Code/cane/id-agents
npx vitest run \
  tests/unit/artifact-read-model-id.test.ts \
  tests/unit/artifact-read-model-mapper.test.ts \
  tests/unit/outputs-storage-ops.test.ts \
  tests/integration/artifact-read-model-routes.test.ts \
  tests/integration/manager-dispatch-read-routes.test.ts
```

Kapelle:

```bash
cd /Users/kilgore/Dropbox/Code/kapelle-site
npm test -- \
  tests/ops-artifact-adapter.test.ts \
  tests/ops-outputs-inbox-adapter.test.ts \
  tests/ops-provenance-adapter.test.ts
```

Manual smoke:

```bash
curl -sS "$MANAGER_URL/artifacts?limit=5" | jq '.schema_version,.items[0].artifact_id,.items[0].body.status'
curl -sS "$MANAGER_URL/outputs/inbox?limit=5" | jq '.items[].artifact_id'
```

Open `/ops/artifacts/<canonical-id>` and confirm:

- detail page loads from manager;
- markdown body renders;
- view operation records against the same canonical ID;
- approve operation records against the same canonical ID;
- no local base64 ID appears in the product URL.

## Migration Path

### Phase 0: Contract and Fixtures

- Add this plan.
- Add type definitions and fixture pack.
- Add failing cross-repo tests.
- No production behavior changes.

### Phase 1: Manager Canonical Read Model

- Extend `artifacts` table.
- Add mapper from catalog/review/ops rows to `ArtifactReadModel`.
- Change `/outputs/inbox` to drive from `artifacts` when `includeNeverViewed=true`.
- Add `GET /artifacts/:id`.
- Keep old `/artifacts` response aliases while returning canonical fields.

`/ops` remains working because aliases preserve `id`, `path`, `agent`, `status`, and `tl_dr`.

### Phase 2: Registration Convergence

- Route dispatch result artifacts, query result artifacts, delivery-log backfill, and manual registration through the same canonical upsert.
- Store legacy IDs for all old sources.
- Keep synthetic readers available only for diagnostic backfill.

`/ops` remains working because old IDs resolve through legacy alias lookup.

### Phase 3: Kapelle Product Cutover

- Add `artifactReadModelAdapter`.
- Make artifact list/detail use manager read-model routes first.
- Keep `readOpsArtifacts()` as fallback only.
- Add visible fallback/degraded metadata to summary/provenance.

`/ops` remains working because manager routes are primary and local fallback is still available during manager outages.

### Phase 4: Remove Product Dependence on Local Scan

- Stop passing local artifacts into manager artifact enrichment on normal dashboard load.
- Move local scan counts to provenance diagnostics.
- Remove basename-based manager/local merge from the product path.
- Keep diagnostic route and tests for one release window.

### Phase 5: Enforce Canonical IDs

- Mutations reject unknown legacy IDs after migration telemetry shows no product calls using them.
- Keep read-only legacy resolution for archived links.
- Document canonical artifact links as `/ops/artifacts/<artifact_id>`.

## Rollback

Rollback must not delete catalog or review rows.

Safe rollback steps:

1. Flip Kapelle back to local fallback by feature flag:

   ```text
   KAPELLE_ARTIFACT_READ_MODEL=local-fallback
   ```

2. Keep manager registration writes enabled. They are additive.
3. Disable only the new `/artifacts/:id` detail route if needed.
4. Do not change `artifact_id` once written.

## Completion Criteria

This dispatch is complete when:

- One canonical manager-owned `ArtifactReadModel` is documented and implemented.
- `/artifacts`, `/artifacts/:id`, `/outputs/inbox`, and review/operation routes agree on the same `artifact_id`.
- Catalog-only artifacts appear in `/outputs/inbox`.
- Kapelle product artifact list/detail no longer depends on local filesystem scanning.
- Local scanning is visibly labeled as diagnostic/fallback.
- Shared fixtures are consumed by both repos.
- The verification commands pass.
- `/ops` list, detail, view, approve, and outputs inbox flows work throughout the migration.
