# RD-001 — Stable Record Identity (Decision #49)

> **Canonical principle, ratified by Chris as decision #49 / RD-001 on the substrate substrate-principle line.** Imported into id-agents 2026-06-10 by Roger from `cto/output/2026-06-09-rd001-spec-language-scope.md`. This file is the cross-package index; per-package normative blocks live verbatim in the four sibling spec files in this directory.

## The principle

Stable record identity is canonical. Display IDs, row numbers, queue positions, short labels, and human-facing counters are derived presentation values only.

All operations, links, idempotency keys, route path parameters, persistence rows, and cross-document references MUST use stable IDs. For substrate document models this means PHIDs or explicit stable provider/source IDs that are mapped to PHIDs at the boundary.

Display IDs MAY be returned by read models for operator orientation, but they MUST NOT be accepted as operation targets and MUST NOT be used to infer joins. If a request provides a display-only ID where a stable ID is required, the API MUST reject it with a typed validation error.

## Acceptance-bar shorthand

The shorter line for use in per-package "Definition Of Done" / acceptance sections:

> RD-001 is enforced: every mutation target and cross-model link uses a stable ID/PHID; display IDs are visual only and are rejected as operation targets.

## Where RD-001 is encoded in this repo

| Package | Spec file | Stable ID | Display-only field | Typed rejection |
| --- | --- | --- | --- | --- |
| B9 — Task document model | [`b9-task-document-model.md`](./b9-task-document-model.md) | `task_phid` | `display_id` | `400 invalid_task_id` |
| B11 — Output review | [`b11-output-review.md`](./b11-output-review.md) | `artifact_id` | `display_id` | `400 invalid_artifact_id` |
| Event substrate | [`taskview-calendar-architecture.md`](./taskview-calendar-architecture.md) + [`calendar-event-substrate-sequencing.md`](./calendar-event-substrate-sequencing.md) | `event_phid` | `display_id` | `400 invalid_event_id` |
| RecurrenceTemplate | [`taskview-calendar-architecture.md`](./taskview-calendar-architecture.md) | `recurrence_phid` (+ `occurrence_key`) | `display_id` | rejected per scope |
| OP1 / P3 (precedent — already in CTO contract spec) | `cto/output/2026-06-09-kapelle-op1-p3-manager-contract-spec.md` | `decision_id`, `artifact_id`, `task_phid` | `display_id` | `400 invalid_decision_id` / `400 invalid_artifact_id` / `400 invalid_task_id` |

## Required cross-package acceptance tests (deferred to package implementation)

These are NOT implemented yet because B9 / B11 / Event / RecurrenceTemplate runtime packages have not shipped. They are listed here so they ride alongside each package's implementation PR:

1. Task mutation by `task_phid` succeeds; mutation by display title / row number / short label fails with `400 invalid_task_id`.
2. Artifact approve/read by stable `artifact_id` succeeds; display-row or filename-only target fails with `400 invalid_artifact_id`.
3. Decision decide by `decision_id` succeeds; `display_id` such as `#49` fails with `400 invalid_decision_id`.
4. Event update/cancel/link by `event_phid` succeeds; title / time-label / provider-summary target fails with `400 invalid_event_id`.
5. Recurrence template update by `recurrence_phid` succeeds; occurrence mutation requires `recurrence_phid + occurrence_key` or a materialized `event_phid` / `task_phid`.
6. Read DTOs may include `display_id`, but replay/reducer tests prove display fields can be null or recomputed without changing canonical state.

## Provenance

- Decision: Chris-ratified RD-001 / #49 (substrate principle).
- Scope doc: `cto/output/2026-06-09-rd001-spec-language-scope.md` (2026-06-09, CTO).
- Encoding pass: Roger dispatch `phid:disp-569b3b990e2c2e3d` (re-fire of `phid:disp-597ae82283fabb48`).
- Cross-package implementation order (from scope §"Implementation Order For Follow-Up Build"): B9 first (shared identity vocabulary), then B11, then RecurrenceTemplate (scoped occurrence identity), then Event (provider boundary + OP-9 DTO row language).
