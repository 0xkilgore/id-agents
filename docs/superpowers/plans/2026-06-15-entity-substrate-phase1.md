# Kapelle Entity Substrate Phase 1 TDD Plan

Date: 2026-06-15
Owner: cto
Build owner: Roger
Source spec: `cto/output/2026-06-15-kapelle-entity-docmodel-contract-spec.md`
Scope class: Class B W3-11, Phase 1

## Goal

Build the PHID-first entity doc-model substrate for the work-axis entities:

- `Goal`
- `Track`
- `Task`
- `Idea`

This phase extends the existing `@kilgore/task` package shape rather than creating a parallel task store. `Goal`, `Track`, and `Idea` are new sibling document-model packages. All four entities emit canonical state from typed operations, keep forward association edges inline in `links[]`, and feed a processor-built `entity_edge` projection.

Phase 1 is complete when tests prove:

- entity identity is PHID-first;
- reducer state is produced only by typed ops;
- `Task.track_phid` is nullable and moveable;
- `Track.advances[]` stores forward association edges to `Goal`;
- `Idea.PROMOTE_IDEA` records promotion lineage;
- `links[]` forward edges project into `entity_edge`;
- legacy Task fields and task processor behavior still work.

## Existing References

Use these files as the implementation baseline:

- `agent-platform-task-package-v0/task-package/document-models/task/v1/actions.ts`
- `agent-platform-task-package-v0/task-package/document-models/task/v1/schema.graphql`
- `agent-platform-task-package-v0/task-package/document-models/task/v1/utils.ts`
- `agent-platform-task-package-v0/task-package/document-models/task/v1/src/reducers/task-operations.ts`
- `agent-platform-task-package-v0/task-package/document-models/task/v1/src/tests/*.test.ts`
- `agent-platform-task-package-v0/task-package/processors/tasks-index/schema.ts`
- `agent-platform-task-package-v0/task-package/processors/tasks-index/index.ts`
- `cane/id-agents/src/recurrences/types.ts`
- `cane/id-agents/src/recurrences/reducer.ts`
- `cane/id-agents/src/recurrences/materialization.ts`

The recurrence reference is the model for typed operation unions, pure reducer behavior, idempotency, changed-row output, and read DTO discipline. The existing Task package is the model for Powerhouse package layout, action factories, GraphQL operation inputs, reducer tests, processor indexes, and subgraph wiring.

## Non-Goals

- Do not implement `Project`, `Dispatch`, `Artifact`, `Corpus`, or `Entry` doc-model packages in Phase 1.
- Do not introduce a separate `RelationshipEdge` doc-model.
- Do not make markdown canonical state.
- Do not replace the existing Task processor queries during this phase.
- Do not add cycle detection to Task dependencies in reducers; keep graph validation in processors.

## Package Layout

Create or extend these package surfaces under the same package family as `@kilgore/task`:

```text
task-package/
  document-models/
    task/v1/
    goal/v1/
    track/v1/
    idea/v1/
  processors/
    tasks-index/
    entity-index/
  subgraphs/
    tasks/
    entities/
  entity-relations/
```

`entity-relations/` is a shared internal module exported by the package. It owns relationship strings, DTOs, validation helpers, edge projection helpers, and PHID helpers. Do not duplicate relationship string unions inside individual document models.

## Shared Types

Add `entity-relations/types.ts` with these exact exported types:

```ts
export type KapelleEntityType =
  | "Project"
  | "Goal"
  | "Track"
  | "Task"
  | "Idea"
  | "Dispatch"
  | "Artifact"
  | "Corpus"
  | "Entry";

export type AssociationRel =
  | "advances"
  | "depends_on"
  | "blocks"
  | "links_to"
  | "promoted_to"
  | "originated_from"
  | "executes"
  | "produced_by"
  | "satisfies"
  | "references";

export type ContainmentRel =
  | "project"
  | "track"
  | "task"
  | "dispatch"
  | "corpus";

export type ActorRef = {
  type: "human" | "agent" | "manager" | "system";
  id: string;
  display_name?: string | null;
};

export type AssociationEdge = {
  rel: AssociationRel;
  target_phid: string;
  target_type?: KapelleEntityType | null;
  edge_phid?: string | null;
  created_at: string;
  created_by: ActorRef;
  metadata?: Record<string, unknown>;
};

export type EntitySummaryRow = {
  phid: string;
  type: KapelleEntityType;
  project_phid: string | null;
  title: string;
  display_id: string | null;
  status: string;
  parent_phid: string | null;
  parent_rel: ContainmentRel | null;
  created_at: string;
  updated_at: string;
};

export type EntityEdgeRow = {
  edge_id: string;
  source_phid: string;
  source_type: KapelleEntityType;
  rel: AssociationRel;
  target_phid: string;
  target_type: KapelleEntityType | null;
  created_at: string;
  created_by_json: string;
  metadata_json: string | null;
};
```

Add `entity-relations/registry.ts` with:

- `ASSOCIATION_RELS`
- `CONTAINMENT_RELS`
- `isAssociationRel(value: string): value is AssociationRel`
- `isContainmentRel(value: string): value is ContainmentRel`
- `assertAssociationRel(value: string): AssociationRel`
- `assertContainmentRel(value: string): ContainmentRel`
- `assertPhid(value: string, expectedPrefix?: string): string`
- `makeEdgeId(sourcePhid, rel, targetPhid, edgePhid?)`
- `projectEntityEdges(source)`

`makeEdgeId` must be deterministic. Use `edge_phid` when supplied; otherwise derive from `source_phid|rel|target_phid`. This makes replay and processor rebuilds idempotent.

## TDD Sequence

Roger should implement in this order. Each step starts with failing tests committed or run locally before implementation.

### 1. Shared Registry Tests

Add tests:

- `entity-relations/src/tests/registry.test.ts`
- `entity-relations/src/tests/project-edges.test.ts`

Red tests:

- all allowed association rels validate;
- unknown association rel rejects with an error naming the bad relation;
- all allowed containment rels validate;
- unknown containment rel rejects;
- `assertPhid("task-1")` rejects;
- `assertPhid("phid:task:abc", "task")` passes;
- `assertPhid("phid:goal:abc", "task")` rejects;
- `makeEdgeId` returns the explicit `edge_phid` when present;
- `makeEdgeId` is stable across repeated calls for the same source, relation, and target;
- `projectEntityEdges` emits one `EntityEdgeRow` per `links[]` item and serializes actor/metadata JSON deterministically;
- duplicate forward links collapse to one projected row by `edge_id`.

Green implementation:

- add shared type and registry modules;
- export them from package barrels;
- keep helpers dependency-light and synchronous, matching reducer constraints.

### 2. Goal Doc-Model

Create:

```text
document-models/goal/v1/actions.ts
document-models/goal/v1/index.ts
document-models/goal/v1/module.ts
document-models/goal/v1/schema.graphql
document-models/goal/v1/utils.ts
document-models/goal/v1/src/reducers/goal-operations.ts
document-models/goal/v1/src/tests/create-goal.test.ts
document-models/goal/v1/src/tests/update-goal.test.ts
document-models/goal/v1/src/tests/status-goal.test.ts
document-models/goal/v1/src/tests/link-track-goal.test.ts
```

Goal state:

```ts
type GoalStatus = "OPEN" | "ACHIEVED" | "MISSED" | "ARCHIVED";

type GoalState = {
  phid: string;
  goal_phid: string;
  type: "Goal";
  schema_version: 1;
  project_phid: string;
  title: string;
  body_markdown: string;
  display_id: string | null;
  status: GoalStatus;
  links: AssociationEdge[];
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  archived_at: string | null;
};
```

Ops:

- `CREATE_GOAL`
- `UPDATE_GOAL_TITLE`
- `UPDATE_GOAL_BODY`
- `SET_GOAL_STATUS`
- `LINK_TRACK`
- `UNLINK_TRACK`
- `ARCHIVE_GOAL`

Reducer tests:

- `CREATE_GOAL` requires `phid:goal:*`, `project_phid`, non-empty title, UTC `ts`, and actor ref;
- `CREATE_GOAL` sets `phid` and compatibility alias `goal_phid` to the same value;
- title/body updates reject from `ARCHIVED`;
- same-value title/body/status updates collapse to no-op and do not churn `updated_at`;
- `SET_GOAL_STATUS` allows only `OPEN`, `ACHIEVED`, `MISSED`, `ARCHIVED`;
- `ARCHIVE_GOAL` sets status `ARCHIVED`, `archived_at`, `updated_at`, and `updated_by`;
- `LINK_TRACK` stores an association edge with `rel: "advances"`, `target_type: "Track"`, and target `phid:track:*` only if this convenience op is used;
- `UNLINK_TRACK` removes only the matching track edge and is idempotent.

Important implementation note: canonical `advances` storage belongs on `Track`. `LINK_TRACK` exists only as a convenience action for callers that start from a Goal view. Its reducer must either reject with a clear message requiring Track mutation or write a reversible local mirror marked `metadata: { mirror: true }`. Prefer rejection unless the existing Powerhouse action pipeline can atomically write both documents.

### 3. Track Doc-Model

Create:

```text
document-models/track/v1/actions.ts
document-models/track/v1/index.ts
document-models/track/v1/module.ts
document-models/track/v1/schema.graphql
document-models/track/v1/utils.ts
document-models/track/v1/src/reducers/track-operations.ts
document-models/track/v1/src/tests/create-track.test.ts
document-models/track/v1/src/tests/status-track.test.ts
document-models/track/v1/src/tests/dod-track.test.ts
document-models/track/v1/src/tests/advances-goal.test.ts
```

Track state:

```ts
type TrackStatus = "OPEN" | "ACTIVE" | "DONE" | "ARCHIVED";

type TrackState = {
  phid: string;
  track_phid: string;
  type: "Track";
  schema_version: 1;
  project_phid: string;
  title: string;
  body_markdown: string;
  definition_of_done: string | null;
  display_id: string | null;
  status: TrackStatus;
  advances: AssociationEdge[];
  links: AssociationEdge[];
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  completed_at: string | null;
  archived_at: string | null;
};
```

Ops:

- `CREATE_TRACK`
- `UPDATE_TRACK_TITLE`
- `UPDATE_TRACK_BODY`
- `SET_TRACK_STATUS`
- `SET_DEFINITION_OF_DONE`
- `LINK_GOAL`
- `UNLINK_GOAL`
- `COMPLETE_TRACK`
- `REOPEN_TRACK`
- `ARCHIVE_TRACK`

Reducer tests:

- `CREATE_TRACK` requires `phid:track:*`, `project_phid`, non-empty title, UTC `ts`, and actor ref;
- `CREATE_TRACK` accepts `initial_goal_phids` and stores each as a forward `advances` edge to `Goal`;
- `LINK_GOAL` requires `phid:goal:*`;
- `LINK_GOAL` appends exactly one `rel: "advances"` edge per goal PHID and dedupes repeated links;
- `UNLINK_GOAL` removes only the requested `advances` edge and is idempotent;
- `links[]` includes all `advances[]` edges or `advances` is the typed view over `links[]`; choose one internal representation and test that the public state exposes both without divergence;
- `SET_DEFINITION_OF_DONE` writes nullable text and rejects from `ARCHIVED`;
- `COMPLETE_TRACK` requires non-empty `definition_of_done`, sets `DONE`, and records `completed_at`;
- `REOPEN_TRACK` changes `DONE` back to `ACTIVE` and clears `completed_at`;
- `ARCHIVE_TRACK` rejects further mutating ops except idempotent `ARCHIVE_TRACK`.

Implementation rule: `Track.advances -> Goal` is an association edge, not containment. Do not add `goal_phid` as a parent field on Track.

### 4. Task Extension

Extend these files in place:

- `document-models/task/v1/actions.ts`
- `document-models/task/v1/schema.graphql`
- `document-models/task/v1/utils.ts`
- `document-models/task/v1/src/reducers/task-operations.ts`
- `document-models/task/v1/src/tests/create.test.ts`
- `document-models/task/v1/src/tests/dependencies.test.ts`
- `document-models/task/v1/src/tests/linked-artifacts.test.ts`

Add tests:

- `document-models/task/v1/src/tests/track-containment.test.ts`
- `document-models/task/v1/src/tests/general-links.test.ts`
- `document-models/task/v1/src/tests/task-compatibility.test.ts`

Task state additions:

```ts
type TaskState additions = {
  phid: string;
  type: "Task";
  schema_version: 1;
  project_phid: string | null;
  track_phid: string | null;
  links: AssociationEdge[];
  origin_idea_phid: string | null;
};
```

Compatibility fields that must remain:

- `task_phid`
- `project`
- `linked_artifacts`
- `depends_on`
- current status, owner, tags, due, comment, block, source, and provenance fields

New ops:

- `MOVE_TO_TRACK`
- `CLEAR_TRACK`
- `LINK_REF`
- `UNLINK_REF`

Allowed `LINK_REF` target types:

- `Goal`
- `Track`
- `Idea`
- `Dispatch`
- `Artifact`
- `Entry`
- `Task`

Allowed `LINK_REF` relations in Phase 1:

- `depends_on`
- `links_to`
- `originated_from`
- `executes`
- `produced_by`
- `satisfies`
- `references`

Reducer tests:

- `CREATE` sets `phid === task_phid`, `type === "Task"`, and `schema_version === 1`;
- `CREATE` maps existing string `project` into `project_phid` only when the caller supplies a PHID-shaped `project_phid`; otherwise `project_phid` remains null and `project` remains unchanged;
- `CREATE` accepts nullable `track_phid`;
- `CREATE` rejects non-null `track_phid` that is not `phid:track:*`;
- `MOVE_TO_TRACK` requires `phid:track:*`, sets `track_phid`, updates audit fields, and rejects from `ARCHIVED`;
- `CLEAR_TRACK` sets `track_phid` to null, updates audit fields, and is idempotent when already null;
- `LINK_REF` with `rel: "depends_on"` and `target_type: "Task"` updates both `links[]` and the existing `depends_on[]` compatibility array;
- `UNLINK_REF` with `rel: "depends_on"` removes from both `links[]` and `depends_on[]`;
- existing `ADD_DEPENDENCY` and `REMOVE_DEPENDENCY` also update `links[]` using `rel: "depends_on"` and `target_type: "Task"`;
- existing `LINK_ARTIFACT` also adds a generalized `links[]` edge with `rel: "references"` for external locators or `rel: "satisfies"` when `kind === "ARTIFACT"` and `target_phid` is present;
- existing `UNLINK_ARTIFACT` removes the generalized edge tied to the old link id;
- `LINK_REF` dedupes by deterministic `edge_id`;
- `LINK_REF` rejects `rel: "blocks"` because `blocks` is derived reverse of `depends_on`;
- `LINK_REF` rejects containment relations such as `track` or `project`;
- all pre-existing Task tests continue passing unchanged except for expected added default fields in full-state snapshots.

GraphQL additions:

- `TaskState.phid: PHID!`
- `TaskState.type: EntityType!`
- `TaskState.schema_version: Int!`
- `TaskState.project_phid: PHID`
- `TaskState.track_phid: PHID`
- `TaskState.links: [AssociationEdge!]!`
- `TaskState.origin_idea_phid: PHID`
- inputs for `MoveToTrackInput`, `ClearTrackInput`, `LinkRefInput`, `UnlinkRefInput`

### 5. Idea Doc-Model

Create:

```text
document-models/idea/v1/actions.ts
document-models/idea/v1/index.ts
document-models/idea/v1/module.ts
document-models/idea/v1/schema.graphql
document-models/idea/v1/utils.ts
document-models/idea/v1/src/reducers/idea-operations.ts
document-models/idea/v1/src/tests/create-idea.test.ts
document-models/idea/v1/src/tests/status-idea.test.ts
document-models/idea/v1/src/tests/promote-idea.test.ts
```

Idea state:

```ts
type IdeaStatus = "OPEN" | "PROMOTED" | "ARCHIVED";

type IdeaState = {
  phid: string;
  idea_phid: string;
  type: "Idea";
  schema_version: 1;
  project_phid: string;
  title: string;
  body_markdown: string;
  display_id: string | null;
  status: IdeaStatus;
  links: AssociationEdge[];
  promoted_to_phid: string | null;
  promoted_to_type: "Track" | "Task" | null;
  promoted_at: string | null;
  promoted_by: ActorRef | null;
  promotion_rationale: string | null;
  created_at: string;
  created_by: ActorRef;
  updated_at: string;
  updated_by: ActorRef;
  archived_at: string | null;
};
```

Ops:

- `CREATE_IDEA`
- `UPDATE_IDEA_TITLE`
- `UPDATE_IDEA_BODY`
- `SET_IDEA_STATUS`
- `PROMOTE_IDEA`
- `ARCHIVE_IDEA`

Reducer tests:

- `CREATE_IDEA` requires `phid:idea:*`, `project_phid`, non-empty title, UTC `ts`, and actor ref;
- title/body updates reject from `ARCHIVED`;
- `SET_IDEA_STATUS` allows only `OPEN`, `PROMOTED`, `ARCHIVED`;
- `PROMOTE_IDEA` requires target type `Track` or `Task`;
- `PROMOTE_IDEA` requires `target_phid` prefix matching target type;
- `PROMOTE_IDEA` sets status `PROMOTED`;
- `PROMOTE_IDEA` records `promoted_to_phid`, `promoted_to_type`, `promoted_at`, `promoted_by`, and optional rationale;
- `PROMOTE_IDEA` adds a `rel: "promoted_to"` forward edge to `links[]`;
- repeated `PROMOTE_IDEA` with the same target is idempotent;
- repeated `PROMOTE_IDEA` with a different target rejects with an error requiring an explicit reopen/unpromote operation, which is out of Phase 1 scope;
- `ARCHIVE_IDEA` rejects after promotion unless the input includes `allow_archived_promoted: true`, so promotion lineage cannot be silently hidden.

Spawned Track/Task requirement:

- The Track or Task creation flow that follows promotion must set `origin_idea_phid` and a `rel: "originated_from"` edge back to the Idea.
- Phase 1 does not need a cross-document transaction manager. It must expose the required create input fields and test that reducers accept and project them.

### 6. Entity Processor

Create:

```text
processors/entity-index/schema.ts
processors/entity-index/db.ts
processors/entity-index/index.ts
processors/entity-index/seed.ts
processors/entity-index/queries.ts
processors/entity-index/src/tests/schema.test.ts
processors/entity-index/src/tests/project-entity.test.ts
processors/entity-index/src/tests/entity-edge.test.ts
```

DDL:

```sql
CREATE TABLE IF NOT EXISTS entity_summary (
  phid TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  project_phid TEXT,
  title TEXT NOT NULL,
  display_id TEXT,
  status TEXT NOT NULL,
  parent_phid TEXT,
  parent_rel TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entity_summary_project
  ON entity_summary(project_phid, type, status);

CREATE INDEX IF NOT EXISTS idx_entity_summary_parent
  ON entity_summary(parent_phid, parent_rel);

CREATE TABLE IF NOT EXISTS entity_edge (
  edge_id TEXT PRIMARY KEY,
  source_phid TEXT NOT NULL,
  source_type TEXT NOT NULL,
  rel TEXT NOT NULL,
  target_phid TEXT NOT NULL,
  target_type TEXT,
  created_at TEXT NOT NULL,
  created_by_json TEXT NOT NULL,
  metadata_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_entity_edge_source
  ON entity_edge(source_phid, rel);

CREATE INDEX IF NOT EXISTS idx_entity_edge_target
  ON entity_edge(target_phid, rel);
```

Processor tests:

- seeding a Goal writes `entity_summary` with parent `project`;
- seeding a Track writes `entity_summary` with parent `project`;
- seeding a Task with `track_phid` writes `entity_summary.parent_phid = track_phid` and `parent_rel = "track"`;
- seeding a Task with `track_phid = null` writes no parent but preserves `project_phid`;
- seeding an Idea writes `entity_summary` with parent `project`;
- seeding Track with `advances` writes `entity_edge` rows;
- seeding Task with `depends_on` writes `entity_edge` rows;
- seeding Idea with `promoted_to` writes `entity_edge` rows;
- re-seeding the same states is idempotent and does not duplicate edges;
- removing a forward link from state removes the old `entity_edge` row on upsert;
- querying by `target_phid` returns reverse edges without requiring reverse storage in the source document.

Public API:

```ts
class EntityIndex {
  static empty(): Promise<EntityIndex>;
  static fromStates(states: EntityDocumentState[], driveId?: string): Promise<EntityIndex>;
  isReady(): boolean;
  markReady(): void;
  upsert(state: EntityDocumentState, driveId?: string): Promise<void>;
  entity(phid: string): Promise<EntitySummaryRow | null>;
  projectGoals(projectPhid: string): Promise<EntitySummaryRow[]>;
  projectTracks(projectPhid: string): Promise<EntitySummaryRow[]>;
  trackTasks(trackPhid: string): Promise<EntitySummaryRow[]>;
  projectLooseTasks(projectPhid: string): Promise<EntitySummaryRow[]>;
  projectIdeas(projectPhid: string): Promise<EntitySummaryRow[]>;
  entityEdges(args: {
    source_phid?: string;
    target_phid?: string;
    rel?: AssociationRel;
  }): Promise<EntityEdgeRow[]>;
}
```

### 7. Entity Subgraph

Create:

```text
subgraphs/entities/schema.graphql
subgraphs/entities/resolvers.ts
subgraphs/entities/summary.ts
subgraphs/entities/with-index.ts
subgraphs/entities/src/tests/entity-resolvers.test.ts
```

Queries:

- `entity(phid: PHID!): EntitySummary`
- `projectGoals(project_phid: PHID!): [EntitySummary!]!`
- `projectTracks(project_phid: PHID!): [EntitySummary!]!`
- `trackTasks(track_phid: PHID!): [EntitySummary!]!`
- `projectLooseTasks(project_phid: PHID!): [EntitySummary!]!`
- `projectIdeas(project_phid: PHID!): [EntitySummary!]!`
- `entityEdges(source_phid: PHID, target_phid: PHID, rel: AssociationRel): [EntityEdge!]!`

Resolver tests:

- resolvers use `EntityIndex` when ready;
- resolvers fall back to an in-memory state walk when the index is not ready;
- `projectTracks` does not include Goals through `advances`;
- `trackTasks` follows Task containment only;
- reverse Goal-to-Track lookup is answered by `entityEdges(target_phid: goal, rel: advances)`;
- all returned DTOs include `schema_version: "kapelle.entity.read.v1"` and provenance metadata.

### 8. Package Registration

Update:

- `document-models/document-models.ts`
- `document-models/index.ts`
- `index.ts`
- `powerhouse.manifest.json`
- package exports for `entity-relations`, `goal`, `track`, `idea`, and `entity-index`

Tests:

- module registry includes Task, Goal, Track, and Idea;
- package root exports all four document-model modules;
- manifest includes all four document models and the entity processor;
- importing `@kilgore/task/entity-relations` exposes registry helpers.

## Migration Compatibility

Task compatibility is a hard acceptance gate.

Keep current `task_summary`, `task_tag`, `task_link`, and `task_dep` processor tests passing. Existing `taskview` and Task subgraph behavior must continue to work from the old fields while the new entity projection is introduced.

Add compatibility tests:

- old Task `CREATE` inputs without `project_phid`, `track_phid`, or `links` still produce valid Task state;
- old Task `LINK_ARTIFACT` still writes `linked_artifacts`;
- old Task `ADD_DEPENDENCY` still writes `depends_on`;
- `tasks-index` continues to read old compatibility arrays;
- `entity-index` reads the new generalized fields from the same Task state.

## Verification Commands

Run from `agent-platform-task-package-v0/task-package`:

```bash
npm test -- entity-relations
npm test -- document-models/goal
npm test -- document-models/track
npm test -- document-models/task
npm test -- document-models/idea
npm test -- processors/entity-index
npm test -- subgraphs/entities
npm test
```

If the test runner does not support path filters, use the repo's Vitest invocation with equivalent file globs.

## Acceptance Checklist

- `Goal`, `Track`, and `Idea` follow the existing `@kilgore/task` document-model package shape.
- Task is extended in place; no second Task store exists.
- Every reducer has red-then-green tests for create, update, lifecycle, links, and invalid PHIDs.
- All entity mutating ops target PHIDs.
- `display_id` is never accepted as an operation target.
- `Task.track_phid` is nullable and tested.
- `Track.advances[]` stores forward edges to Goal.
- Goal reverse Track lookup is projection-only through `entity_edge`.
- `Idea.PROMOTE_IDEA` records promotion payload and writes `promoted_to`.
- Spawned Track/Task create inputs accept `origin_idea_phid` and write `originated_from`.
- `LINK_REF` rejects derived reverse relation `blocks`.
- `entity_edge` is rebuilt from inline forward links and deduped by deterministic edge id.
- Processor upsert removes stale projected edges when state links are removed.
- Task legacy processor and subgraph tests still pass.
- Entity subgraph can assemble project Goals, Tracks, loose Tasks, Track Tasks, Ideas, and association edges without parsing markdown.

## Closeout Artifact

Roger's build closeout should report:

- changed package paths;
- test commands and results;
- any existing tests updated only because default state gained substrate fields;
- generated or updated manifest entries;
- confirmation that no markdown file became canonical state;
- confirmation that no separate edge doc-model was introduced.
