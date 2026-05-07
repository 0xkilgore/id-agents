# Dashboard Task Visibility — Design Spec

**Date:** 2026-05-06  
**Author:** cto  
**Status:** approved for plan-writing  
**Target ship date:** 2026-05-15

## Decision

Approve. This is ready to become a build spec.

The brief identifies a real product failure, not just a polish gap: the dashboard no longer exposes Chris's actual task system, so it fails its primary job of answering "what am I doing today?" The implementation should proceed as a single **Phase 3 task-visibility release** with internal sequencing, not as a speculative brainstorm branch.

## Why approve

Three things are already clear enough to spec:

1. `build.py` already computes canonical task buckets from per-project `to-do.md` files (`due_today`, `overdue_high`, `overdue_med_low`, `due_this_week`).
2. The overview UI is currently rendering only `curation.today_priorities`, so the dashboard can look "empty" even when the underlying task projection is full.
3. The app already has a route-based shell (`/`, `/agents`, `/dispatches`, `/inbox`, `/calendar`, `/vault`) and a search surface, so project task visibility should extend that architecture rather than fight it.

Separately, the usage donuts are not a simple CSS bug. The current `/api/usage` route reads `~/.claude/projects` and `~/.codex/sessions` from the local filesystem, which is not a reliable production data source for a Vercel-hosted dashboard. That requires a data-pipeline fix and a UI redesign together.

## Product Goal

Make the dashboard the first place Chris can answer four questions:

1. What must I do today?
2. Where are the rest of my project tasks?
3. What are my agents doing right now?
4. Am I close to a Claude or Codex usage limit?

This release is successful when the dashboard exposes the real task system without requiring terminal-only `taskview` usage.

## Scope

In scope:

- Restore a trustworthy Today surface backed by canonical task data.
- Add navigable per-project task views.
- Upgrade fleet visibility from counts to active work.
- Replace the broken usage donuts with a durable multi-ring usage surface.
- Preserve compatibility with the just-shipped Phase 2 shell and header work where possible.

Out of scope:

- Full dashboard migration onto Vetra documents.
- Replacing markdown `to-do.md` as the write-side source of truth.
- Mobile-first task entry.
- Calendar redesign.

## Decisions On The Open Questions

### 1. Restore Today first vs one Phase 3 release

Ship this as **one Phase 3 release** with strict internal sequencing:

1. Restore canonical Today visibility.
2. Add project navigation and project detail routes.
3. Upgrade fleet work visibility.
4. Replace usage donuts and data source.

Reasoning: the bug is not only that Today is empty. The broader problem is that tasks are non-navigable even when the data exists. Shipping only the Today fix would still leave the system feeling invisible one click later.

### 2. Routes vs drawers for per-project views

Use **routes for project views**: `/projects/[slug]`.

Reasoning:

- The app shell is already route-oriented.
- Project task lists are durable destinations, not ephemeral overlays.
- Routes support direct links, refresh, back/forward navigation, and future saved filters.
- A drawer is still appropriate for task detail or inline edit from within a project page, but not as the primary project surface.

### 3. Does `/agents` already return current task?

No. The manager's `/agents` response currently returns roster and metadata, not a first-class `current_task` field.

For this release:

- Do **not** block the dashboard build on Prem.
- Build a dashboard-side projection from dispatch/task/check-in state for now.
- In parallel, send Prem a follow-up request for richer `/agents` data:
  - `current_task_title`
  - `current_task_started_at`
  - `current_task_status`
  - `waiting_on_human`
  - latest check-in summary

If Prem exposes that during the build window, the dashboard can swap to it without changing the UI contract.

### 4. Interaction with Phase 2 work

Treat this as an extension of Phase 2, not a rewrite.

- Keep the current app shell, left nav, refresh semantics, and data-provider model.
- Replace the fleet stats line and usage widget in-place rather than redesigning the whole header again.
- Preserve `curation` as an overlay signal, but stop treating it as the only Today source.

### 5. Use this as the first read-side Vetra prototype?

Yes, but only as a **read-side seam**, not as a dependency for this ship.

Guidance:

- Keep tasks sourced from markdown `to-do.md`.
- Keep fleet activity sourced from manager/SQLite/check-in projections.
- Define UI-facing data contracts so a later Vetra-backed projection can slot in behind them.

This release should be Vetra-compatible, not Vetra-blocked.

## UX Shape

### Surface 1: Today

Replace the current "Focus = manager curation only" behavior with a true Today surface composed from two layers:

1. **Pinned Today**
   Source: `curation.today_priorities`
   Purpose: manager-selected "big things" and synthesized priorities.

2. **Canonical Tasks**
   Source: `todos.due_today`, `todos.overdue_high`, `todos.overdue_med_low`, `todos.due_this_week`
   Purpose: expose the actual task system even when curation is stale, sparse, or wrong.

Behavior:

- Pinned Today renders first.
- Canonical Tasks render immediately below, grouped as:
  - Overdue high priority
  - Due today
  - Due this week
- Every task row shows project chip, due state, priority state, and actions.
- Clicking the project chip routes to `/projects/[slug]`.
- `Done` and `Snooze` continue using the existing mutate path.

Empty state rule:

- The Today surface is only "empty" when both curation and canonical task buckets are empty.
- If curation is empty but canonical tasks exist, show the tasks and a subtle note that no curated priorities are pinned.

### Surface 2: Project task views

Add project routes:

- `/projects`
- `/projects/[slug]`

Project page requirements:

- Show all open tasks for the project.
- Group by overdue, today, this week, later, unscheduled.
- Allow inline search/filter within the project.
- Preserve mutate actions: done, snooze, kill if already supported.
- Link to the underlying `to-do.md` file via Obsidian when available.

Overview integration:

- Add a Projects section or rail on the overview showing each project with open-task count.
- Clicking a project always routes to its project page.

### Surface 3: Fleet work visibility

The overview header and/or fleet tile should answer "what are my agents doing?" not just "how many are active?"

UI requirements:

- Each active agent card shows current work title, start time/age, and state.
- Agents needing human review or approval should visually rise above idle agents.
- Roster metadata such as port and capabilities should move to secondary surfaces (`/agents` detail or expanded view), not dominate the overview.

Minimum row/card fields:

- agent name
- state: working, blocked, waiting, idle
- current work title
- started at / age
- latest human-needed status if present

Do not require exact realtime streaming for this release. Poll/refresh-based projection is acceptable if it is accurate enough to be useful.

### Surface 4: Cross-project search

Keep the existing search entry point and explicitly extend it to support task discovery as a first-class flow.

Requirements:

- Search must include all project `to-do.md` files.
- Search must return project-scoped results that link into `/projects/[slug]` when appropriate.
- Searching tags, names, or project identifiers must be faster than dropping to terminal `taskview`.

### Surface 5: Usage rings

Replace the current mini-donuts with a single, prominent Apple-Activity-style multi-ring widget.

Claude rings:

- outer: weekly budget
- middle: daily budget
- inner: 5-hour session/rate-limit window

Codex:

- separate adjacent ring cluster unless a unified composition is visually cleaner
- at minimum: daily and weekly

Hover/click detail:

- tokens used / budget
- percentage
- reset time / time remaining

This should be a headline visual element in the header, not a tucked-away 34px ornament.

## Data Contract Changes

Add a new UI-facing projection for Today so the frontend stops assembling meaning from unrelated fields ad hoc.

Suggested top-level additions:

```json
{
  "today_surface": {
    "pinned": [],
    "overdue_high": [],
    "due_today": [],
    "due_this_week": [],
    "last_built_at": "iso8601"
  },
  "projects_index": [],
  "usage": {
    "claude": {
      "window_5h": { "used": 0, "budget": 0, "resets_at": "iso8601" },
      "day": { "used": 0, "budget": 0, "resets_at": "iso8601" },
      "week": { "used": 0, "budget": 0, "resets_at": "iso8601" }
    },
    "codex": {
      "day": { "used": 0, "budget": 0, "resets_at": "iso8601" },
      "week": { "used": 0, "budget": 0, "resets_at": "iso8601" }
    },
    "source": "m4-snapshot"
  }
}
```

Also extend `agents_progress` to support work visibility:

- `current_task_title`
- `current_task_started_at`
- `waiting_on_human`
- `latest_checkin_summary`

These may be populated by dashboard-side projection initially even if the manager API does not yet expose them.

## Data Source Architecture

### Tasks

Keep `taskview` and per-project `to-do.md` as source of truth.

Implementation rule:

- Reuse the existing `collect_todos()` / taskview logic.
- Do not duplicate parsing logic in the frontend.

### Agent work

Primary source order:

1. manager API if richer current-task fields land in time
2. manager DB projection from dispatch/task rows
3. check-in stream / latest known activity summary

The dashboard may synthesize a best-effort `current task` string during this release, but that logic should live in one projection layer, not spread through React components.

### Usage

Do not rely on a Vercel route reading the laptop filesystem.

Required architecture:

- usage snapshot is generated on the machine that has access to Claude/Codex local session data
- snapshot is written into a durable file consumed by `build.py` and merged into `data.json`
- header reads the merged static/live-compatible shape

Acceptable implementation:

- an M4 or manager-side snapshot job writes `usage.json`
- `build.py` merges `usage.json`
- frontend uses `data.usage` as primary source
- optional live fetch can remain as enhancement, not as the only prod path

## Implementation Notes

- Keep `curation.json` as a durable overlay, but stop using it as the sole Today contract.
- Introduce project routes in the existing Next app rather than adding another dashboard mode.
- Avoid a large frontend rewrite. This should be additive and contract-driven.
- If schedule pressure hits, cut animation and sparkline before cutting the core visibility surfaces.

## Phasing Inside The Release

### Slice A: Today visibility

- Add `today_surface` projection.
- Update overview to render canonical tasks beneath pinned curation.
- Ensure empty state is truthful.

### Slice B: Project navigation

- Add `/projects` and `/projects/[slug]`.
- Add overview entry points from project chips and project list.

### Slice C: Fleet work visibility

- Enrich `agents_progress`.
- Update overview fleet tile/header to show work, not just counts.

### Slice D: Usage rings

- Replace the current prod-broken usage path with snapshot-backed data.
- Implement multi-ring UI.

## Acceptance Criteria

- The overview never reports an empty Today surface when canonical tasks exist.
- A user can navigate from the dashboard into a specific project's full task list without using terminal tools.
- Agent cards and/or header surface what active agents are doing right now in human-readable form.
- Usage rings render reliably in production without depending on Vercel reading local Claude session files.
- The release does not break existing refresh, mutate, inbox, or calendar surfaces.

## Risks

- The biggest risk is scattering projection logic across React components instead of centralizing it in build/API layers. Do not do that.
- The second risk is waiting on Prem for richer `/agents` fields. Do not block the release on that.
- The third risk is treating the usage redesign as pure UI work. It is a data-pipeline fix first.

## Recommended Build Branch

`dashboard-phase-3-task-visibility`

## Follow-Up After This Spec

1. Manager reviews this spec with Chris.
2. CTO writes the implementation plan.
3. Roger builds in one branch with slices A-D above.
4. CTO reviews shipped output against this spec before Chris sees it.
