// SPDX-License-Identifier: MIT
/**
 * Inter-Agent Communication Skills
 *
 * Provides instructions and helper scripts that agents can use
 * to discover and communicate with other agents via REST-AP.
 *
 * Source of truth: skills/inter-agent/SKILL.md is the canonical inter-agent
 * skill consumed by Claude agents at deploy time (see `deploySkillsToAgent`
 * in agent-manager-db.ts). The full TS export below is loaded from that MD
 * file at module init so the two cannot diverge. The lightweight variant
 * (`INTER_AGENT_SKILL_LIGHT`) is intentionally separate — it is a much
 * shorter inline skill used only for non-Claude / cost-sensitive models
 * via `withInterAgentSkill({ lightweight: true })`.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Lightweight inter-agent skill for non-Claude models (e.g., OpenCode with GLM, Llama, etc.)
 * Much shorter to reduce token usage and improve response times.
 *
 * NOTE: this is intentionally a separate, hand-maintained constant — it is
 * NOT generated from the MD file because non-Claude models pay per token
 * and need a tighter skill. The full skill (`INTER_AGENT_SKILL`) is loaded
 * from `skills/inter-agent/SKILL.md`.
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

/**
 * Path to the canonical inter-agent SKILL.md, resolved relative to this module.
 * Works from both `src/inter-agent-skill.ts` (tsx/test runner) and the compiled
 * `dist/inter-agent-skill.js`, since both live one directory below the repo
 * root that contains `skills/`.
 */
const INTER_AGENT_SKILL_FILE = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'skills',
  'inter-agent',
  'SKILL.md'
);

/**
 * Load the canonical inter-agent skill from disk and strip the YAML
 * frontmatter so the returned string is the pure skill body. Any read or
 * parse failure throws — silent fallback would be worse than a hard fail at
 * module init, because it would let the TS export quietly drift from the MD
 * source we just declared the source of truth.
 */
function loadInterAgentSkillFromFile(): string {
  const raw = readFileSync(INTER_AGENT_SKILL_FILE, 'utf8');
  return stripYamlFrontmatter(raw);
}

export function stripYamlFrontmatter(raw: string): string {
  return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/**
 * Full inter-agent skill text. Loaded at module init from
 * `skills/inter-agent/SKILL.md` (the source of truth). Any drift between
 * this export and the MD file is caught by the divergence test in
 * tests/unit/inter-agent-skill.test.ts.
 */
export const INTER_AGENT_SKILL = '\n' + loadInterAgentSkillFromFile();


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
