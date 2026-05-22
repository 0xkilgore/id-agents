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

Write any generated files (reports, analysis, code artifacts) to \`./output/\` in your working directory. Other agents can read these artifacts via \`/artifact\`.

## Blocked on a clarification — Spec 054 v2

If you cannot safely continue because the dispatch is ambiguous, blocked on a choice, or would require guessing at operator intent, call \`POST /agent-needs-input\` with the manager \`dispatch_id\`, a concise question, and the context needed to answer it. Do NOT only write the question in chat/session text — the manager cannot see it there.

### Where to find your \`dispatch_id\`

Every scheduler-launched \`/talk\` carries the canonical dispatch metadata in two places. Use whichever your harness exposes:

1. **JSON body fields** \`dispatch_id\` and \`query_id\` on the inbound \`/talk\` request.
2. **A visible metadata block at the top of the message body**, like:

   \`\`\`text
   [dispatch_id: phid:disp-abc123...]
   [query_id: query_1779...]

   <the actual dispatch body>
   \`\`\`

If you only see the prompt text (Claude-CLI sessions), parse the \`[dispatch_id: ...]\` line from the top of the message.

After the endpoint succeeds, stop work and wait for resume. The manager will respond via \`POST /agent-resume\`, which arrives as a follow-up \`/talk\` message referencing your original \`dispatch_id\`.

Minimal call:

\`\`\`bash
curl -sS -X POST "$MANAGER_URL/agent-needs-input" \\
  -H 'content-type: application/json' \\
  -d '{
        "dispatch_id":"<dispatch_id from your /talk metadata>",
        "agent_id":"<your-name>",
        "question":"<one-line direct question the manager can answer>",
        "context":{
          "summary":"...",
          "did_so_far":["..."],
          "blocking_reasons":["..."],
          "options":["..."],
          "recommended_option":"..."
        },
        "urgency":"normal"
      }'
\`\`\`

When to call:
- Surprise scope vs. what the dispatch described (e.g. branch is far ahead of main, repo structure differs).
- Two valid implementation paths and the spec does not decide between them.
- Pre-flight detects state that would make a destructive action ambiguous (uncommitted work, divergent branches, missing infrastructure).

When NOT to call:
- The decision is yours to make per the dispatch ("use your judgment"). Make it.
- Minor style/format choices internal to the implementation. Pick and ship.

After a successful response, your job is to STOP and wait. Do not keep working on a guess. Plain-text "standing by" replies are NOT acceptable - the manager's only canonical signal that you are blocked is the \`POST /agent-needs-input\` call.`;
