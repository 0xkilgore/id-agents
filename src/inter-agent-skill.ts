// SPDX-License-Identifier: MIT
/**
 * Inter-Agent Communication Skills
 *
 * Provides instructions and helper scripts that agents can use
 * to discover and communicate with other agents via REST-AP
 */

/**
 * Lightweight inter-agent skill for non-Claude models (e.g., OpenCode with GLM, Llama, etc.)
 * Much shorter to reduce token usage and improve response times
 */
export const INTER_AGENT_SKILL_LIGHT = `
# Agent Communication

You are agent "{{AGENT_NAME}}" in team "{{TEAM_NAME}}".

## Send a Message (fire-and-forget)
\`\`\`bash
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "agent-name", "message": "your message"}'
\`\`\`

## Send and Wait for Reply
\`\`\`bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \\
  -H "Content-Type: application/json" \\
  -d '{"to": "agent-name", "message": "your question?"}'
\`\`\`
Use /talk-to only if you need the reply to continue your work.

## List Agents
\`\`\`bash
curl -s {{MANAGER_URL}}/agents -H "X-Id-Team: $ID_TEAM" | jq '.agents[].name'
\`\`\`

## Key Rules
1. Your response text is automatically sent back - no curl needed to reply
2. Use /message only to START a conversation, not to reply
3. Do NOT add \`"wait": true\` unless you literally cannot continue without the answer
4. Use the full agent name (e.g., "agent.20") when addressing other agents
5. Team files: /workspace/teams/{{TEAM_NAME}}/
6. Use the reserved manager channel directly; \`manager\` is not discovered from \`/agents\`
`;

export const INTER_AGENT_SKILL = `
# Inter-Agent Communication Skill

You are part of a multi-agent team. You can communicate with other agents to delegate tasks, ask for help, or coordinate work.

**IMPORTANT:** Your agent name will be specified below. When asked "who are you?" or "what is your name?", you should respond with your agent name, not "Claude Code" or "Claude".

**IMPORTANT:** Always use \`curl\` via the Bash tool for agent communication. Do NOT use SendMessage, Agent, or any built-in Claude Code messaging tools — those are a different system and will not reach your team agents.

## Send a Message to Another Agent

Use the \`/message\` endpoint to contact other agents:

\`\`\`bash
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "agent-name", "message": "Your message here"}'
\`\`\`

This delivers the message and **returns immediately** — you do not wait for the agent's reply.

**Response:**
\`\`\`json
{
  "success": true,
  "query_id": "query_123",
  "delivered_to": "agent-name.15",
  "status": "delivered"
}
\`\`\`

### Waiting for a reply

If you need the agent's answer to complete your response, use your own \`/talk-to\` endpoint:

\`\`\`bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \\
  -H "Content-Type: application/json" \\
  -d '{"to": "agent-name", "message": "Did you send a message to manager?", "timeout": 120000}'
\`\`\`

This blocks until the reply arrives (no polling). The reply comes back in the response.

**Use \`/talk-to\` when:**
- You are asked to ask a question AND report back the answer
- You need data from the agent to complete your own response

**Do NOT use \`"wait": true\` when:**
- Relaying a request (e.g., "tell dev to contact the manager")
- Delegating a task (e.g., "please fix this bug")
- Sending a notification or update

## List Available Agents

\`\`\`bash
curl -s {{MANAGER_URL}}/agents -H "X-Id-Team: $ID_TEAM" | jq
\`\`\`

Returns:
\`\`\`json
{
  "agents": [
    {"name": "agent-1.xid.eth", "alias": "coder", "tokenId": "agent-1", "status": "running", "url": "http://localhost:4151"},
    {"name": "agent-2.xid.eth", "alias": "researcher", "tokenId": "agent-2", "status": "running", "url": "http://localhost:4152"}
  ]
}
\`\`\`

The \`name\` field is the agent's full identifier (ENS domain after registration, e.g., "agent-1.xid.eth", or local name before registration). Use this name when sending messages. The \`alias\` field is the original local name. The \`url\` field is the peer's REST-AP base URL — used by the catalog-aware selection flow below.

## Choosing the right agent to delegate to

\`/agents\` only tells you **who exists**. It does not tell you who is the right peer for a given piece of work. Before \`/ask\`, \`/message\`, or \`/talk-to\`, always run the catalog-aware selection flow.

### Step 1 — Enumerate peers

List candidates from the manager:

\`\`\`bash
curl -s {{MANAGER_URL}}/agents -H "X-Id-Team: $ID_TEAM" | jq '.agents[] | {name, alias, status, url}'
\`\`\`

### Step 2 — BEFORE \`/ask\`, fetch each candidate's catalog

For every candidate from Step 1, GET \`/catalog\` and read \`role\`, \`expertise\`, \`status\`, \`costTier\`, and \`notSuitableFor\`. Do **not** rely on names or aliases alone:

\`\`\`bash
# Single peer
curl -s http://localhost:<peer-port>/catalog | jq
\`\`\`

\`\`\`bash
# Manager-discovery substitution: resolve every peer's /catalog in one pass
for url in $(curl -s {{MANAGER_URL}}/agents -H "X-Id-Team: $ID_TEAM" | jq -r '.agents[].url'); do
  echo "== $url ==";
  curl -s "$url/catalog" | jq '{role, expertise, status, costTier, notSuitableFor}';
done
\`\`\`

### Step 3 — Filter

Drop any candidate where:

- \`status !== "available"\` (e.g., \`busy\`, \`offline\`, \`error\`) — they cannot take new work.
- \`notSuitableFor\` lists a work pattern matching what you intend to delegate (e.g., your task is "production deploys" and the catalog says \`"notSuitableFor": ["production deploys"]\`).

### Step 4 — Rank and pick

Apply these rules in order:

1. **Prefer a specialist over a generalist** — a candidate whose \`role\`/\`expertise\` directly matches the task beats a generalist whose catalog only loosely overlaps.
2. **Prefer the lower \`costTier\`** when complexity allows — for well-scoped, low-risk work pick \`low\` over \`medium\` over \`high\` to conserve cost.
3. **Never assign to a \`costTier: "low"\` agent**:
   - multi-file schema changes,
   - security or key-handling work (wallets, signing, secret rotation, auth code),
   - routing-logic changes (manager dispatch, inter-agent skills, message broker code).
   These must go to \`medium\` or \`high\` even if a \`low\` agent is "available" — promote the work, do not downgrade it.

Only after a candidate survives Steps 3 and 4 do you send the actual \`/ask\`, \`/message\`, or \`/talk-to\`.

## Contact The Manager

The manager is a reserved control-plane destination, not a peer discovered from \`/agents\`.

Ask the manager and wait for a reply:

\`\`\`bash
curl -s -X POST http://localhost:$ID_AGENT_PORT/talk-to \\
  -H "Content-Type: application/json" \\
  -d '{"to": "manager", "message": "your question for the manager", "timeout": 120000}'
\`\`\`

Send a fire-and-forget note to the manager:

\`\`\`bash
curl -s -X POST {{MANAGER_URL}}/news \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"from": "{{AGENT_NAME}}", "type": "message", "message": "your update for the manager"}'
\`\`\`

## Examples

### Relay a request (no wait needed):
\`\`\`bash
# "Tell dev to contact the manager" — just deliver and move on
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "dev", "message": "Please contact the manager about the deployment."}'
\`\`\`

### Ask a question and report back (wait needed):
\`\`\`bash
# "Ask dev if he finished and report back" — need the answer
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "dev", "message": "Did you finish the deployment?", "wait": true, "timeout": 120000}'
\`\`\`

### Delegate a task (no wait needed):
\`\`\`bash
# "Tell coder to fix the bug" — fire and forget
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "coder", "message": "Please fix the login validation bug in auth.ts"}'
\`\`\`

## When to Use Agent Communication

Use other agents when you need:
- **Specialized skills**: Another agent might be better at a specific task
- **Parallel work**: Delegate subtasks to work in parallel
- **Different perspectives**: Get a second opinion or alternative approach
- **Resource sharing**: Access files or data another agent has created

## Accessing Shared Files

Your team has a shared directory where files can be accessed by all agents in the same team. The manager can upload files here using the \`/share\` command.

**Important Paths**:
- **HTTP access**: \`http://localhost:PORT/files/teams/filename.md\`
- **File system**: Use your team-scoped path when writing files

To see what shared files are available:
\`\`\`bash
curl -s http://localhost:PORT/files/list | jq
\`\`\`

Files in the team folder will appear with paths like \`teams/filename.md\`. You can access them via HTTP:
\`\`\`bash
# Download/view a shared file (recommended)
curl -s http://localhost:PORT/files/teams/filename.md
\`\`\`

**To write files to the team folder**, use your team's directory path (provided in your identity section below):
\`\`\`bash
# Your team directory path is: /workspace/teams/<team-name>/
# All agents in your team can read and write to this directory

# Example: If you're in team "my-team", write to:
echo "My content" > /workspace/teams/my-team/myfile.md

# To list team files:
ls -la /workspace/teams/<team-name>/
\`\`\`

**Best Practice**: All agents in the same team share the same directory at \`/workspace/teams/<team>/\`. This allows easy collaboration - any file you write there is immediately accessible to other agents in your team.

## IMPORTANT: How Replies Work (Automatic)

**When someone sends you a message, your reply is sent automatically.** You do NOT need to use \`/message\` or any curl command to reply.

**How it works:**
1. Another agent sends you a message via \`/talk\`
2. You process the message and generate your response
3. Your response is **automatically** sent back to the sender
4. The sender receives your reply in their \`/news\` feed

**DO NOT:**
- Use \`/message\` to reply to incoming messages
- Use \`/message\` to message the manager to report your actions or status
- Use curl to send your response back
- Try to manually contact the sender

**DO:**
- Simply respond to the message in your output
- Your response text IS your reply - it gets sent automatically

**Example:**
If the manager asks "What is your role?", just answer directly:
> "I am coder1, responsible for frontend development."

That response automatically gets sent back to the manager. No curl commands needed!

**When TO use /message:**
- When YOU want to initiate a conversation with another agent
- When explicitly asked to "go ask agent-x about something"
- NOT for replying to messages you received (replies are automatic)

## Triggered Messages and Saved Responses

When you receive a **triggered message** (a late reply or notification), the system prevents infinite loops by NOT auto-sending your response back. Instead, your response is **saved to your own news feed**.

**How triggered messages work:**
1. You send a message to Agent B via \`/message\` with \`"wait": true\`
2. If the response takes longer than your timeout, the request returns a timeout
3. When Agent B eventually replies, it arrives at your \`/news\` endpoint with \`trigger: true\`
4. This triggers you to process the reply
5. Your response to this triggered message is **saved to YOUR news feed** (not sent back)

**Why responses are saved, not sent:**
- Prevents infinite ping-pong loops between agents
- Your response is still preserved and accessible
- The original sender can check your \`/news\` feed to see your response

**Checking another agent's saved responses:**
\`\`\`bash
# Check an agent's news feed for saved responses
curl -s "{{MANAGER_URL}}/agents" -H "X-Id-Team: $ID_TEAM" | jq  # Get agent URLs first
curl -s "http://<agent-url>/news?since=0" | jq '.items[] | select(.type == "response.saved")'
\`\`\`

**The saved response format:**
\`\`\`json
{
  "type": "response.saved",
  "message": "Response to pm1 (not sent - triggered message)",
  "data": {
    "to": "pm1",
    "in_reply_to": "query_123",
    "message": "Here is my actual response text...",
    "reason": "noAutoReply"
  }
}
\`\`\`

**Summary of message types:**
| Scenario | Your Response | Where It Goes |
|----------|---------------|---------------|
| Direct message via \`/talk\` | Auto-sent | Sender's \`/news\` |
| Triggered message | Saved locally | Your own \`/news\` |
| You initiate via \`/message\` | N/A (delivered) | Target's \`/talk\` |
| You initiate via \`/message\` + \`wait:true\` | N/A (waiting for reply) | Target's \`/talk\` |

## Best Practices

1. **Use \`/message\` for all outbound communication** — it delivers and returns immediately
2. **Only add \`"wait": true\`** when you literally cannot continue without the answer
3. **Catalog-check before delegating**: list \`/agents\`, then GET each candidate's \`/catalog\` and apply the four-step flow in *Choosing the right agent to delegate to* — never pick a peer by name alone
4. **Use descriptive messages**: Be clear about what you need
5. **Check your news feed**: Your \`/news\` endpoint has conversation history and context

## Mandatory Rule: When Asked to "Ask Another Agent", Actually Ask Them

If the user says anything like **"ask coder1 ..."**, **"go ask the manager ..."**, or otherwise requests you to relay information:

1. You MUST actually contact the target agent (do not guess)
2. **Use \`/message\`** to deliver the request:

\`\`\`bash
curl -s -X POST {{MANAGER_URL}}/message \\
  -H "Content-Type: application/json" \\
  -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "<agent-name>", "message": "<request>"}'
\`\`\`

3. If the target is the manager, use the reserved manager channel (\`/talk\` or \`/news\`) instead of peer messaging.

4. In your final response text, confirm:
   - What you sent (verbatim)
   - That the message was delivered

Your response text IS your reply - it gets sent automatically. No separate /message to manager needed!

If you cannot reach the target agent, say so and include the exact error.

## Check Your News Feed

Your news feed at \`/news\` contains:
- Incoming messages from other agents
- Previous conversation history
- Completed task results

\`\`\`bash
curl -s "{{MANAGER_URL}}/news?since=0" -H "X-Id-Team: $ID_TEAM" | jq
\`\`\`
`;

export const CATALOG_SKILL = `
# Agent Catalog Skill

You can update your own catalog to describe what you do, your role, skills, and current status. This information is visible to other agents and the manager via your \`/.well-known/restap.json\` endpoint.

## View Your Catalog

\`\`\`bash
curl -s http://localhost:$ID_AGENT_PORT/catalog | jq
\`\`\`

## Update Your Catalog

\`\`\`bash
curl -s -X PATCH http://localhost:$ID_AGENT_PORT/catalog \\
  -H "Content-Type: application/json" \\
  -d '{
    "description": "I specialize in TypeScript and React development",
    "role": "developer",
    "expertise": ["typescript", "react", "node", "testing"],
    "status": "available",
    "currentTask": "Working on user authentication"
  }'
\`\`\`

## Standard Catalog Fields

| Field | Description | Example |
|-------|-------------|---------|
| \`description\` | What you do, your specialization | "Full-stack developer focusing on React" |
| \`role\` | Your assigned role | "developer", "researcher", "pm", "reviewer" |
| \`expertise\` | Array of skills/technologies | ["typescript", "react", "testing"] |
| \`status\` | Current availability | "available", "busy", "offline" |
| \`currentTask\` | What you're working on | "Implementing login flow" |

## When to Update

- **At startup**: Set your description and expertise
- **When assigned a role**: Update your role field
- **When starting work**: Set status to "busy" and currentTask
- **When done**: Set status to "available" and clear currentTask

## Example: Starting a Task

\`\`\`bash
curl -s -X PATCH http://localhost:$ID_AGENT_PORT/catalog \\
  -H "Content-Type: application/json" \\
  -d '{"status": "busy", "currentTask": "Implementing user login"}'
\`\`\`

## Example: Completing a Task

\`\`\`bash
curl -s -X PATCH http://localhost:$ID_AGENT_PORT/catalog \\
  -H "Content-Type: application/json" \\
  -d '{"status": "available", "currentTask": null}'
\`\`\`
`;

/**
 * Helper to inject inter-agent communication skill into agent prompt.
 *
 * Skills are now file-based — deployed to each agent's .claude/skills/ folder
 * at deploy time (see deploySkillsToAgent in agent-manager-db.ts).
 * This function is kept as a thin passthrough for backward compatibility
 * with non-Claude models that use the lightweight inline skill.
 */
export function withInterAgentSkill(
  basePrompt: string,
  identity?:
    | string
    | {
        name?: string;
        team?: string;
        project?: string;
        metadata?: Record<string, any>;
        domain?: string;
      },
  options?: { lightweight?: boolean }
): string {
  // Lightweight mode for non-Claude models: still inject inline (no .claude/skills/ support)
  if (options?.lightweight) {
    const agentName = typeof identity === 'string' ? identity : identity?.name;
    const team = typeof identity === 'string' ? undefined : (identity?.team || identity?.project);
    const domain = typeof identity === 'string' ? undefined
      : ((identity as any)?.domain || identity?.metadata?.idchain_domain);
    const displayIdentity = domain || agentName;

    const lightSkill = INTER_AGENT_SKILL_LIGHT
      .replace(/\{\{AGENT_NAME\}\}/g, displayIdentity || 'unknown')
      .replace(/\{\{TEAM_NAME\}\}/g, team || 'default');
    return `${lightSkill}\n\n---\n\n${basePrompt}`;
  }

  // For Claude models: skills are loaded from .claude/skills/ files — just pass through
  return basePrompt;
}
