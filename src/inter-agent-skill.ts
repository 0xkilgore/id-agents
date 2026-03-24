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

## Send a Message to Another Agent
\`\`\`bash
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "agent-name", "message": "your message"}'
\`\`\`
Add \`"wait": true\` only if you need the reply to continue your work.

## List Agents
\`\`\`bash
curl -s http://localhost:4100/agents -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq '.agents[].name'
\`\`\`

## Key Rules
1. Your response text is automatically sent back - no curl needed to reply
2. Use /message only to START a conversation, not to reply
3. Do NOT add \`"wait": true\` unless you literally cannot continue without the answer
4. Use the full agent name (e.g., "agent.20") when addressing other agents
5. Team files: /workspace/teams/{{TEAM_NAME}}/
`;

export const INTER_AGENT_SKILL = `
# Inter-Agent Communication Skill

You are part of a multi-agent team. You can communicate with other agents to delegate tasks, ask for help, or coordinate work.

**IMPORTANT:** Your agent name will be specified below. When asked "who are you?" or "what is your name?", you should respond with your agent name, not "Claude Code" or "Claude".

## Send a Message to Another Agent

Use the \`/message\` endpoint to contact other agents:

\`\`\`bash
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
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

If you need the agent's answer to complete your response, add \`"wait": true\`:

\`\`\`bash
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "agent-name", "message": "Did you send a message to manager?", "wait": true, "timeout": 120000}'
\`\`\`

**Use \`"wait": true\` when:**
- You are asked to ask a question AND report back the answer
- You need data from the agent to complete your own response

**Do NOT use \`"wait": true\` when:**
- Relaying a request (e.g., "tell dev to contact the manager")
- Delegating a task (e.g., "please fix this bug")
- Sending a notification or update

## List Available Agents

\`\`\`bash
curl -s http://localhost:4100/agents -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq
\`\`\`

Returns:
\`\`\`json
{
  "agents": [
    {"name": "agent-1.sep.xid.eth", "alias": "coder", "tokenId": "agent-1", "status": "running"},
    {"name": "agent-2.sep.xid.eth", "alias": "researcher", "tokenId": "agent-2", "status": "running"}
  ]
}
\`\`\`

**IMPORTANT:** The \`name\` field is the agent's full identifier (ENS domain after registration, e.g., "agent-1.sep.xid.eth", or local name before registration). Always use this name when sending messages to agents. The \`alias\` field is the original local name.

## Examples

### Relay a request (no wait needed):
\`\`\`bash
# "Tell dev to contact the manager" — just deliver and move on
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "dev", "message": "Please contact the manager about the deployment."}'
\`\`\`

### Ask a question and report back (wait needed):
\`\`\`bash
# "Ask dev if he finished and report back" — need the answer
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "dev", "message": "Did you finish the deployment?", "wait": true, "timeout": 120000}'
\`\`\`

### Delegate a task (no wait needed):
\`\`\`bash
# "Tell coder to fix the bug" — fire and forget
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
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
curl -s "http://localhost:4100/agents" -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq  # Get agent URLs first
curl -s "http://<agent-url>/news?since=0" -H "X-Api-Key: $ID_AGENT_API_KEY" | jq '.items[] | select(.type == "response.saved")'
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
3. **List agents first**: Check what agents are available before communicating
4. **Use descriptive messages**: Be clear about what you need
5. **Check your news feed**: Your \`/news\` endpoint has conversation history and context

## Mandatory Rule: When Asked to "Ask Another Agent", Actually Ask Them

If the user says anything like **"ask coder1 ..."**, **"go ask the manager ..."**, or otherwise requests you to relay information:

1. You MUST actually contact the target agent (do not guess)
2. **Use \`/message\`** to deliver the request:

\`\`\`bash
curl -s -X POST http://localhost:4100/message \\
  -H "Content-Type: application/json" \\
  -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" \\
  -d '{"to": "<agent-name>", "message": "<request>"}'
\`\`\`

3. **IMPORTANT**: Do NOT use /message to message the manager. Your response is automatically sent back.

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
curl -s "http://localhost:4100/news?since=0" -H "X-Api-Key: $ID_AGENT_API_KEY" -H "X-Id-Team: $ID_TEAM" | jq
\`\`\`
`;

export const CATALOG_SKILL = `
# Agent Catalog Skill

You can update your own catalog to describe what you do, your role, skills, and current status. This information is visible to other agents and the manager via your \`/.well-known/restap.json\` endpoint.

## View Your Catalog

\`\`\`bash
curl -s http://localhost:$PORT/catalog | jq
\`\`\`

## Update Your Catalog

\`\`\`bash
curl -s -X PATCH http://localhost:$PORT/catalog \\
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
curl -s -X PATCH http://localhost:$PORT/catalog \\
  -H "Content-Type: application/json" \\
  -d '{"status": "busy", "currentTask": "Implementing user login"}'
\`\`\`

## Example: Completing a Task

\`\`\`bash
curl -s -X PATCH http://localhost:$PORT/catalog \\
  -H "Content-Type: application/json" \\
  -d '{"status": "available", "currentTask": null}'
\`\`\`
`;

/**
 * Helper to inject inter-agent communication skill into agent prompt
 * @param basePrompt The user's prompt/message
 * @param identity Agent identity info
 * @param options.lightweight Use shorter skill for non-Claude models (default: false)
 */
export function withInterAgentSkill(
  basePrompt: string,
  identity?:
    | string
    | {
        name?: string;
        team?: string;
        project?: string; // deprecated, use team
        registry?: { chainId: number; registryAddress: string; tokenId?: string };
        metadata?: Record<string, any>;
      },
  options?: { lightweight?: boolean }
): string {
  const agentName = typeof identity === 'string' ? identity : identity?.name;
  // Support 'team' (new) and 'project' (legacy) for backwards compatibility
  const team = typeof identity === 'string' ? undefined : (identity?.team || identity?.project);
  const registry = typeof identity === 'string' ? undefined : identity?.registry;
  const managerUrl = process.env.MANAGER_URL || 'http://localhost:4100';

  // Display identity: ENS domain after registration, local name before
  const domain = typeof identity === 'string' ? undefined
    : ((identity as any)?.domain || identity?.metadata?.idchain_domain || (identity?.registry as any)?.domain);
  const displayIdentity = domain || agentName;

  // Use lightweight skill for non-Claude models (reduces tokens significantly)
  if (options?.lightweight) {
    const lightSkill = INTER_AGENT_SKILL_LIGHT
      .replace(/\{\{AGENT_NAME\}\}/g, displayIdentity || 'unknown')
      .replace(/\{\{TEAM_NAME\}\}/g, team || 'default');
    return `${lightSkill}\n\n---\n\n${basePrompt}`;
  }

  const agentNameSection = agentName
    ? `\n\n## Your Identity\n\n**Your name is "${displayIdentity}".** This is your agent identifier in the network. When someone asks "who are you?" or "what is your name?", respond with "${displayIdentity}", not "Claude Code" or "Claude".\n\nWhen communicating with other agents using the \`talk-to-agent.sh\` script, you can optionally include your name as the third parameter to identify yourself.\n`
    : '';

  const teamSection = team
    ? `\n\n## Your Team\n\n**You are in team "${team}".** Your team files directory is at:\n\`\`\`\n/workspace/teams/${team}/\n\`\`\`\n\n**IMPORTANT**: When writing files to the team folder, always use this path: \`/workspace/teams/${team}/filename\`. All agents in your team can read and write files here.\n`
    : `\n\n## Your Team\n\nYou are part of a team. Check the manager (${managerUrl}/agents) to find your team name. Your team directory is at \`/workspace/teams/<team-name>/\`.\n`;

  const registrySection = registry
    ? `\n\n## Your Onchain Identity\n\nYou have an onchain identity in an AgentRegistry (ERC-6909):\n- chainId: ${registry.chainId}\n- registry: ${registry.registryAddress}\n- tokenId: ${registry.tokenId ? registry.tokenId : '(not registered yet)'}\n\nIf tokenId is not set, ask the manager to register you and/or check the manager's agent list (${managerUrl}/agents) to see your latest registry assignment.\n`
    : `\n\n## Your Onchain Identity\n\nYour onchain identity (chainId/registry/tokenId) may be managed by the manager. If you need it, ask the manager or check ${managerUrl}/agents.\n`;

  const newsFeedReminder = `\n\n## Important: Check Your News Feed\n\n**Before starting any new task or responding to a message, always check your news feed first.** Your news feed contains:\n- Incoming messages from other agents\n- Previous conversation history\n- Updates about completed tasks\n- Context about what you've been working on\n\nTo check your news feed, use:\n\`\`\`bash\ncurl -s "http://localhost:PORT/news?since=0" | jq\n\`\`\`\n\nOr use the \`talk-to-agent.sh\` script which automatically includes news feed context. Checking your news feed helps you maintain context and avoid repeating work.\n`;

  const catalogSkillSection = `\n\n${CATALOG_SKILL}`;

  return `${INTER_AGENT_SKILL}${agentNameSection}${teamSection}${registrySection}${newsFeedReminder}${catalogSkillSection}

---

${basePrompt}`;
}

/**
 * Helper bash scripts agents can use
 */
export const AGENT_COMM_SCRIPTS = {
  listAgents: `curl -s "$MANAGER_URL/agents" | jq`,
  
  sendMessage: (port: number, message: string) => 
    `curl -s -X POST http://localhost:${port}/talk -H "Content-Type: application/json" -d '${JSON.stringify({ message })}'`,
  
  getNews: (port: number, since: number = 0) =>
    `curl -s "http://localhost:${port}/news?since=${since}" | jq`,
  
  getAgentPort: (agentName: string) =>
    `curl -s "$MANAGER_URL/agents" | jq -r '.agents[] | select(.name == "${agentName}") | .port'`,
};

/**
 * Create a helper script file for agents
 */
export function generateAgentHelperScript(): string {
  return `#!/bin/bash
# Inter-Agent Communication Helper
# This script provides easy commands for agent communication

# List all agents
list_agents() {
  curl -s "\${MANAGER_URL:-http://id-agent-manager:4100}/agents" | jq
}

# Get agent port by name
get_agent_port() {
  local name="$1"
  curl -s "\${MANAGER_URL:-http://id-agent-manager:4100}/agents" | jq -r ".agents[] | select(.name == \"$name\") | .port"
}

# Send message to agent
talk_to_agent() {
  local agent_name="$1"
  local message="$2"
  
  local port=$(get_agent_port "$agent_name")
  
  if [ "$port" = "Agent not found" ]; then
    echo "Error: Agent '$agent_name' not found"
    return 1
  fi
  
  curl -s -X POST "http://localhost:$port/talk" \\
    -H "Content-Type: application/json" \\
    -d "{\\"message\\": \\"$message\\"}" | jq
}

# Get news from agent
get_agent_news() {
  local agent_name="$1"
  local port=$(get_agent_port "$agent_name")
  
  if [ "$port" = "Agent not found" ]; then
    echo "Error: Agent '$agent_name' not found"
    return 1
  fi
  
  curl -s "http://localhost:$port/news?since=0" | jq
}

# Usage examples
if [ "$1" = "list" ]; then
  list_agents
elif [ "$1" = "talk" ]; then
  talk_to_agent "$2" "$3"
elif [ "$1" = "news" ]; then
  get_agent_news "$2"
else
  echo "Usage:"
  echo "  $0 list                           - List all agents"
  echo "  $0 talk <agent-name> <message>    - Send message to agent"
  echo "  $0 news <agent-name>              - Get news from agent"
fi
`;
}
