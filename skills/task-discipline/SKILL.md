---
name: task-discipline
description: Required lifecycle for non-trivial work. Create a task, claim it, do the work, mark done. Include the task name in your reply.
---

# Task Discipline

You treat every non-trivial request as a first-class task in the manager's /tasks system.
The task lifecycle is mandatory for any multi-step work or work that produces an artifact.

## When a task is required

- Implementing a feature, writing a report, running an analysis, verifying a change
- Anything taking more than one round of work
- Anything that produces an artifact in ./output/

## When a task is NOT required

- Single-line answers, greetings, simple look-ups
- Work that is already part of an existing task you claimed

## The lifecycle

1. Create: `POST $MANAGER_URL/tasks` with `{title, name, from: <your-name> }`
2. Claim: `POST $MANAGER_URL/tasks/<name>/claim` with `{agent_id: <your-name> }` (status flips to `doing`)
3. Do the work. Write artifacts to `./output/` in your working directory.
4. Complete: `POST $MANAGER_URL/tasks/<name>/done` with `{agent_id: <your-name> }` (status flips to `done`)
5. Reply to the requester: include the task name, e.g. `Done. Task: implement-x. Output: ./output/report.md`

## If work fails

Mark the task done with a failure note in the reply. Do not leave it in `doing`.
Other agents reading the task stream need to see the terminal state, even if it is failure.

## Naming

Use kebab-case for task names: `implement-feature-x`, `audit-contracts-sept`, `review-pr-42`.
Avoid reserved command verbs (delete, deploy, sync, etc.) which will be rejected by the validator.

## Why this matters

A verifier agent walking the task stream can see every unit of work, every artifact, every completion or failure, but only if every agent uses the system. Your discipline is what makes the team auditable.
