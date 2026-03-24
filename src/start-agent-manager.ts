// SPDX-License-Identifier: MIT
/**
 * Start Agent Manager
 * 
 * Runs the multi-agent manager that can spawn Claude agents on demand
 */

import 'dotenv/config';
import { AgentManagerDb } from './agent-manager-db.js';
import { createDb, migrateDb } from './db.js';
import { ClaudeAgentServer } from './claude-agent-server.js';

async function main() {
  const agentRole = process.env.AGENT_ROLE || 'manager'; // 'manager' or 'worker'
  const agentId = process.env.AGENT_ID; // For worker agents

  console.log(`🚀 Starting ID Agent (${agentRole})`);

  // Managers can boot without an API key (so the API can come up and you can debug/inspect state).
  // Worker agents require it to actually run Claude (unless using a different harness).
  const harness = process.env.ID_HARNESS || process.env.HARNESS || 'claude-agent-sdk';
  const useMaxPlan = process.env.ID_USE_MAX_PLAN === 'true';

  // claude-code-cli can use Max plan credentials (OAuth) instead of API key
  const needsAnthropicKey = harness.startsWith('claude') && !(harness === 'claude-code-cli' && useMaxPlan);

  if (!process.env.ANTHROPIC_API_KEY && needsAnthropicKey) {
    if (agentRole === 'worker') {
      console.error('❌ ANTHROPIC_API_KEY not set');
      console.error('Add it to your .env file');
      process.exit(1);
    } else {
      console.warn('⚠️  ANTHROPIC_API_KEY not set (manager will start, but workers may fail to run Claude)');
    }
  }

  if (harness === 'claude-code-cli' && useMaxPlan) {
    console.log('🔑 Using Max plan credentials (OAuth) for Claude Code CLI');
  }

  if (agentRole === 'worker') {
    // Worker agent: Run a single Claude agent
    await startWorkerAgent(agentId);
  } else {
    // Manager agent: Run the manager
    await startManagerAgent();
  }
}

async function startManagerAgent() {
  const managementPort = parseInt(process.env.AGENT_MANAGER_PORT || '4100');
  const workingDir = process.env.AGENT_MANAGER_WORKDIR || '/workspace';

  // Initialize DB (required for persistence)
  const db = createDb();
  await migrateDb(db);

  const manager = new AgentManagerDb(workingDir, db);

  await manager.start(managementPort);

  console.log('🎯 Manager agent ready - can spawn and manage local worker agents');
  console.log('Press Ctrl+C to stop the manager\n');

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log('\n\nShutting down manager agent...');
    clearInterval(heartbeat);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\nShutting down manager agent...');
    clearInterval(heartbeat);
    process.exit(0);
  });
}

async function startWorkerAgent(agentId?: string) {
  if (!agentId) {
    console.error('❌ AGENT_ID not set for worker agent');
    process.exit(1);
  }

  // Worker agents run a single REST-AP ClaudeAgentServer (not the manager API).
  const port = parseInt(process.env.CLAUDE_AGENT_PORT || process.env.AGENT_PORT || '4100');
  const workingDir = process.env.CLAUDE_AGENT_WORKDIR || process.env.AGENT_MANAGER_WORKDIR || `/workspace/agents/${agentId}`;
  // Team name determines the shared directory scope - all agents in a team share files
  const teamName = process.env.ID_TEAM || process.env.ID_PROJECT || 'default';
  const sharedDir = process.env.ID_SHARED_DIR || `/workspace/teams/${teamName}`;
  // Use ID_AGENT_ALIAS for the base name (e.g., "max"), not ID_AGENT_NAME which may be an ENS domain
  const agentAlias = process.env.ID_AGENT_ALIAS || process.env.ID_AGENT_NAME || process.env.AGENT_NAME || agentId;
  const agentTokenId = process.env.ID_AGENT_TOKEN_ID || undefined;
  const managerUrl = process.env.MANAGER_URL || 'http://localhost:4100';

  console.log(`🤖 Starting worker agent: ${agentId} on port ${port}`);

  // Optional: persist news/queries to the shared DB if the manager provides identifiers.
  // If not provided, the agent still works (in-memory news, filesystem workspace).
  let dbCtx: { db: any; teamId: string; agentId: string } | undefined;
  try {
    const dbTeamId = process.env.ID_DB_TEAM_ID;
    const dbAgentId = process.env.ID_DB_AGENT_ID || agentId;
    if (dbTeamId) {
      const db = createDb();
      await migrateDb(db);
      dbCtx = { db, teamId: dbTeamId, agentId: dbAgentId };
    }
  } catch (e: any) {
    console.warn(`⚠️ Worker agent DB disabled: ${e?.message || String(e)}`);
  }

  // Fetch full identity (including tokenId) from manager
  // Initialize with env vars as fallback (tokenId from ID_AGENT_TOKEN_ID)
  let agentIdentity: { name?: string; team?: string; registry?: any; metadata?: any; tokenId?: string; registry7930?: string } = {
    name: agentAlias,
    team: teamName,
    tokenId: agentTokenId  // Use env var tokenId as initial fallback
  };

  // Always log what we have from env vars for debugging
  console.log(`🔧 Env vars: ID_AGENT_ALIAS=${agentAlias}, ID_AGENT_TOKEN_ID=${agentTokenId || '(not set)'}`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }
    const identityRes = await fetch(`${managerUrl}/agents/${agentId}`, { headers });
    if (identityRes.ok) {
      const agentData = await identityRes.json() as any;
      // Log what manager returned for debugging
      console.log(`🔧 Manager returned: alias=${agentData.alias}, tokenId=${agentData.tokenId}, name=${agentData.name}`);
      // Use alias from response, or fall back to env var alias
      const fetchedAlias = agentData.alias || agentAlias;
      const fetchedTokenId = agentData.tokenId || agentData.registry?.tokenId || agentTokenId;
      agentIdentity = {
        name: fetchedAlias,  // Use just the alias, not the displayId (getDisplayId will construct it)
        team: teamName,
        registry: agentData.registry,
        metadata: agentData.metadata,
        tokenId: fetchedTokenId,
        registry7930: agentData.registry7930
      };
      console.log(`📋 Loaded identity: ${fetchedAlias}`);
    } else {
      console.warn(`⚠️ Manager fetch failed: ${identityRes.status}`);
      if (agentAlias) {
        console.log(`📋 Using env identity: ${agentAlias}`);
      }
    }
  } catch (e: any) {
    console.warn(`⚠️ Could not fetch identity from manager: ${e?.message || String(e)}`);
    if (agentAlias) {
      console.log(`📋 Using env identity: ${agentAlias}`);
    }
  }

  const server = new ClaudeAgentServer({
    model: process.env.CLAUDE_MODEL,
    workingDirectory: workingDir,
    sharedDirectory: sharedDir,
    agentName: agentAlias,  // Pass the alias, not the full displayId
    agentIdentity,
    db: dbCtx ? { db: dbCtx.db, teamId: dbCtx.teamId, agentId: dbCtx.agentId } : undefined
  });

  await server.start(port);

  console.log(`✅ Worker agent ${agentId} ready on port ${port}`);
  console.log(`📡 Manager: ${managerUrl}`);
  console.log('Press Ctrl+C to stop the agent\n');

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);

  // Handle shutdown gracefully
  process.on('SIGINT', () => {
    console.log(`\n\nShutting down worker agent ${agentId}...`);
    clearInterval(heartbeat);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log(`\n\nShutting down worker agent ${agentId}...`);
    clearInterval(heartbeat);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
