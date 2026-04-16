// SPDX-License-Identifier: MIT
/**
 * Framework protocol defaults injected into every agent's CLAUDE.md at spawn time.
 *
 * These rules make an id-agents worker different from a plain Claude Code session:
 * scheduling awareness, task-discipline lifecycle, and the output convention.
 * Users never edit these in YAML — they are managed by the framework.
 */

export const PROTOCOL_DEFAULTS = `## Scheduling

This system has a manager-owned scheduler.

Scheduled work may arrive as:
- \`from: "schedule"\` on \`/talk\`
- \`from: "schedule"\` with \`mode: "internal"\` on \`/schedule\`

Treat \`/schedule\` as an internal wake-up / self-directed task trigger, not as a normal external conversation.

When scheduled work arrives:
- inspect the \`schedule\` object for \`id\`, \`kind\`, \`title\`, and \`scheduledKey\`
- treat \`mode: "internal"\` as autonomous work you should begin without framing it as a user request
- do not assume a reply is expected just because scheduled work was triggered
- use the schedule metadata in your reasoning and logs when it is relevant

## Task Discipline

Every non-trivial unit of work MUST go through the task lifecycle.

### When a task is required
- Any multi-step work (implement, audit, report, verify, refactor)
- Anything that produces an artifact in \`./output/\`
- Anything taking more than one round of tool use

### When a task is NOT required
- Single-line answers, greetings, simple look-ups
- Work that is already part of an existing task you claimed

### Lifecycle
1. **Create**: \`POST $MANAGER_URL/tasks\` with \`{ title, name, from: "<your-name>" }\`
2. **Claim**: \`POST $MANAGER_URL/tasks/<name>/claim\` with \`{ agent_id: "<your-name>" }\`
   Status flips to \`doing\`.
3. **Work**: Do the work. Write artifacts to \`./output/\`.
4. **Done**: \`POST $MANAGER_URL/tasks/<name>/done\` with \`{ agent_id: "<your-name>" }\`
   Status flips to \`done\`.
5. **Reply**: Include the task name in your response, e.g.
   \`Done. Task: implement-x. Output: ./output/report.md\`

### Failure handling
Mark the task done with a failure note. Never leave a task in \`doing\`.
Other agents reading the task stream need to see a terminal state.

### Naming
Use kebab-case: \`audit-contracts-apr\`, \`review-pr-42\`, \`write-report-q2\`.
Avoid reserved command verbs (delete, deploy, sync, etc.).

### Why this matters
A verifier walking the task stream can see every unit of work, every
artifact, every completion or failure — but only if every agent uses
the system. Your discipline makes the team auditable.

## Output Convention

Write any generated files (reports, analysis, code artifacts) to \`./output/\` in your working directory. Other agents can read these artifacts via \`/artifact\`.`;
