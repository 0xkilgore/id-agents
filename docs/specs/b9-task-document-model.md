# Kapelle B9: Task As First-Class Document Model

> **Imported into id-agents 2026-06-10** from `cto/output/2026-06-08-kapelle-b9-task-document-model-spec.md` with RD-001 (decision #49 — stable record identity is canonical; display IDs are derived; operations reference stable IDs only) encoded per `cto/output/2026-06-09-rd001-spec-language-scope.md`. RD-001 normative blocks live in Sections 0, 3, 4, 6, 7, 12, 18. See `docs/specs/rd001-record-identity.md` for the cross-package summary.

Date: 2026-06-08  
Author: cto  
Task: `kapelle-b9-task-docmodel-spec`  
Status: CTO spec for build dispatches

## 0. Executive Decision

Kapelle B9 should promote **Task** from `taskview` markdown/JSON into a first-class document model backed by typed operations, deterministic projections, and an explicit SQLite/document-model mirror.

The immediate product goal is narrow:

> Show real to-dos/tasks on the Kapelle dashboard, backed by document-model/substrate structure, with provenance and lifecycle state visible.

B9 is not a full task editor rewrite. It is the canonical data layer and first read surface:

1. Task documents become the source of truth for task lifecycle state.
2. `taskview` continues as a familiar write surface during migration.
3. Kapelle Console reads a `KapelleToday` projection, not static fixtures and not direct markdown.
4. InboxItem, Dispatch, Artifact, and AgentOutput link to Task by explicit PHID/reference only.
5. RD-001 is binding for Task: `task_phid` is the canonical Task identity; task titles, markdown line numbers, taskview positions, short labels, and display counters are derived only.
6. SQLite remains the operational mirror during transition, but no new Kapelle feature should be designed around markdown as canonical state.

This matches the Powerhouse/Vetra/local-first posture Chris has been pushing: typed operations and replayable document history are the durable substrate; markdown is a projection/export; SQLite is a pragmatic read/write mirror while the local-first stack stabilizes.

## 1. Scope

### In Scope

- Task document schema.
- Task lifecycle states and reducer invariants.
- Operation set for create, update, complete, snooze, block, link, comment, archive, and feedback-driven follow-up.
- Dashboard/Kapelle projections.
- Links to `InboxItem`, `Dispatch`, `Artifact`, and `AgentOutput`.
- Migration from `taskview` markdown/JSON.
- SQLite/document-model mirror plan.
- API endpoints needed by Kapelle Console.
- Build slices for Roger, Regina, and Cane.
- Open decisions and recommended next dispatches.

### Out Of Scope For B9

- Full Powerhouse Connect task editor.
- Replacing every `taskview` command.
- Multi-user hosted auth/tenant model.
- Recurring task engine.
- Complex project management features such as Gantt/timeline planning.
- Free-text similarity joins between tasks and other documents.
- Automatically dispatching agents from every Task action without an explicit operation contract.

## 2. Domain Boundary

Task owns **executable work**: title, owner, due date, priority, status, blockers, completion, comments, provenance, and explicit links to documents/dispatches/artifacts.

It does not own raw intake, agent runtime, or output documents.

| Model | Owns | Relationship To Task |
|---|---|---|
| `InboxItem` | receipt, source payload, triage, terminal resolution | Can resolve to one or more Tasks. InboxItem remains terminal after Task creation; Task owns execution. |
| `Dispatch` | outbound work order to an agent, runtime status, verification | Can be spawned from a Task or linked as work executing a Task. Dispatch owns agent execution state. |
| `Artifact` | durable output document/file/report | Can satisfy or inform a Task. Artifact owns content and review operations. |
| `AgentOutput` | raw/normalized agent closeout output before or beside Artifact | Can be linked as evidence or source material. Should usually promote to Artifact for durable review. |
| `Task` | work item lifecycle | Links out to all of the above by PHID/source refs. No reverse pointers required in those documents. |

The join rule is strict:

> Kapelle may compose views across these models only by explicit PHID, `source_ref`, `parent_ref`, operation payload reference, or persisted link table. It must not infer relationships by similar names, topics, or prose.

This rule exists to prevent context mixing such as unrelated email material being pulled into a person/project/task panel.

## 3. Document Identity

Recommended document type:

```text
kilgore/task
```

Recommended PHID:

```text
task_<stable-id>
```

RD-001 identity rule:

- `task_phid` is the canonical identity for Task documents and Task operations.
- Imported markdown line hashes, section paths, taskview short labels, manager task UUIDs, and display names are provenance or compatibility fields, not operation targets unless explicitly mapped to `task_phid`.
- Any route or operation that mutates a Task MUST target `task_phid` or a server-resolved stable compatibility key. It MUST NOT target a title, visible row number, markdown line number, or display ID.
- Re-imports and shadow writes MUST resolve to the same `task_phid` before appending operations.

For migrated markdown tasks, stable ID seed:

```text
canonical_path_hint + section_path + legacy_line_hash
```

For new CLI/API-created tasks, stable ID seed:

```text
workspace_id + source_kind + source_id_or_uuid
```

The migration importer must be idempotent. Re-running import must update or skip the same `task_phid`, not create duplicates.

## 4. State Fields

Canonical state should be richer than the Kapelle row projection. Suggested state:

```ts
type TaskState = {
  task_phid: string;
  schema_version: 1;

  title: string;
  body_markdown: string | null;

  status:
    | "open"
    | "scheduled"
    | "snoozed"
    | "blocked"
    | "waiting"
    | "in_progress"
    | "done"
    | "cancelled"
    | "archived";

  priority: "high" | "med" | "low" | null;
  owner: string | null;
  assignee_agent: string | null;
  project: string | null;
  tags: string[];
  display_id: string | null; // derived/read-model only; never an operation target

  due_date: string | null;          // YYYY-MM-DD in viewer/workspace calendar
  scheduled_for: string | null;     // ISO datetime or date
  snoozed_until: string | null;     // ISO datetime or date
  started_at: string | null;        // UTC ISO
  completed_at: string | null;      // UTC ISO
  cancelled_at: string | null;      // UTC ISO
  archived_at: string | null;       // UTC ISO

  block: {
    blocked_by: string | null;
    reason: string | null;
    since: string | null;
    cleared_at: string | null;
  };

  provenance: {
    source: "MIGRATION" | "CLI" | "KAPELLE" | "EMAIL" | "INBOX_ITEM" | "DISPATCH" | "AGENT" | "API";
    source_ref: string | null;
    canonical_path_hint: string | null;
    legacy_line_hash: string | null;
    legacy_section: string | null;
    trello_shortlink: string | null;
    created_by: string;
    created_at: string;             // UTC ISO
    updated_at: string;             // UTC ISO
  };

  links: {
    inbox_item_phids: string[];
    dispatch_phids: string[];
    artifact_phids: string[];
    agent_output_ids: string[];
    parent_task_phid: string | null;
    subtask_phids: string[];
    depends_on_task_phids: string[];
    external_refs: ExternalRef[];
  };

  comments: TaskComment[];
  feedback: TaskFeedback[];
  lifecycle_log: LifecycleEntry[];
};
```

### Field Notes

- `status` is the reducer-owned lifecycle state. Dashboard labels are projections.
- `due_date` is date-only. Store UTC timestamps for lifecycle events, but resolve date buckets with a `viewer_tz`.
- `scheduled_for` is "not actionable until"; `due_date` is "should be done by".
- `snoozed_until` temporarily hides/defers an otherwise known task.
- `waiting` is for external dependency or agent/user wait without a hard blocker.
- `blocked` requires a reason.
- `project` must be mutable. Current work routinely moves between buckets as scope clarifies.
- `links` are forward references. Reverse projections are built by reactor-walk first, then processor/index.
- `comments` belong on Task only when the comment is about execution of the task. Comments on output quality belong on Artifact/AgentOutput and may create Task feedback or follow-up refs.
- `display_id` is optional presentation metadata. It can be a taskview label, short manager label, or UI counter, but reducers MUST be correct if it is null or recomputed.

## 5. Lifecycle States

Recommended state machine:

```text
open
  -> scheduled
  -> snoozed
  -> waiting
  -> blocked
  -> in_progress
  -> done
  -> cancelled
  -> archived

scheduled -> open | snoozed | cancelled
snoozed -> open | scheduled | cancelled
waiting -> open | blocked | in_progress | cancelled
blocked -> open | waiting | cancelled
in_progress -> open | blocked | waiting | done | cancelled
done -> open | archived
cancelled -> open | archived
archived -> open
```

### Reducer Invariants

- `blocked` requires `block.reason`.
- `done` requires `completed_at`.
- `cancelled` requires `cancelled_at` and a reason.
- `archived` requires terminal or explicit override.
- `snoozed` requires `snoozed_until`.
- `scheduled` requires `scheduled_for`.
- `due_date` is optional in the schema but Kapelle action surfaces must make undated actionable items visible through `undated_actions`.
- Tasks created from `InboxItem.terminal.action` should have a due date unless a human explicitly chooses `scheduled_for` or `waiting` with reason.
- No operation may silently drop `legacy_line_hash`, `canonical_path_hint`, or source refs during migration.

## 6. Operations

Minimum B9 operation set:

| Operation | Purpose | Key invariants |
|---|---|---|
| `CREATE_TASK` | Create task document. | Requires title, source, created_by. Stable idempotency key for imports. |
| `UPDATE_TITLE` | Rename task. | Legal until archived; records actor/time. |
| `UPDATE_BODY` | Update context/body markdown. | Legal until archived. |
| `SET_OWNER` | Assign human owner. | Owner may be null only for unassigned/inbox-like task. |
| `SET_ASSIGNEE_AGENT` | Mark expected agent owner. | Does not create Dispatch by itself. |
| `SET_PROJECT` | Move task between projects. | Required because project changes after capture are common. |
| `SET_PRIORITY` | Set high/med/low/null. | Used by Today ranking. |
| `SET_DUE_DATE` | Set/clear due date. | Clearing due date should add context warning unless task is waiting/scheduled. |
| `SCHEDULE` | Set `scheduled_for`. | Transitions to `scheduled` unless already terminal. |
| `SNOOZE` | Set `snoozed_until`. | Transitions to `snoozed`. |
| `START_TASK` | Mark active work. | Transitions to `in_progress`. |
| `COMPLETE_TASK` | Mark done. | Sets `completed_at`; may link satisfying Artifact/Dispatch. |
| `REOPEN_TASK` | Reopen done/cancelled/archived task. | Requires reason. Clears terminal timestamps only by reducer rule. |
| `CANCEL_TASK` | Close as no longer needed. | Requires reason. |
| `ARCHIVE_TASK` | Hide from active surfaces. | Requires terminal state or override. |
| `BLOCK_TASK` | Mark blocked. | Requires reason; optional blocker ref. |
| `CLEAR_BLOCK` | Unblock. | Records prior block in lifecycle log. |
| `SET_WAITING` | Mark waiting on user/agent/external event. | Requires reason or linked ref. |
| `ADD_TAG` | Add tag. | Idempotent. |
| `REMOVE_TAG` | Remove tag. | Idempotent. |
| `LINK_REF` | Link InboxItem/Dispatch/Artifact/AgentOutput/external/task. | Requires typed ref and relation. |
| `UNLINK_REF` | Remove explicit link. | Requires reason if link came from migration/resolution. |
| `ADD_COMMENT` | Add execution comment. | Actor/timestamp required. |
| `ADD_FEEDBACK` | Attach structured review feedback or follow-up note. | Bridge from B10 Outputs Lane sidecar to typed operations. |
| `CREATE_FOLLOWUP_TASK` | Create/link child follow-up from a Task or Artifact feedback item. | Should create new Task doc and link parent. |

### Operation Target Identity

Every Task operation envelope MUST carry `task_phid` as the target. Operation payloads may include compatibility provenance such as `legacy_line_hash`, `canonical_path_hint`, manager task UUID, or source row ID, but reducers MUST NOT use those display/provenance values as the canonical target after import resolution.

Idempotency keys for imported or generated operations MUST include the resolved stable identity seed. They MUST NOT include display order, queue position, title text, or markdown line number unless that value is only part of the pre-resolution seed used to produce the stable PHID.

### `LINK_REF` Shape

```ts
type TaskLinkedRef = {
  target_kind:
    | "INBOX_ITEM"
    | "DISPATCH"
    | "ARTIFACT"
    | "AGENT_OUTPUT"
    | "TASK"
    | "CONTACT"
    | "PROJECT"
    | "EXTERNAL";
  target_phid: string | null;
  external_id: string | null;
  relation:
    | "CREATED_FROM"
    | "SATISFIES"
    | "BLOCKED_BY"
    | "EVIDENCE"
    | "FOLLOWUP_FROM"
    | "EXECUTED_BY"
    | "MENTIONS"
    | "DEPENDS_ON";
  label: string | null;
  created_at: string;
  created_by: string;
};
```

### `ADD_FEEDBACK` Shape

B10 preview records should migrate mechanically into this op:

```ts
type AddFeedbackInput = {
  feedback_id: string;
  source_kind: "ARTIFACT" | "AGENT_OUTPUT" | "DISPATCH" | "TASK" | "KAPELLE_REVIEW";
  source_ref: string;
  reviewer: string;
  body_markdown: string;
  disposition:
    | "comment"
    | "approve"
    | "request_changes"
    | "redirect"
    | "create_followup"
    | "close";
  target_agent: string | null;
  creates_task_phid: string | null;
  created_at: string;
};
```

`ADD_FEEDBACK` should not be a generic chat note. It is a typed review/action record that can drive follow-up tasks, agent dispatches, or artifact status changes later.

## 7. Projections

### Canonical Task Queries

Task reactor/subgraph should expose:

| Query | Purpose |
|---|---|
| `task(task_phid)` | Detail view. |
| `tasksDueToday(owner, viewer_tz)` | Today panel. |
| `tasksOverdue(owner, viewer_tz)` | Overdue panel. |
| `tasksDueThisWeek(owner, viewer_tz)` | Weekly planning. |
| `tasksBlocked(owner)` | Blocked/waiting panel. |
| `tasksDoneRecent(owner, since)` | Recent completed panel. |
| `tasksUnscheduledAction(owner)` | Open/high/action tasks with no due/schedule/waiting reason. |
| `tasksByProject(project, status)` | Project view. |
| `tasksLinkedTo(target_phid)` | Reverse lookup by explicit link. |
| `taskHistory(task_phid)` | Operation timeline. |

All query arguments named `task_phid` or `target_phid` require stable IDs. Display IDs may be returned in DTOs, but reverse lookup and history queries must not accept display-only IDs.

### Kapelle Console Projection

Kapelle should consume a single task-aware Today DTO, not raw document-model state:

```ts
type KapelleToday = {
  generated_at: string;
  source: "reactor" | "sqlite_mirror" | "fixture_fallback";
  viewer_tz: string;
  tasks: {
    due_today: TaskSummary[];
    overdue: TaskSummary[];
    due_this_week: TaskSummary[];
    blocked: TaskBlockedSummary[];
    waiting: TaskSummary[];
    unscheduled_actions: TaskSummary[];
    done_recent: TaskSummary[];
  };
  inbox: {
    unresolved: InboxItemSummary[];
    undated_actions: InboxItemSummary[];
    with_open_tasks: InboxTaskJoinSummary[];
    waiting_on_agent: WaitingOnAgentRow[];
  };
  dispatches: {
    in_flight: DispatchSummary[];
    failed_or_blocked: DispatchSummary[];
    completed_recent: DispatchSummary[];
  };
  outputs: {
    awaiting_review: OutputReviewSummary[];
    feedback_to_migrate: OutputFeedbackSummary[];
  };
  context_warnings: ContextWarning[];
};
```

`TaskSummary` should include:

```ts
type TaskSummary = {
  task_phid: string;
  title: string;
  project: string | null;
  owner: string | null;
  assignee_agent: string | null;
  status: string;
  priority: string | null;
  due_date: string | null;
  scheduled_for: string | null;
  snoozed_until: string | null;
  blocked_reason: string | null;
  source: string;
  source_ref: string | null;
  canonical_path_hint: string | null;
  legacy_line_hash: string | null;
  linked_refs: TaskLinkedRef[];
  updated_at: string;
};
```

### Ranking Rules

Default Today ordering:

1. overdue high priority
2. due today high priority
3. blocked/waiting with stale timestamp
4. due today medium/low
5. unscheduled actions
6. due this week
7. recent done

Do not hide unscheduled actions. If a Task has no `due_date`, no `scheduled_for`, and no waiting/block reason, it should surface in `unscheduled_actions`.

## 8. Links To Adjacent Models

### InboxItem

InboxItem can create or link Task docs through a terminal action path.

Rules:

- `InboxItem.terminal.action` must link at least one Task PHID.
- Task created from InboxItem must include `source = "INBOX_ITEM"` and `source_ref = inbox_phid`.
- Task must `LINK_REF` back to InboxItem with `relation = "CREATED_FROM"`.
- InboxItem completion does not change Task completion.
- Task completion does not reopen InboxItem.

Needed projections:

- `inboxItemsWithOpenTasks()`
- `inboxItemsWithOverdueTasks()`
- `undatedActions()`

### Dispatch

Dispatch executes agent work. Task may spawn or link Dispatch.

Rules:

- Dispatch created from Task should include parent ref to `task_phid`.
- Task links Dispatch with `relation = "EXECUTED_BY"`.
- Dispatch terminal success may optionally complete Task if the dispatch was the declared execution path and verification passes; otherwise it should add feedback/comment and leave Task open.
- Dispatch failure should surface in Task warnings, not silently mutate Task to blocked unless a `BLOCK_TASK` operation is emitted.

Needed projections:

- `dispatchesForTask(task_phid)`
- `tasksWaitingOnDispatch()`
- `tasksWithFailedDispatches()`

### Artifact

Artifact is the durable output/review object.

Rules:

- Artifact can satisfy a Task by explicit `LINK_REF relation = "SATISFIES"`.
- Artifact review feedback may create Task feedback or follow-up Task via `ADD_FEEDBACK`/`CREATE_FOLLOWUP_TASK`.
- B10 `.ops-artifact-reviews/` preview records are migration inputs to Task/Artifact typed feedback ops.

Needed projections:

- `artifactsForTask(task_phid)`
- `tasksSatisfiedByArtifact(artifact_phid)`
- `tasksWithPendingArtifactFeedback()`

### AgentOutput

AgentOutput is the lower-level agent closeout/read-output record.

Rules:

- AgentOutput can be linked as evidence, source, or interim output.
- If the output is durable and user-reviewable, promote/link it to Artifact.
- Task should not embed raw AgentOutput bodies except short snippets.

Needed projections:

- `agentOutputsForTask(task_phid)`
- `tasksWithUnpromotedAgentOutputs()`

## 9. Powerhouse/Vetra/Local-First Posture

B9 should keep the architecture local-first and substrate-aligned:

- **Document model is canonical.** Task lifecycle is a replayable operation log, not a mutable markdown line.
- **SQLite is a mirror/read index.** It supports existing manager/taskview/Kapelle operational needs, but should be derivable from document operations.
- **Markdown is a projection.** During migration, markdown remains editable for operator ergonomics. End state: markdown can be exported/rendered, but not treated as canonical for new Kapelle features.
- **Vetra/Powerhouse should be used as the document-model pattern.** Do not block B9 on polished Connect editor UX.
- **Local reactor first.** Run the Task reactor locally on a stable port, with durable PGlite/Kysely index. Hosted/control-plane sync can come later.
- **Explicit operation APIs.** Kapelle writes should become Task operations, not direct DB row patches.
- **No hosted-only assumption.** The same Task package should run in local Kapelle and later in hosted worker cells.

## 10. SQLite / Document-Model Mirror Plan

### Desired Shape

```
Task operations
  -> Task document reducer state
  -> processor/index
  -> SQLite/PGlite task read tables
  -> Kapelle Today API
  -> Kapelle Console UI

Legacy taskview markdown
  -> migration importer / shadow client
  -> Task operations
  -> markdown projection during transition
```

### Mirror Tables

Minimum SQLite/PGlite mirror:

- `tasks`
- `task_links`
- `task_comments`
- `task_feedback`
- `task_operations`
- `task_projection_warnings`
- `task_legacy_map`

`tasks` columns should include:

- `task_phid`
- `title`
- `status`
- `priority`
- `owner`
- `assignee_agent`
- `project`
- `due_date`
- `scheduled_for`
- `snoozed_until`
- `blocked_reason`
- `source`
- `source_ref`
- `canonical_path_hint`
- `legacy_line_hash`
- `created_at`
- `updated_at`
- `completed_at`

`task_legacy_map` columns:

- `task_phid`
- `canonical_path_hint`
- `legacy_line_hash`
- `legacy_section`
- `legacy_task_text`
- `last_seen_at`
- `last_imported_at`
- `drift_status`

### Parity Checks

Every migration phase needs parity:

- markdown parsed open count vs Task open count
- completed markdown section not imported as open
- new CLI task appears in document model
- complete/snooze updates same `task_phid`
- SQLite mirror row matches reducer state
- Kapelle Today row count matches mirror/subgraph response
- orphan links appear in `context_warnings`

## 11. Migration From `taskview`

### Current Inputs

Known sources:

- `agent-platform/to-do.md`
- `cane/taskview/to-do.md`
- configured taskview project paths from `cane/taskview/config.yaml`
- `cane/taskview/cane-data/state.json`
- `deferred.json`, inbox/deferred state only where it maps cleanly to Task or InboxItem
- existing `task_shadow.py` hooks for create/complete/snooze

### Field Mapping

| Legacy form | Task field |
|---|---|
| checkbox text | `title` |
| indented/context lines | `body_markdown` |
| `!high`, `!med`, `!low` | `priority` |
| `@owner` | `owner` |
| `due:<date>` | `due_date` |
| `snoozed:<date>` | `snoozed_until`, status `snoozed` |
| `done:<date>` | status `done`, `completed_at` |
| `tid:<shortlink>` | `provenance.trello_shortlink` |
| project/frontmatter/path | `project`, `canonical_path_hint` |
| markdown section | `legacy_section` |
| raw line hash | `legacy_line_hash` |
| `## Done` section | status `done` even if checkbox reverted |

### Migration Phases

#### M0: Spec + Package Confirmation

- Confirm active Task package path.
- Confirm current operation names vs spec names.
- Freeze Kapelle Today DTO shape.

#### M1: One-Time Backfill + Shadow Writes

- Seed current markdown state into Task docs.
- Preserve source path/hash.
- Patch any missing `taskview.py` shadow gaps.
- Keep markdown authoritative for humans during M1.

Acceptance:

- importer is idempotent
- `taskview` still works with reactor disabled
- new create/complete/snooze shadow writes to Task docs
- Kapelle can read real Task rows

#### M2: Shadow Read / Parity

- Kapelle reads Task docs/mirror first.
- Taskview still reads markdown.
- Parity job compares markdown parser to Task projection.
- Drift appears as warnings, not silent correction.

Acceptance:

- no hidden open tasks
- no completed tasks mislabelled open
- unscheduled action bucket is visible

#### M3: Soft Cutover

- Task document model becomes canonical for Kapelle and manager APIs.
- Markdown generated/exported from Task docs or maintained as compatibility projection.
- New Kapelle task mutations write Task ops.

Acceptance:

- Kapelle complete/snooze/comment actions mutate Task docs
- taskview parity remains green
- rollback path is documented

#### M4: Legacy Retirement

- Markdown no longer needed for canonical state.
- Legacy parser remains available for import/export only.
- SQLite direct writes are removed or fenced as mirror-only.

## 12. API Endpoints Needed By Kapelle Console

B9 should define two layers: manager/control API and Kapelle frontend proxy.

### Manager / Cell API

Recommended endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/tasks/today?owner=&viewer_tz=` | Return KapelleToday-compatible task lanes or task-only subset. |
| `GET` | `/tasks/:task_phid` | Task detail with operation history and links. |
| `GET` | `/tasks/:task_phid/history` | Operation log. |
| `POST` | `/tasks` | Create Task operation. |
| `POST` | `/tasks/:task_phid/complete` | Emit `COMPLETE_TASK`. |
| `POST` | `/tasks/:task_phid/snooze` | Emit `SNOOZE`. |
| `POST` | `/tasks/:task_phid/block` | Emit `BLOCK_TASK`. |
| `POST` | `/tasks/:task_phid/waiting` | Emit `SET_WAITING`. |
| `POST` | `/tasks/:task_phid/reopen` | Emit `REOPEN_TASK`. |
| `POST` | `/tasks/:task_phid/comment` | Emit `ADD_COMMENT`. |
| `POST` | `/tasks/:task_phid/link` | Emit `LINK_REF`. |
| `POST` | `/tasks/:task_phid/feedback` | Emit `ADD_FEEDBACK`. |
| `GET` | `/tasks/linked-to/:phid` | Reverse lookup by explicit ref. |
| `GET` | `/tasks/migration/parity` | Migration health/drift status. |

RD-001 API rule:

- `:task_phid` path parameters are stable PHIDs.
- Compatibility endpoints may accept legacy manager task UUIDs only if the server resolves them to `task_phid` before mutation.
- Requests using display labels, row numbers, queue positions, titles, or taskview line numbers as mutation targets must return `400 invalid_task_id`.

### Kapelle Frontend Proxy

Recommended routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/today` | Console dashboard DTO composing Task/InboxItem/Dispatch/Output lanes. |
| `GET` | `/api/tasks/:task_phid` | Task detail proxy. |
| `POST` | `/api/tasks` | Create task from Console. Later slice. |
| `POST` | `/api/tasks/:task_phid/actions` | Complete/snooze/block/waiting/comment wrapper. Later slice. |
| `GET` | `/api/tasks/parity` | Admin-only migration health. |

### Error/Fallback Rules

- Private `/ops`/Console should prefer explicit error over fake success.
- Public demo routes may use `fixture_fallback`, but must visibly label it.
- API responses must include `source`, `generated_at`, and freshness/health metadata.
- Context warnings must be returned, not logged only server-side.

## 13. Kapelle Console UX Requirements

First B9 UI should be read-only or minimally mutating.

Ship panels:

- Due Today
- Overdue
- Blocked / Waiting
- Unscheduled Actions
- Unresolved Inbox
- Waiting On Agents
- Recent Completed

Each row must show:

- title
- status
- priority
- owner/agent
- project
- due/snooze/block state
- provenance label
- linked refs or at least PHID/source indicator
- freshness/updated timestamp

Do not hide provenance behind a debug-only panel. The whole point of B9 is that dashboard rows are explainable by substrate refs.

## 14. Implementation Slices

### Roger Slice: Task Package + Reactor + Mirror

Owner: Roger  
Purpose: canonical substrate and local reactor.

Work:

1. Move/vendor active Task package into `agent-platform/task-package`.
2. Confirm reducer operations against this CTO spec; do not redesign if existing package is close.
3. Start `task-reactor-server.mjs` on stable local port, expected `:4250`.
4. Ensure PGlite/Kysely processor creates mirror tables.
5. Add/verify GraphQL queries:
   - `tasksDueToday`
   - `tasksOverdue`
   - `tasksDueThisWeek`
   - `tasksBlocked`
   - `tasksDoneRecent`
   - `tasksUnscheduledAction`
   - `tasksLinkedTo`
6. Add migration importer if live post step is missing.
7. Add parity endpoint or script output for Cane/Kapelle to consume.

Acceptance:

- `npm test` passes in task package.
- reactor starts locally and survives restart with durable rows.
- importer dry run and live import are idempotent.
- seeded tasks appear in GraphQL and mirror.
- no completed markdown section appears as open.

### Cane Slice: `taskview` Migration + Shadow Writes

Owner: Cane  
Purpose: keep current operator workflow working while Task docs become canonical.

Work:

1. Audit `taskview.py` create/complete/snooze callsites.
2. Patch gaps so successful mutations call `shadow_create`, `shadow_complete`, `shadow_snooze`.
3. Ensure `TASK_REACTOR_URL=disabled` remains silent/safe.
4. Ensure shadow writes use stable `task_phid`/legacy hash, not title-only matching.
5. Add or update `test_task_shadow.py`.
6. Add drift/parity report over markdown vs Task projection.

Acceptance:

- `python3 -m unittest test_task_shadow -v` passes.
- CLI still works when reactor is unavailable.
- CLI-created task appears in Task GraphQL when reactor is available.
- complete/snooze updates same Task doc.
- drift report catches changed/deleted legacy lines.

### Regina Slice: Kapelle Console Read Surface

Owner: Regina  
Purpose: product-visible B9 surface.

Work:

1. Add `app/api/today/route.ts` or extend existing `/ops` adapter with a Task-backed Today DTO.
2. Add typed DTOs under Kapelle app code.
3. Replace static task rows in Console/Today with API-backed rows.
4. Render provenance and `context_warnings`.
5. Keep fallback fixtures only when visibly labeled.
6. Add route/component tests with mocked reactor data.
7. Add context-mixing regression fixture:
   - one Zach/Trinity item
   - one unrelated State Farm item
   - assert no inferred join by prose/name similarity

Acceptance:

- `/api/today` returns `source: "reactor"` with real task rows when reactor is available.
- missing reactor returns explicit error or labeled fallback, not fake live rows.
- Console renders real task titles from imported state.
- provenance is visible per row.
- context-mixing tests pass.

## 15. Recommended Build Order

1. Roger: active Task package + reactor + GraphQL/mirror health.
2. Cane: taskview shadow-write hardening and migration parity.
3. Roger: one-time import of current `to-do.md`/taskview state.
4. Regina: Kapelle `/api/today` adapter using mocked then live reactor.
5. Regina: Console panels with provenance and warnings.
6. Cane/Roger: parity sweep and drift fix.
7. CTO/verifier: end-to-end smoke across taskview CLI -> Task doc -> `/api/today` -> Console.

## 16. Open Decisions

1. **Due date policy:** Should all actionable Tasks require `due_date`, or may `scheduled_for`/`waiting` satisfy the invariant? Recommendation: require one of `due_date`, `scheduled_for`, `waiting`, or `blocked`; surface everything else in `unscheduled_actions`.
2. **Task package source:** Is `agent-platform-task-package-v0/task-package` still the canonical donor? Recommendation: yes, vendor/move it rather than re-spec from scratch.
3. **Connect editor:** Should B9 ship a Powerhouse Connect editor? Recommendation: no. Build reactor/API/projection first.
4. **Project field:** Is project mutable? Recommendation: yes; add/keep `SET_PROJECT`.
5. **Subtasks/dependencies:** Include typed fields in v1? Recommendation: include `parent_task_phid`, `subtask_phids`, and `depends_on_task_phids`, but only expose in UI later.
6. **Automatic completion from Dispatch:** Can a successful Dispatch complete a Task? Recommendation: only if the Task explicitly linked that Dispatch as satisfying execution and verification passes; otherwise require explicit `COMPLETE_TASK`.
7. **B10 feedback migration:** Should B10 sidecar records migrate to Task `ADD_FEEDBACK`, Artifact `ADD_FEEDBACK`, or both? Recommendation: Artifact owns output review; Task gets feedback only when it creates execution follow-up or comments on task execution.
8. **SQLite direct writes:** Are any legacy writers allowed to patch SQLite task rows directly? Recommendation: no new direct writes; mirror should be derived from ops.
9. **Archive policy:** Auto-archive done tasks after N days? Recommendation: no auto-archive in B9; keep recent done visible and archive explicitly.
10. **Owner default:** Is default owner `cto`, `kilgore`, or workspace user? Recommendation: local Chris/Kapelle Console default `cto` for current system; hosted later maps to workspace user.

## 17. Recommended Next Dispatches

### Dispatch 1: Roger

Title: `Kapelle B9 Task substrate package and reactor`

Ask:

- Move/vendor the existing Task package into the active platform path.
- Start the local Task reactor on `:4250`.
- Confirm reducer operations and GraphQL queries.
- Add/verify PGlite/Kysely mirror.
- Add idempotent import path for seeded markdown tasks.

Definition of done:

- tests pass
- reactor health works
- seeded task rows query through `tasksDueToday`, `tasksOverdue`, `tasksBlocked`, and `tasksDoneRecent`
- importer is idempotent

### Dispatch 2: Cane

Title: `Kapelle B9 taskview shadow-write and parity`

Ask:

- Harden `taskview.py` shadow writes for create/complete/snooze.
- Preserve disabled-reactor behavior.
- Use stable IDs/hash mapping.
- Add parity/drift report between markdown and Task projection.

Definition of done:

- unit tests pass
- taskview works offline
- live reactor receives create/complete/snooze updates without duplicates
- parity report catches drift

### Dispatch 3: Regina

Title: `Kapelle B9 Console Today task surface`

Ask:

- Add `/api/today` adapter or equivalent Console API route.
- Render Task-backed Due Today/Overdue/Blocked/Unscheduled/Recent Completed panels.
- Show provenance and context warnings.
- Use fixture fallback only when labeled.

Definition of done:

- mocked route tests pass
- live smoke against local reactor renders real imported task titles
- no hardcoded tasks appear when API returns reactor data
- context-mixing regression passes

### Dispatch 4: CTO/Verifier

Title: `Kapelle B9 end-to-end substrate verification`

Ask:

- Verify CLI -> Task doc -> mirror -> `/api/today` -> Console.
- Check migration parity.
- Check disabled-reactor fallback.
- Check context warning behavior.

Definition of done:

- one new task created in taskview appears in Kapelle
- completing/snoozing updates the same row
- stale/orphan/unscheduled rows are visible
- verification report names residual risks before promotion

## 18. Definition Of Done For B9

B9 is done when:

- Task documents exist as the canonical lifecycle substrate.
- Current taskview/to-do state is imported idempotently.
- New taskview create/complete/snooze mutations shadow-write Task operations.
- SQLite/PGlite mirror is generated from Task docs/ops.
- Kapelle Console reads a deterministic Today projection.
- Console shows real Task rows with provenance.
- InboxItem/Dispatch/Artifact/AgentOutput links are explicit and visible.
- Context warnings catch orphaned, ambiguous, or unscheduled action rows.
- Fixture fallback is clearly labeled and not confused for live data.
- No new Kapelle task feature depends on markdown as canonical state.
- RD-001 enforcement tests prove Task create/import/complete/snooze/link/comment mutations resolve to `task_phid`, and display IDs are rejected as operation targets.

## 19. Bottom Line

B9 should be treated as a substrate milestone, not a dashboard polish task.

The right implementation shape is:

```text
Task document model first
taskview shadow-write second
SQLite/PGlite mirror third
Kapelle Today projection fourth
Console rendering fifth
direct Kapelle task mutations later
```

That gives Chris the product-visible outcome he wants: real to-dos on Kapelle backed by the document-model structure, while preserving the local-first path and avoiding a risky all-at-once taskview replacement.
