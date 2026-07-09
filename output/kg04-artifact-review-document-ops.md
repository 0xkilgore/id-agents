# KG-04 ArtifactReview Document Operations

Implemented ArtifactReview document-operation v0 as a pure reducer/projection layer.

## Scope

- Added operation envelopes with stable `id`, `actor_ref`, `created_at`, optional `idempotency_key`, and typed payloads.
- Supported v0 operations: `assign_reviewer`, `comment`, `react`, `approve`, `reject`, `request_changes`, `mark_read`, `link_task`, and `create_followup`.
- Added deterministic projection cursor fields: `last_operation_id`, `last_created_at`, and `applied_count`.
- Shared the comment route-status projection used by routes so failed/rejected route attempts remain visible as `recorded-but-route-failed-with-retry`.

## Verification

- `npm test -- tests/unit/artifact-review-document-ops.test.ts`

## Notes

- UI was not redesigned.
- The implementation keeps the existing artifact review routes compatible and adds the document-operation contract as a reusable backend projection primitive.
