// SPDX-License-Identifier: MIT
/**
 * Local Agent Server
 *
 * Runs a Claude Code agent locally using the user's
 * existing Claude Code authentication. This allows agents to use your logged-in
 * Claude Code session instead of requiring an API key.
 *
 * The local agent:
 * - Registers with the manager as a team member
 * - Exposes REST-AP endpoints for inter-agent communication
 * - Uses your local Claude Code session for LLM calls
 * - Can participate in multi-agent workflows alongside other local agents
 */

import 'dotenv/config';
import { ClaudeAgentServer } from './claude-agent-server.js';
import { createDb, getOrCreateTeamId, type Db } from './db.js';
import fetch from 'node-fetch';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import net from 'net';

interface LocalAgentConfig {
  name: string;
  team?: string;
  port?: number;
  workingDirectory?: string;
  model?: string;
  managerUrl?: string;
  agentId?: string;  // Pre-registered agent ID from manager
  verbose?: boolean; // Enable detailed logging of agent activity
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

/**
 * Find an available port starting from a given port
 */
async function findAvailablePort(startPort: number, maxAttempts: number = 100): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available ports found in range ${startPort}-${startPort + maxAttempts}`);
}

/**
 * Get port search range for local agents (global sequential allocation, starting at 4101)
 */
async function getPortSearchRange(): Promise<{ portStart: number; portEnd: number }> {
  return { portStart: 4101, portEnd: 65535 };
}

/**
 * Register the local agent with the manager
 */
async function registerWithManager(
  managerUrl: string,
  agentId: string,
  name: string,
  team: string,
  port: number,
  apiKey?: string
): Promise<void> {
  const endpoint = `http://localhost:${port}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Id-Team': team
  };
  if (apiKey) {
    headers['X-API-Key'] = apiKey;
  }

  const response = await fetch(`${managerUrl}/agents/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: agentId,
      name,
      endpoint,
      type: 'claude',  // Mark as claude type since it runs Claude Code
      metadata: {
        name,
        service_type: 'REST-AP',
        service: endpoint,
        runtime: 'claude-code-local',
        local: true,  // Flag to indicate this is a local agent
        host_pid: process.pid
      }
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register with manager: ${error}`);
  }

  console.log(`✅ Registered with manager at ${managerUrl}`);
}

// Note: We no longer need an unregister function here.
// The stop() function updates status directly via database.
// Agents persist in the database and can be restarted.

/**
 * Start a local Claude Code agent server
 */
export async function startLocalAgent(config: LocalAgentConfig): Promise<{
  server: ClaudeAgentServer;
  port: number;
  agentId: string;
  stop: () => Promise<void>;
}> {
  const {
    name,
    team = process.env.ID_TEAM || 'default',
    port: requestedPort,
    workingDirectory: configWorkDir,
    model = process.env.CLAUDE_MODEL || 'claude-opus-4-20250514',
    managerUrl = process.env.MANAGER_URL || 'http://localhost:4100',
    agentId: preRegisteredId
  } = config;

  const apiKey = process.env.ID_AGENT_API_KEY || process.env.ID_CONTROL_API_KEY;
  const tokenId = process.env.ID_AGENT_TOKEN_ID;

  // Use pre-registered ID or generate one
  const agentId = preRegisteredId || `local_${name.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${Date.now()}`;
  const isPreRegistered = !!preRegisteredId;

  // Set up working directory
  const baseWorkDir = process.env.ID_WORKSPACE_DIR || process.env.WORKSPACE_DIR || '/tmp/id-agents';
  const workingDirectory = configWorkDir || path.join(baseWorkDir, 'local-agents', agentId);
  const sharedDirectory = path.join(baseWorkDir, 'teams', team);

  // Create directories if they don't exist
  if (!existsSync(workingDirectory)) {
    mkdirSync(workingDirectory, { recursive: true });
  }
  if (!existsSync(sharedDirectory)) {
    mkdirSync(sharedDirectory, { recursive: true });
  }

  // Determine port
  let port: number;
  if (requestedPort) {
    if (await isPortAvailable(requestedPort)) {
      port = requestedPort;
    } else {
      throw new Error(`Requested port ${requestedPort} is not available`);
    }
  } else {
    // Find available port using global sequential allocation
    const portRange = await getPortSearchRange();
    port = await findAvailablePort(portRange.portStart, portRange.portEnd - portRange.portStart);
  }

  // Try to connect to database (optional - for persistent news/queries)
  let db: Db | undefined;
  let dbTeamId: string | undefined;

  if (process.env.DATABASE_URL) {
    try {
      db = createDb();
      // Use pre-configured team ID if available
      dbTeamId = process.env.ID_DB_TEAM_ID || await getOrCreateTeamId(db, team);

      if (isPreRegistered) {
        // Just update status to 'running' - agent was already registered by manager
        await db.pool.query(
          `UPDATE agents SET status = 'running' WHERE team_id = $1 AND id = $2`,
          [dbTeamId, agentId]
        );
        console.log(`📦 Updated status to running in database`);
      } else {
        // Register agent in database (standalone mode)
        await db.pool.query(
          `INSERT INTO agents (team_id, id, name, type, model, port, endpoint, working_directory, status, created_at, metadata)
           VALUES ($1, $2, $3, 'claude', $4, $5, $6, $7, 'running', $8, $9)
           ON CONFLICT (team_id, id)
           DO UPDATE SET status = 'running', port = EXCLUDED.port, endpoint = EXCLUDED.endpoint`,
          [
            dbTeamId,
            agentId,
            name,
            model,
            port,
            `http://localhost:${port}`,
            workingDirectory,
            Date.now(),
            { name, service_type: 'REST-AP', service: `http://localhost:${port}`, runtime: 'claude-code-local', local: true }
          ]
        );
        console.log(`📦 Registered in database (team: ${team})`);
      }
    } catch (err) {
      console.warn(`⚠️  Database connection failed, running in memory-only mode: ${err}`);
      db = undefined;
    }
  }

  // Determine harness: respect ID_HARNESS env var, default to CLI for local dev
  const harness = process.env.ID_HARNESS || 'claude-code-cli';
  process.env.ID_HARNESS = harness;

  // Only remove API key when using CLI harness (to force OAuth credentials)
  if (harness === 'claude-code-cli') {
    delete process.env.ANTHROPIC_API_KEY;
  }

  // Set manager URL for ClaudeAgentServer to use
  process.env.MANAGER_URL = managerUrl;

  // Ensure API key is set for inter-agent communication (replies to manager)
  if (apiKey && !process.env.ID_AGENT_API_KEY) {
    process.env.ID_AGENT_API_KEY = apiKey;
  }

  // Enable verbose logging if configured
  if (config.verbose || process.env.ID_AGENT_VERBOSE === 'true') {
    process.env.ID_AGENT_VERBOSE = 'true';
    console.log('📋 Verbose logging enabled - will show tool calls and progress');
  }

  // Create the server
  const server = new ClaudeAgentServer({
    model,
    workingDirectory,
    sharedDirectory,
    agentName: name,
    agentIdentity: { name, team, ...(tokenId && { tokenId }) },
    ...(db && dbTeamId && { db: { db, teamId: dbTeamId, agentId } })
  });

  // Start the server
  await server.start(port);

  // Register with manager (only if not pre-registered)
  if (!isPreRegistered) {
    try {
      await registerWithManager(managerUrl, agentId, name, team, port, apiKey);
    } catch (err) {
      console.warn(`⚠️  Could not register with manager: ${err}`);
      console.log(`   Agent is running but may not be discoverable by other agents.`);
      console.log(`   Make sure the manager is running at ${managerUrl}`);
    }
  } else {
    console.log(`✅ Agent pre-registered with manager (ID: ${agentId})`);
  }

  // Create stop function for graceful shutdown
  const stop = async () => {
    console.log('\n🛑 Stopping local agent...');

    // Update database status and cancel pending queries
    if (db && dbTeamId) {
      try {
        const ts = Date.now();

        // Cancel pending queries so they don't show as orphaned
        const pendingQueries = await db.pool.query<{ query_id: string }>(
          `SELECT query_id FROM queries
           WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
          [dbTeamId, agentId]
        );

        if (pendingQueries.rows.length > 0) {
          const queryIds = pendingQueries.rows.map(r => r.query_id);

          await db.pool.query(
            `UPDATE queries SET status = 'cancelled', completed = $3
             WHERE team_id = $1 AND agent_id = $2 AND status IN ('pending', 'processing')`,
            [dbTeamId, agentId, ts]
          );

          // Add query.cancelled news items
          for (const queryId of queryIds) {
            await db.pool.query(
              `INSERT INTO news_items (team_id, agent_id, timestamp, type, message, data, query_id)
               VALUES ($1, $2, $3, 'query.cancelled', 'Query cancelled (agent stopped)', $4, $5)`,
              [dbTeamId, agentId, ts, { reason: 'agent_stopped', query_id: queryId }, queryId]
            );
          }
          console.log(`📋 Cancelled ${queryIds.length} pending queries`);
        }

        await db.pool.query(
          `UPDATE agents SET status = 'stopped' WHERE team_id = $1 AND id = $2`,
          [dbTeamId, agentId]
        );
      } catch {
        // Ignore errors
      }
    }

    // Stop the server
    await server.stop();

    // Close database connection
    if (db) {
      await db.pool.end();
    }
  };

  return { server, port, agentId, stop };
}

/**
 * CLI entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let name = args[0];
  let team = process.env.ID_TEAM || 'default';
  let port: number | undefined;
  let workingDirectory: string | undefined;
  let agentId: string | undefined;

  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--team' || args[i] === '-t') {
      team = args[++i];
    } else if (args[i] === '--port' || args[i] === '-p') {
      port = parseInt(args[++i]);
    } else if (args[i] === '--dir' || args[i] === '-d') {
      workingDirectory = args[++i];
    } else if (args[i] === '--id') {
      agentId = args[++i];
    } else if (args[i] === '--verbose' || args[i] === '-v') {
      verbose = true;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Local Agent Server - Run Claude Code agents using your local authentication

Usage:
  node dist/local-agent-server.js <name> [options]

Options:
  --team, -t <name>    Team name (default: ID_TEAM env or 'default')
  --port, -p <port>    Port to listen on (auto-allocated if not specified)
  --dir, -d <path>     Working directory (auto-created if not specified)
  --id <agent-id>      Pre-registered agent ID (from /deploy)
  --verbose, -v        Enable detailed logging (show tool calls, progress)
  --help, -h           Show this help message

Environment Variables:
  ID_TEAM              Default team name
  MANAGER_URL          Manager URL (default: http://localhost:4100)
  DATABASE_URL         PostgreSQL connection string (optional)
  CLAUDE_MODEL         Default model (default: claude-opus-4-20250514)
  ID_AGENT_API_KEY     API key for inter-agent communication

Examples:
  node dist/local-agent-server.js my-agent
  node dist/local-agent-server.js coder --team myproject --port 24001
  ID_TEAM=myteam node dist/local-agent-server.js researcher
`);
      process.exit(0);
    } else if (!args[i].startsWith('-') && !name) {
      name = args[i];
    }
  }

  if (!name) {
    console.error('❌ Missing agent name');
    console.error('Usage: node dist/local-agent-server.js <name> [--team <team>] [--port <port>]');
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           🏠 Local Claude Code Agent Server                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Running Claude Code with your local authentication           ║
║  Other agents can communicate via REST-AP protocol            ║
╚═══════════════════════════════════════════════════════════════╝
`);

  const { port: actualPort, agentId: finalAgentId, stop } = await startLocalAgent({
    name,
    team,
    port,
    workingDirectory,
    agentId,
    verbose
  });

  console.log(`\n📍 Agent Details:`);
  console.log(`   ID:      ${finalAgentId}`);
  console.log(`   Name:    ${name}`);
  console.log(`   Team:    ${team}`);
  console.log(`   Port:    ${actualPort}`);
  console.log(`   URL:     http://localhost:${actualPort}`);
  console.log(`   REST-AP: http://localhost:${actualPort}/.well-known/restap.json`);
  console.log(`\n🎯 Talk to this agent:`);
  console.log(`   curl -X POST http://localhost:${actualPort}/talk \\`);
  console.log(`     -H "Content-Type: application/json" \\`);
  console.log(`     -d '{"message": "Hello!"}'`);
  console.log('\nPress Ctrl+C to stop the agent\n');

  // Handle shutdown gracefully
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process alive
  const heartbeat = setInterval(() => {}, 1000 * 60 * 60);
  process.on('exit', () => clearInterval(heartbeat));
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
