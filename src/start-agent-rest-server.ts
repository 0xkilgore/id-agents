// SPDX-License-Identifier: MIT
/**
 * Start a local runtime-backed agent as a REST-AP server.
 */

import 'dotenv/config';
import { AgentRestServer } from './agent-rest-server.js';
import { resolveRuntime } from './runtime/registry.js';

async function main() {
  const harness = resolveRuntime(process.env.ID_HARNESS || process.env.HARNESS || 'claude-agent-sdk');
  const needsAnthropicKey = harness === 'claude-agent-sdk';

  if (!process.env.ANTHROPIC_API_KEY && needsAnthropicKey) {
    console.error('❌ ANTHROPIC_API_KEY not set');
    console.error('Add it to your .env file');
    process.exit(1);
  }

  const port = parseInt(process.env.CLAUDE_AGENT_PORT || '4101');
  const workingDir = process.env.CLAUDE_AGENT_WORKDIR || process.cwd();

  const server = new AgentRestServer({
    workingDirectory: workingDir,
    port
  });

  await server.start(port);

  console.log('Press Ctrl+C to stop the server\n');

  const heartbeat = setInterval(() => {
    // Keep the event loop alive.
  }, 1000 * 60 * 60);

  process.on('SIGINT', () => {
    console.log('\n\nShutting down...');
    clearInterval(heartbeat);
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    console.log('\n\nShutting down...');
    clearInterval(heartbeat);
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
