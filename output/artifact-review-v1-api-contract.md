# Artifact Review v1 API Contract Closeout

Task: `artifact-review-v1-contract-check`
Dispatch: `phid:disp-d6359d92e9949b1e`
Worktree: `/Users/kilgore/Dropbox/Code/substrate-orch-codex/worktrees/id-agents-artifact-review-v1-contract`

## Summary

The manager backend can persist real Artifact Review v1 feedback today. Comments, approval, approval-with-comment, rejection/request-changes, dispatch follow-up receipts, and timeline readback are backed by SQLite tables, not local UI fallback.

The primary stores are:

- `artifact_review_state`: one row per artifact for current review flags and notes.
- `artifact_operations`: append-only operation log for comments, approvals, rejections, dispatch receipts, views, ship attempts, edits, and draft revisions.
- `artifacts` and related catalog/provenance tables: artifact metadata and reader-pane hydration.

## UI-Facing Endpoints

### Load Review State

`GET /artifacts/:artifact_id/review`

Returns `schema_version: "artifact.review.v1"`, `state`, `catalog`, `availability`, `operations_count`, and convenience flags:

- `is_viewed`
- `is_approved`
- `is_rejected`
- `is_shipped`
- `is_ship_blocked`

`is_rejected` was added in this slice so the basic review endpoint now matches the detail endpoint's reject visibility.

### Load Reader Pane

`GET /artifacts/:artifact_id/detail`

Returns `schema_version: "artifact.detail.v1"` with body/render metadata plus:

- `review.state`
- `review.status`
- `review.comments_count`
- `review.timeline_count`
- `review.latest_comment`
- `review.latest_timeline_event`
- `comments[]`
- `timeline[]`
- provenance/evidence

Use this as the one-call pane hydration endpoint when rendering the review UI.

### Add Comment

`POST /artifacts/:artifact_id/comments`

Body:

```json
{
  "actor_ref": "user:chris",
  "body": "Comment text",
  "anchor": "optional-section-or-line",
  "source_link": "optional-source"
}
```

Durable: yes. Writes a `comment_recorded` operation and touches review state.

Readback:

- `GET /artifacts/:artifact_id/comments`
- `GET /artifacts/:artifact_id/timeline`
- `GET /artifacts/:artifact_id/detail`
- `GET /artifacts/:artifact_id/operations`

Routing: if `enqueueDispatch` is mounted, response includes `dispatch_routed: true` and `dispatch`. If not mounted, the comment still persists and response includes `dispatch_routed: false`, `dispatch: null`, and `dispatch_skipped: "scheduler_unavailable"` or `"artifact_owner_unknown"`.

### Approve

`POST /artifacts/:artifact_id/approve`

Body:

```json
{
  "actor_ref": "user:chris",
  "note": "Approval note",
  "idempotency_key": "stable-key"
}
```

Durable: yes. Updates `artifact_review_state.approved_at`, `approved_by`, `approval_note`; appends an `approve` operation.

If the task emit seam is not mounted, approval still persists and response marks `task_emitted: false`, `task_emit_skipped: "manager_emit_target_not_configured"`.

### Approve With Comment

`POST /artifacts/:artifact_id/approve`

Body:

```json
{
  "actor_ref": "user:chris",
  "note": "Approval note",
  "comment": "Visible review comment",
  "idempotency_key": "stable-key"
}
```

Durable: yes. Creates both:

- a `comment_recorded` operation with idempotency key suffix `:comment`
- an `approve` operation with idempotency key suffix `:approval`

Both appear in timeline readback.

### Request Changes / Reject

`POST /artifacts/:artifact_id/reject`

Body:

```json
{
  "actor_ref": "user:liz",
  "note": "Request changes note"
}
```

Durable: yes. Updates `artifact_review_state.rejected_at`, `rejected_by`, `reject_note`; appends a `reject` operation. The UI can label this action as "Request changes" while targeting the backend reject endpoint.

### Activity Timeline

`GET /artifacts/:artifact_id/timeline`

Returns `schema_version: "artifact.timeline.v1"` and `events[]` projected from `artifact_operations`.

Relevant `event.kind` values:

- `comment`
- `suggested_change`
- `approval`
- `rejection`
- `dispatch_follow_up`
- `comment_routed`
- `view`
- `ship`
- `ship_blocked`
- `edit`
- `draft_revision`

Each event includes `op_id`, `actor`, `ts`, `body`, `markdown`, `anchor`, `status`, `idempotency_key`, `dispatch_receipt`, and raw `payload`.

### Dispatch Follow-Up Receipt

`POST /artifacts/:artifact_id/timeline`

Body:

```json
{
  "kind": "dispatch_follow_up",
  "actor_ref": "user:liz",
  "body": "Follow-up context",
  "target_agent": "substrate-api-codex",
  "query_id": "query_123",
  "dispatch_phid": "phid:disp-123",
  "status": "queued",
  "idempotency_key": "stable-key"
}
```

Durable receipt: yes. This records a visible receipt/status in timeline. It does not itself enqueue a manager dispatch; it is the UI-visible readback surface for a follow-up dispatch receipt. Real comment routing is handled by `POST /comments` when the scheduler enqueue seam is mounted.

## Stubbed or Conditional Surfaces

- Comment capture is always durable, but automatic owner routing is conditional on the manager mounting `enqueueDispatch`.
- Approval state is always durable, but downstream approval task emission is conditional on `tasks` and `resolveTeamId` being mounted.
- Ship may be blocked with durable `ship_blocked` operations when no executor is configured. This is explicit, not fake success.

## Verification

Added contract coverage in `tests/unit/outputs-artifact-timeline.test.ts`:

- add comment -> `GET /comments` readback
- approve with comment -> state and comment visible
- request changes/reject -> durable state and `/review.is_rejected`
- dispatch follow-up -> receipt/status visible
- timeline -> all events visible after reload

