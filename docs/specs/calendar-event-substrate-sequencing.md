# Calendar Event Substrate Approved Sequencing

> **Imported into id-agents 2026-06-10** from `cto/output/2026-06-09-calendar-event-substrate-approved-sequencing.md` with RD-001 (decision #49 — stable record identity is canonical; display IDs are derived; operations reference stable IDs only) encoded per `cto/output/2026-06-09-rd001-spec-language-scope.md`. RD-001 normative blocks live under the Required Event Scope bullet, the OP-9 Read-Only `/ops/calendar` row + DTO note, and the Cane Compatibility Hooks ICS UID extension. See `docs/specs/rd001-record-identity.md` for the cross-package summary.

Date: 2026-06-09
Author: cto
Task: `scope-calendar-event-substrate`
Manager query: `query_1781017710748_wc9jv5h`
Follow-up query: `query_1781019437006_6b4uz62`
Manager approval dispatch: `phid:disp-fd791350d857bfe2`
Manager approval query: `query_1781017710743_smy21cg`

## Approved Direction

Chris approved the Maestra/CTO calendar/Event substrate direction:

- Add `Event` to the Tier-1 task sweep proof-case scope alongside `Task`, `InboxItem`, and `Dispatch`.
- Use RFC 5545 `RRULE` for recurrence.
- Sequence `/ops/calendar` read-only view as OP-9, after OP-1.
- Defer external calendar sync and consistent ICS invite delivery until OP-9 and Tier-1 stabilize.

This confirms the narrowed technical recommendation in `output/2026-06-09-kapelle-calendar-technical-scope.md`: Tier-1 owns the canonical Event substrate and recurrence/linking rules, not the provider sync or invite-sending workstreams.

## Dispatch Sequence

### Tier-1 Task Sweep Proof Case

Add `Event` to the active Tier-1 substrate discovery/build scope:

```text
Task + InboxItem + Dispatch + Event
```

Required Event scope:

- document type and schema for canonical time-window objects;
- typed operations for create/update/cancel/archive/link/unlink/recurrence/provider-binding bookkeeping;
- RFC 5545 RRULE storage and write-time validation policy;
- bounded recurrence expansion contract for query APIs;
- explicit links to Task, InboxItem, Dispatch, and Artifact;
- provenance fields compatible with the existing B9 Task vocabulary;
- provider-binding fields only as future adapter metadata, not as sync behavior.
- RD-001 identity contract: canonical `event_phid`/`recurrence_phid` targets, provider/source IDs mapped at boundaries, display IDs derived only, and operation handlers rejecting display-only IDs.

Out of Tier-1 scope:

- direct Google/Microsoft/Apple/CalDAV sync;
- invite creation/sending/cancellation workflows;
- attendee response tracking;
- direct calendar editing UI.

### OP-1

Keep OP-1 ahead of calendar UI. OP-1 should stabilize the operator read path and manager-provided DTO discipline before `/ops/calendar` is introduced.

Calendar-related dependency to preserve during OP-1:

- manager APIs should return explicit source/freshness/provenance metadata so OP-9 can reuse the same pattern.

### OP-9 Read-Only `/ops/calendar`

After OP-1, dispatch OP-9 as a read-only operational calendar surface.

Required manager endpoint:

```text
GET /calendar/range?start=&end=&viewer_tz=&include=tasks,dispatches,cadences,risks,events
```

Required row producers:

- Task projection: due dates, scheduled windows, optionally visible snooze/defer rows;
- manager scheduler projection: dispatch fires and monitor runs, clearly not meetings;
- Maestra cadence projection;
- risk/date trigger projection;
- Event projection from Tier-1 Event docs;
- external busy/free rows only after later provider work, redacted by default.

OP-9 acceptance:

- read-only today/week rendering in `/ops/calendar`;
- no create/edit/delete event controls;
- no connect-calendar UX;
- no invite/send controls;
- manager-side bounded recurrence expansion into DTO rows;
- rows include timezone, status/cancelled state, source/provenance, stable `event_phid`, stable or scoped occurrence key, derived `display_id`, title, start/end, and related task/dispatch links.

OP-9 read DTOs may display provider IDs, ICS UID, and display IDs for operator orientation, but row actions and detail links must carry stable `event_phid` plus scoped occurrence identity where needed.

### Later Workstreams

Only after OP-9 plus Tier-1 stabilize:

1. External calendar sync adapters.
2. Consistent ICS invite delivery.
3. Attendee and response-state tracking.
4. Direct calendar event mutation UI.

## Coordination Notes

Regina has no OP-9 blocker. Regina's main sequencing requirement is to lock the OP-9 DTO early enough that the read-only UI can build against manager truth without coupling to future sync/invite behavior. Regina also prefers manager-side RRULE expansion over UI-side recurrence interpretation.

Cane has no substrate blocker and will keep the existing `cane.py event` surface as-is through OP-9 and Tier-1 stabilization. Cane will not add new calendar fields, attendee paths, or invite-delivery surfaces while substrate work is in flight.

Cane compatibility hooks to preserve for later dispatch:

- Event doc-model shadow-write path from existing `event`, `event-update`, and `event-cancel` calls, analogous to the Email shadow-write pattern.
- One-shot `cane events migrate` CLI to import `cane-data/events.json` into Reactor Event docs.
- Read-back support so OP-9 can render Cane-originated events from the Event substrate.
- Stable Cane ICS UID mapping into Event identity/provider binding, preserving update/cancel continuity. ICS UID is a provider/source identity used for resolution; once mapped, Event operations target `event_phid`, not the raw ICS UID.
- Explicit separation between task recurrence and Event recurrence. Cane's taskview recurrence tags remain simple markdown/taskview compatibility strings; Event recurrence uses RFC 5545 RRULE at the substrate boundary.

## Immediate Dispatch Recommendations

1. Amend the Tier-1 task sweep dispatch brief to include `Event` as a fourth proof-case document model. Completed in `output/2026-06-09-task-sweep-review-docmodel-slice.md` and `output/2026-06-09-task-sweep-review-tier1-architecture-slice.md`.
2. Add an Event/RRULE schema drafting dispatch before OP-9 implementation. Queue as `draft-event-rrule-schema`.
3. Add a manager `/calendar/range` DTO dispatch after OP-1 readiness is confirmed.
4. Add Regina OP-9 UI dispatch only after the DTO shape is accepted.
5. Add Cane compatibility dispatches for Event shadow-write/migration/read-back only after the Event schema is accepted.
6. Hold Cane external sync/ICS invite delivery expansion until OP-9 and Tier-1 Event substrate are stable.

## Queue Handoff

Use this dispatch order:

1. `draft-event-rrule-schema`: define `kilgore/event`, operation vocabulary, RFC 5545 RRULE validation, bounded occurrence expansion, exception handling, and Task/InboxItem/Dispatch/Artifact links.
2. `op1-operator-read-path`: finish OP-1 manager DTO/source/freshness discipline before any calendar UI dispatch.
3. `calendar-range-dto`: implement or specify manager-owned `GET /calendar/range` with task, dispatch, cadence, risk, and Event row producers.
4. `op9-calendar-readonly-ui`: Regina-owned read-only `/ops/calendar` surface against the accepted range DTO.
5. `cane-event-compat-hooks`: Cane-owned compatibility only after Event schema acceptance: shadow-write, migration, read-back, and stable ICS UID mapping.
6. Later, separate workstreams for external calendar sync, consistent ICS invite delivery, attendee response tracking, and direct mutation UI.

Guardrail: none of these queue entries should add provider OAuth, CalDAV/Google/Microsoft sync, attendee workflows, or invite-send behavior before OP-9 and Tier-1 stabilize.

## Approved Next Step

Chris approved this sequencing on 2026-06-09. Move from approved scope into queue with this order:

1. Tier-1 task sweep brief now reads `Task + InboxItem + Dispatch + Event`.
2. `draft-event-rrule-schema` lands before OP-9.
3. OP-1 remains ahead of OP-9.
4. OP-9 remains read-only.
5. Event substrate and Cane compatibility hooks are allowed; external calendar sync and ICS invite delivery stay deferred.
6. Cane coordination is limited to compatibility hooks that touch the cleanup/rebase branch. Calendar scope must not expand the Cane cleanup.

## Queue Status After Approval

Chris re-confirmed approval in manager dispatch `phid:disp-db5163cab7c5a08f` / query `query_1781019437004_wwcupvs`.

Current manager queue entries:

1. `draft-event-rrule-schema` - queued before OP-9.
2. `calendar-range-dto-after-op1` - queued after OP-1 readiness.
3. `op9-calendar-readonly-ui-after-dto` - queued after the range DTO is accepted; read-only only.
4. `cane-event-compat-hooks-after-schema` - queued after Event schema acceptance.

Chris explicitly liked finally seeing the Cane cleanup/rebase plan. Preserve that momentum: coordinate with Cane only where Event compatibility hooks touch the cleanup/rebase branch, and keep the cleanup branch focused on cleanup. Do not add external sync, ICS invite delivery, attendee tracking, or calendar UI mutation to Cane cleanup.
