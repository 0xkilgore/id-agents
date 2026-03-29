# Lightweight Task System Spec

## Purpose

Provide a simple task-management layer for `id-agents` so a manager can assign work, agents can claim and complete work, tasks can move between teams, and tasks can be linked to calendar events.

This system is intentionally lightweight. It is not Jira, not a project-management suite, and not a workflow engine. It should fit a team of about 10 agents and support fast coordination with minimal ceremony.

## Goals

- Let the manager create and assign short-lived operational tasks.
- Let agents create tasks when work is discovered during execution.
- Let agents claim unassigned tasks and complete assigned tasks.
- Let tasks be linked to one or more calendar events, and calendar events link back to one or more tasks.
- Keep the state model small, readable, and easy to audit.

## Non-Goals

- No epics, sprints, story points, priorities, labels, or custom workflows.
- No comments, attachments, subtasks, watchers, or approvals in v1.
- No attempt to replace full project management software.

## Core Model

The system has two primitives:

1. `task`
2. `task_event_link`

`task` represents a unit of work for one agent at a time. Tasks are global, not scoped to a team.

`task_event_link` represents a many-to-many relationship between tasks and calendar events. A task may relate to zero or more calendar events. A calendar event may relate to zero or more tasks.

## Task Fields

Each task should support:

- `name`: short human-friendly slug, lowercase with hyphens, similar to a GitHub branch name; globally unique; auto-generated from `title` if not provided
- `team`
- `title`
- `description` (optional)
- `status`: `todo`, `doing`, `done`
- `created_by`
- `owner` (optional; set by assignment or claim)
- `created_at`
- `updated_at`
- `completed_at` (optional)

The model should stay minimal. Fields should exist only if they serve assignment, claiming, completion, or calendar linking.

## Status Model

- `todo`: task exists and is not yet being worked
- `doing`: task has been claimed or directly assigned and is in progress
- `done`: task has been completed

No additional statuses are in scope for v1.

## User Stories

### Manager assigns task

As a manager, I want to create a task and assign it to an agent so work is clearly owned.

### Agent claims task

As an agent, I want to claim an unassigned task so I can take responsibility for work without manager intervention.

### Agent completes task

As an agent, I want to mark a task done so the manager and other agents can see that work is finished.

### Tasks link to calendar events

As a manager or agent, I want to link tasks to calendar events so scheduled work and task tracking stay connected.

## Functional Requirements

### Task creation

- The system must allow the manager to create a task.
- The system must allow an agent to create a task via the manager API.
- A task must be creatable with at least a title.
- A task may optionally be created with a description, team, and owner.
- A newly created unassigned task must start as `todo`.
- A newly created owned task may start as `todo` or transition immediately to `doing`; v1 should prefer immediate `doing` to reflect ownership.

### Task listing

- The system must provide a simple list view of tasks.
- The list must support filtering by status.
- The list must support filtering by owner.
- The list must support filtering by team.
- The list should be readable in CLI form for daily use by a team of 10 agents.

### Assignment and claiming

- The manager must be able to assign a task to an agent.
- An agent must be able to claim an unassigned task via the manager API.
- Assignment or claiming must set `owner`.
- Both `owner` and `team` must be updatable.
- A claimed or assigned task must be in `doing`.
- An agent should not be able to claim a task already owned by another agent without manager action.

### Completion

- An agent must be able to mark its own task as done via the manager API.
- The manager should be able to mark any task as done.
- Completing a task must set status to `done` and record completion time.
- A completed task must remain visible in task listings unless explicitly filtered out.

### Calendar linking

- The system must support linking an existing task to an existing calendar event.
- The system must support multiple links for the same task.
- The system must support multiple tasks linked to the same calendar event.
- Removing a link must remove only the relationship, not the task or the calendar event.
- Tasks should be viewable with their linked calendar event references.
- When a calendar event fires, the agent handling that event must receive the linked task titles and statuses as context.

### API responsibility

- Agents must create, claim, and complete tasks through the manager API.
- The manager API is the source of truth for task state transitions.
- Direct per-agent task-state mutation is out of scope.

## CLI Surface

The CLI must expose:

- `/task create`
- `/task list`
- `/task assign`
- `/task done`
- `/task remove`

CLI behavior should remain intentionally narrow:

- `/task create` creates a task, optionally with `name`, `team`, `owner`, and calendar links. If `name` is omitted, it is generated from `title`.
- `/task list` shows tasks with status and owner.
- `/task assign <task-name> <agent>` assigns a task by name to an agent, for example `/task assign fix-overflow contracts`.
- `/task done <task-name>` marks a task done by name, for example `/task done rate-limit`.
- `/task remove <task-name>` deletes a task by name.

Agent claim behavior may be implemented through manager API first and later exposed in CLI if needed, but claim semantics are required even if there is no dedicated `/task claim` command in v1.

## Acceptance Criteria

- A manager can create a task from the CLI and see it in `/task list`.
- A task has a globally unique `name`; if omitted at creation time, the system generates one from the task title.
- A manager can assign a task to an agent and the task shows that agent as owner.
- A manager can update a task's `owner` or `team`, including moving the task between teams.
- CLI task-targeting uses task names rather than numeric IDs, such as `/task assign fix-overflow contracts` and `/task done rate-limit`.
- An agent can create a task through the manager API.
- An agent can claim an unassigned task through the manager API and the task moves to `doing`.
- An agent can complete its own task through the manager API and the task moves to `done`.
- The manager can complete any task.
- `/task list` can show `todo`, `doing`, and `done` tasks.
- `/task remove` deletes the task.
- A task can be linked to multiple calendar events.
- A calendar event can be linked to multiple tasks.
- Deleting a task-event link does not delete the underlying task or calendar event.
- When a calendar event fires, linked task titles and statuses are included in the agent context.
- The spec remains lightweight enough for a 10-agent team to use daily without extra workflow configuration.

## Design Principles

- Prefer simple commands over rich configuration.
- Prefer explicit ownership over complex collaboration states.
- Prefer manager-controlled state transitions over distributed writes.
- Prefer easy auditability over feature breadth.
