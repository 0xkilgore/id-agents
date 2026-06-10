# Taskview Calendar Architecture Scope

> **Imported into id-agents 2026-06-10** from `cto/output/2026-06-09-taskview-calendar-architecture-scope.md` with RD-001 (decision #49 — stable record identity is canonical; display IDs are derived; operations reference stable IDs only) encoded per `cto/output/2026-06-09-rd001-spec-language-scope.md`. RD-001 normative blocks live under the CalendarEvent canonical model, the Event API section, the RecurrenceTemplate type, and the RecurrenceTemplate rules list. See `docs/specs/rd001-record-identity.md` for the cross-package summary.

Date: 2026-06-09
Task: scope-taskview-calendar-architecture
Owner: cto
Request: Chris asked CTO + Maestra to investigate how Kapelle/taskview should support calendar view in the UI, calendar integration, and calendar invites sent in a consistent format.

## Recommendation

Kapelle should add a calendar layer as a first-class operational surface, not as extra fields on Task and not as a clone of Google Calendar. The first slice should show time-bound work and meeting/invite state in Kapelle, preserve explicit Task links, and use Cane's current ICS invite module as the tactical producer while Kapelle defines the canonical model.

Build order:

1. Extend the Task substrate with explicit calendar bindings and recurrence refs.
2. Add a provider-neutral CalendarEvent / CalendarInvite document model.
3. Add `GET /calendar/today` and `GET /calendar/range` read APIs for Kapelle.
4. Convert Cane's `cane_calendar.py` events JSON / ICS send path into shadow-written CalendarInvite records.
5. Add a read-only Kapelle calendar lane before allowing direct Kapelle create/update/cancel actions.

## Existing Base

Relevant current system facts:

- Task B9 already separates `due_date`, `scheduled_for`, and `snoozed_until`; that distinction should stay.
- `KapelleToday` already exists as the intended dashboard DTO for Task, InboxItem, Dispatch, Artifact, and AgentOutput lanes.
- Manager/id-agents already has a lightweight task/calendar linking spec with `task_event_links` between tasks and manager `schedule_definitions`.
- The id-agents TUI has a Calendar view, but it is a scheduler/wakeup list, not a user calendar.
- Cane already sends calendar invites through `cane_calendar.py`, generating ICS REQUEST/CANCEL emails and storing event UID, sequence, attendees, status, location, description, start, and duration in `cane-data/events.json`.
- Kapelle's communication-layer notes already recommend provider-neutral records, approval state, attachments/artifact refs, and provider adapters for external messaging.

## Product Framing

Coordination status: CTO sent Maestra a synchronous framing request for product jobs, MVP/later split, UI expectations, and invite behavior. The request timed out after 120s with Maestra's reply still pending; CTO then sent the draft artifact path to Maestra asynchronously for follow-up review.

The UI should answer four operator questions:

1. What is scheduled today and this week?
2. Which tasks are tied to a time block, meeting, call, or reminder?
3. Which calendar invites are drafted, sent, accepted/declined, failed, cancelled, or stale?
4. What agent/task/output produced this invite or scheduled event?

The first Kapelle calendar surface should be an operational lane, not a full calendar app:

- Today rail: meetings, time blocks, due tasks, and scheduled agent wakeups.
- Week strip: time-bound work and invite state.
- Invite queue: draft / needs approval / sent / failed / cancelled.
- Detail drawer: attendees, location, description, provider status, ICS UID/sequence, linked Task/Inbox/Dispatch/Artifact refs, audit events.

Keep operator schedules visually distinct from external calendar events. A manager-owned `/schedule` wakeup that triggers an agent is not the same product object as a calendar invite sent to Chris or a third party.

## Canonical Model

Do not overload `TaskState` with provider fields. Add explicit calendar objects and link them to tasks.

Suggested documents:

```ts
type CalendarEvent = {
  event_phid: string;
  display_id: string | null; // derived/read-model only
  workspace_id: string;
  title: string;
  description_markdown: string | null;
  location: string | null;
  timezone: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  status: "draft" | "confirmed" | "tentative" | "cancelled";
  visibility: "private" | "workspace" | "external";
  source: "CANE" | "KAPELLE" | "MANAGER_SCHEDULE" | "PROVIDER_IMPORT" | "MIGRATION";
  source_ref: string | null;
  recurrence_ref: string | null;
  parent_event_phid: string | null;
  links: CalendarLinks;
  provider_bindings: ProviderBinding[];
  audit_events: CalendarAuditEvent[];
};

type CalendarInvite = {
  invite_phid: string;
  event_phid: string;
  method: "REQUEST" | "CANCEL" | "REPLY";
  sequence: number;
  state: "draft" | "needs_approval" | "approved" | "sending" | "sent" | "failed" | "cancelled";
  organizer: CalendarIdentity;
  attendees: CalendarAttendee[];
  subject: string;
  plain_body: string;
  ics_uid: string;
  ics_bytes_ref: string | null;
  provider_delivery: ProviderDelivery | null;
  approval: ApprovalState | null;
  audit_events: CalendarAuditEvent[];
};

type CalendarLinks = {
  task_phids: string[];
  inbox_item_phids: string[];
  dispatch_phids: string[];
  artifact_phids: string[];
  communication_record_phids: string[];
  manager_schedule_ids: string[];
};
```

RD-001 identity rule:

- `event_phid` is the canonical Event identity and the target for create/update/cancel/archive/link/unlink operations after creation.
- Provider IDs, ICS UID, manager schedule IDs, source refs, displayed times, and event titles are provenance or adapter metadata unless explicitly resolved to `event_phid`.
- `parent_event_phid`, linked Task/InboxItem/Dispatch/Artifact PHIDs, and recurrence refs are stable links only; they must not be inferred from title, time overlap, attendee names, or prose.
- `display_id` may appear in read models, but reducers and operation handlers MUST be correct if it is null or recomputed.

Task should add only link/summary fields:

```ts
type TaskCalendarFields = {
  calendar_event_phids: string[];
  primary_calendar_event_phid: string | null;
  recurrence_template_phid: string | null;
  recurrence_instance_key: string | null;
};
```

## API Shape

Manager/cell APIs:

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/calendar/today?viewer_tz=&owner=&include_schedules=true` | Calendar lane for Kapelle Today. |
| `GET` | `/calendar/range?start=&end=&viewer_tz=&owner=` | Week/month range query. |
| `GET` | `/calendar/events/:event_phid` | Event detail with links, provider bindings, invite history. |
| `POST` | `/calendar/events` | Create local event draft. Later slice. |
| `POST` | `/calendar/events/:event_phid/link-task` | Link event to Task PHID. |
| `POST` | `/calendar/invites` | Generate invite draft from event. |
| `POST` | `/calendar/invites/:invite_phid/approve` | Approve outbound invite. |
| `POST` | `/calendar/invites/:invite_phid/send` | Send through provider adapter. |
| `POST` | `/calendar/events/:event_phid/cancel` | Generate cancellation invite and mark event cancelled. |
| `GET` | `/calendar/provider-sync/status` | Adapter freshness and drift. |

RD-001 API rule:

- `:event_phid` path parameters are stable Event PHIDs.
- Link/unlink endpoints require stable linked PHIDs, such as `task_phid`, not task titles or displayed calendar labels.
- Provider-originated updates may carry provider IDs or ICS UID only as resolution inputs. The manager must resolve or create the stable `event_phid` before appending Event operations.
- Requests using display IDs, event titles, visible time labels, list positions, or provider summary text as mutation targets must return `400 invalid_event_id`.

Kapelle frontend proxy:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/calendar/today` | Read-only Today calendar lane. |
| `GET` | `/api/calendar/range` | Week strip / calendar page data. |
| `GET` | `/api/calendar/events/:event_phid` | Detail drawer. |
| `POST` | `/api/calendar/actions` | Later wrapper for draft/send/cancel/link. |

All responses should include `source`, `generated_at`, `viewer_tz`, and provider freshness metadata. Public demo fixtures must be labeled; private `/ops` should prefer explicit degraded state over fake calendar data.

## Provider Integration

Keep provider APIs behind adapters. The product model should never depend on Google/Microsoft/ICS object shapes.

Adapter contract:

```ts
interface CalendarProviderAdapter {
  provider: "ics_email" | "google" | "microsoft" | "caldav";
  createOrUpdateEvent(event: CalendarEvent, invite: CalendarInvite): Promise<ProviderDelivery>;
  cancelEvent(event: CalendarEvent, invite: CalendarInvite): Promise<ProviderDelivery>;
  readEvents(range: CalendarRange): Promise<ProviderEventPage>;
  readResponses(event: CalendarEvent): Promise<CalendarResponseUpdate[]>;
}
```

First adapter should be `ics_email`, reusing Cane's working behavior:

- generate RFC 5545 ICS with UID, sequence, organizer, attendees, status, DTSTART/DTEND, description, location;
- send as inline `text/calendar` plus `.ics` attachment;
- store provider delivery metadata;
- shadow-write event/invite records from Cane's existing JSON store;
- preserve update/cancel semantics by incrementing sequence on the same UID.

Later adapters:

- Google Calendar API for direct event insertion and response sync.
- Microsoft Graph for Outlook calendars.
- CalDAV only if local-first provider support becomes important.

## Invite Generation

Use a single invitation formatter for all outbound calendar invites:

- Subject prefixes: `Invite:`, `Updated:`, `Cancelled:` as today, unless product copy changes.
- Organizer identity comes from workspace policy: `cane@caneyfork.dev` for current Cane path; later user/workspace/agent identities.
- Plain body should include title, date/time with timezone, duration, location, note, and Kapelle provenance footer only for internal/workspace recipients.
- ICS generation must be deterministic for the same event/version: stable UID, incrementing sequence, explicit timezone, explicit attendee RSVP fields.
- Every invite generation writes an audit event before send.
- External sends should pass through approval policy unless recipient/domain is explicitly trusted.

Do not let each agent hand-roll ICS, subject lines, attendee rules, or cancellation copy.

## Recurring Task Implications

Recurring tasks and recurring calendar events need separate templates.

Recommended model:

```ts
type RecurrenceTemplate = {
  recurrence_phid: string;
  display_id: string | null; // derived/read-model only
  kind: "task" | "calendar_event" | "schedule_prompt";
  timezone: string;
  rrule: string;
  starts_on: string;
  ends_on: string | null;
  exception_dates: string[];
  source_ref: string | null;
  template_task_phid: string | null;
  template_event_phid: string | null;
};
```

RD-001 identity rule:

- `recurrence_phid` is the canonical identity for a recurrence template.
- `template_task_phid` and `template_event_phid` are stable links to the template owner records.
- Occurrence keys are derived expansion identifiers scoped under `recurrence_phid`; they are valid for read DTOs and exception operations only when paired with `recurrence_phid`.
- Human labels such as "weekly standup", displayed sequence numbers, and provider recurrence summaries are not operation targets.

Rules:

- A recurring task template creates task instances; completing one instance must not complete the series.
- A recurring calendar template creates event occurrences; changing one occurrence creates an exception instance.
- A task can be linked to one occurrence, the whole series, or both, but this must be explicit.
- `due_date` still means deadline. A recurring meeting occurrence should not turn into a task due date unless the operator or automation creates a linked follow-up task.
- Snooze applies to one task instance by default. Snoozing the recurrence template is a separate operation.
- Imported provider recurring events should store RRULE and exception metadata but should not eagerly materialize an unbounded number of Task documents.
- Updating, snoozing, pausing, resuming, or cancelling a recurrence template MUST target `recurrence_phid`.
- Mutating a single occurrence MUST target `recurrence_phid + occurrence_key` or a materialized `event_phid`/`task_phid`; it MUST NOT target a displayed occurrence number.
- Provider RRULE strings are recurrence semantics, not record identity.

## UI Shape

MVP Kapelle UI:

- Add a Calendar band to `/ops` / Today that displays next 24 hours plus a compact this-week strip.
- Use four row types: event, invite, due task, scheduler prompt.
- Show provenance on every row: task/inbox/dispatch/artifact/source.
- Show invite state badges: draft, needs approval, sent, failed, cancelled.
- Allow detail drawer; defer direct mutation buttons until records and provider adapter are stable.

Later:

- Week/day calendar grid.
- Drag/drop reschedule only after provider update/cancel is reliable.
- Create event from Task, InboxItem, Output, or Dispatch.
- Batch "send calendar invites" flow for agent-generated plans.

## Migration / Implementation Slices

1. Calendar substrate spec and mirror tables.
   - Add CalendarEvent, CalendarInvite, ProviderBinding, RecurrenceTemplate schemas.
   - Add event/task link table keyed by PHIDs and provider ids.

2. Cane shadow producer.
   - Patch `cane_calendar.py` create/update/cancel to emit CalendarEvent and CalendarInvite records.
   - Import existing `cane-data/events.json` idempotently by ICS UID.

3. Read APIs.
   - Implement `/calendar/today` and `/calendar/range`.
   - Include manager schedule rows only when `include_schedules=true` and label them as scheduler prompts.

4. Kapelle read-only lane.
   - Add calendar band to Today/ops surface.
   - Render event/invite/task/schedule rows with provenance and degraded source labels.

5. Invite draft/send consolidation.
   - Move ICS generation into shared formatter.
   - Keep Cane CLI compatible but backed by shared records.

6. Provider sync pilot.
   - Start with ICS email send.
   - Add Google/Microsoft only after record shape and UI lane are stable.

## Risks

- Provider lock-in: solved by adapter boundary and canonical records.
- Calendar vs scheduler confusion: solved by separate row types and explicit labels.
- Recurrence explosion: solved by templates and bounded materialization.
- Timezone bugs: every query and record needs explicit timezone; default Chris-facing views to `America/Chicago`, but never rely on host-local time.
- Privacy: invite attendees and locations may be sensitive; Kapelle public/demo views must redact or fixture them.
- Partial external truth: ICS email sends do not give reliable acceptance state. Mark response sync as unknown unless a provider adapter can read it.

## Open Product Questions For Maestra / Chris

- Should the first calendar surface optimize for Chris's personal day view, team/agent operations, or outbound invite workflow?
- Are calendar invites mostly personal/family, business/external, or agent/team internal?
- Should Kapelle show accepted/declined status as a must-have, or is sent/failed enough for the first slice?
- Which identities are allowed to organize invites: Cane, Chris, workspace, or agent-specific addresses?
- Should an agent be allowed to draft an invite without approval, and under what recipient/domain policy?

## Dispatch Recommendation

Title: `Kapelle calendar read lane and Cane invite shadow records`

Scope:

- Define CalendarEvent / CalendarInvite / RecurrenceTemplate records.
- Import existing Cane event JSON into records.
- Shadow-write Cane event create/update/cancel into records.
- Add `/calendar/today` read API.
- Add read-only Kapelle calendar lane with event/invite/task/scheduler row types.

Acceptance:

- Existing `./cane.py event ...` behavior still works.
- New event produces stable event/invite records with UID and sequence.
- Update/cancel modifies the same event lineage.
- `/calendar/today?viewer_tz=America/Chicago` returns deterministic rows.
- Kapelle renders calendar rows with provenance and source/freshness labels.
- No direct Kapelle calendar mutation ships until provider send/cancel and approval policy are tested.
