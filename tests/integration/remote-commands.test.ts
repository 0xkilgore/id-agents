// SPDX-License-Identifier: MIT
/**
 * Remote Commands Integration Tests
 *
 * Tests all /remote endpoint commands that mirror CLI functionality.
 * Each test uses the /remote endpoint directly.
 *
 * Prerequisites:
 * - Cluster must be running (`/cluster start` in CLI)
 * - ANTHROPIC_API_KEY must be set
 *
 * Run with: npm test
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  waitForManager,
  waitForAgent,
  remote,
  remoteAgents,
  remoteStatus,
  remoteSpawn,
  remoteDelete,
  remoteAsk,
  remoteNews,
  remoteDeploy,
  type RemoteResult,
} from '../helpers/manager-client.js';

// Unique prefix for test agents to avoid conflicts
const TEST_PREFIX = `test-${Date.now()}`;

// Track agents created during tests for cleanup
const createdAgents: string[] = [];

describe('Remote Commands (/remote endpoint)', () => {
  beforeAll(async () => {
    // Wait for Manager to be healthy
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error(
        'Manager not healthy. Make sure to run `/cluster start` before running tests.'
      );
    }
  });

  afterAll(async () => {
    // Clean up all test agents
    for (const agentName of createdAgents) {
      try {
        await remoteDelete(agentName);
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // ==================== /status ====================
  describe('/status command', () => {
    it('should return cluster status', async () => {
      const result = await remoteStatus();

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const status = result.data.result as {
        team: string;
        totalAgents: number;
        runningAgents: number;
        status: string;
      };
      expect(status.team).toBeDefined();
      expect(status.status).toBe('ok');
      expect(typeof status.totalAgents).toBe('number');
      expect(typeof status.runningAgents).toBe('number');
    });
  });

  // ==================== /agents ====================
  describe('/agents command', () => {
    it('should list agents (may be empty)', async () => {
      const result = await remoteAgents();

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const data = result.data.result as { agents: unknown[] };
      expect(Array.isArray(data.agents)).toBe(true);
    });
  });

  // ==================== /spawn ====================
  describe('/spawn command', () => {
    const spawnAgentName = `${TEST_PREFIX}-spawn`;

    afterAll(async () => {
      // Cleanup spawned agent
      try {
        await remoteDelete(spawnAgentName);
      } catch {
        // Ignore
      }
    });

    it('should spawn a new agent with default model', async () => {
      createdAgents.push(spawnAgentName);

      const result = await remoteSpawn(spawnAgentName);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const agent = result.data.result as {
        name: string;
        id: string;
        port: number;
        status: string;
      };
      expect(agent.name).toBe(spawnAgentName);
      expect(agent.id).toBeDefined();
      expect(agent.port).toBeGreaterThan(0);
      expect(agent.status).toBe('running');
    }, 60000);

    it('should list the spawned agent', async () => {
      const result = await remoteAgents();

      expect(result.ok).toBe(true);
      const data = result.data.result as { agents: Array<{ name: string }> };
      const agent = data.agents.find((a) => a.name === spawnAgentName);
      expect(agent).toBeDefined();
    });

    it('should fail to spawn agent with duplicate name', async () => {
      const result = await remoteSpawn(spawnAgentName);

      // Should return error - either wrapped in ok:false or as HTTP error
      if (result.ok) {
        expect(result.data.ok).toBe(false);
        expect(result.data.error).toBeDefined();
      } else {
        // HTTP error response
        expect((result.data as { error: string }).error).toBeDefined();
      }
    });

    it('should spawn agent with specific model', async () => {
      const modelAgentName = `${TEST_PREFIX}-model`;
      createdAgents.push(modelAgentName);

      const result = await remote(`/spawn ${modelAgentName} --model sonnet`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const agent = result.data.result as { name: string; model: string };
      expect(agent.name).toBe(modelAgentName);
    }, 60000);
  });

  // ==================== /deploy ====================
  describe('/deploy command', () => {
    const deployAgentName = `${TEST_PREFIX}-deploy`;

    afterAll(async () => {
      try {
        await remoteDelete(deployAgentName);
      } catch {
        // Ignore
      }
    });

    it('should deploy agent from test config', async () => {
      createdAgents.push(deployAgentName);

      const result = await remoteDeploy('test', { name: deployAgentName });

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const deployResult = result.data.result as {
        deployed: number;
        failed: number;
        agents: Array<{ name: string; success: boolean }>;
      };
      expect(deployResult.deployed).toBe(1);
      expect(deployResult.failed).toBe(0);
      expect(deployResult.agents[0].name).toBe(deployAgentName);
      expect(deployResult.agents[0].success).toBe(true);
    }, 60000);

    it('should fail to deploy with non-existent config', async () => {
      const result = await remoteDeploy('nonexistent-config-xyz');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('not found');
    });
  });

  // ==================== /ask and /news ====================
  describe('/ask and /news commands', () => {
    const askAgentName = `${TEST_PREFIX}-ask`;

    beforeAll(async () => {
      // Spawn an agent for messaging tests
      createdAgents.push(askAgentName);
      await remoteSpawn(askAgentName);
      await waitForAgent(askAgentName, 30000);
    }, 60000);

    afterAll(async () => {
      try {
        await remoteDelete(askAgentName);
      } catch {
        // Ignore
      }
    });

    it('should send a message to agent via /ask', async () => {
      const result = await remoteAsk(askAgentName, 'What is 2+2? Reply with just the number.');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const askResult = result.data.result as { queryId: string };
      expect(askResult.queryId).toBeDefined();
    });

    it('should get news feed via /news', async () => {
      // Wait a bit for any processing
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const result = await remoteNews(askAgentName);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const newsResult = result.data.result as { items: unknown[] };
      expect(Array.isArray(newsResult.items)).toBe(true);
    });

    it('should fail /ask for non-existent agent', async () => {
      const result = await remoteAsk('nonexistent-agent-xyz', 'hello');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toBeDefined();
    });

    it('should fail /news for non-existent agent', async () => {
      const result = await remoteNews('nonexistent-agent-xyz');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toBeDefined();
    });
  });

  // ==================== /delete ====================
  describe('/delete command', () => {
    const deleteAgentName = `${TEST_PREFIX}-delete`;

    beforeAll(async () => {
      // Spawn an agent to delete
      await remoteSpawn(deleteAgentName);
      await waitForAgent(deleteAgentName, 30000);
    }, 60000);

    it('should delete an existing agent', async () => {
      const result = await remoteDelete(deleteAgentName);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const deleteResult = result.data.result as { deleted: string };
      expect(deleteResult.deleted).toBe(deleteAgentName);
    });

    it('should no longer list deleted agent', async () => {
      const result = await remoteAgents();

      expect(result.ok).toBe(true);
      const data = result.data.result as { agents: Array<{ name: string }> };
      const agent = data.agents.find((a) => a.name === deleteAgentName);
      expect(agent).toBeUndefined();
    });

    it('should fail to delete non-existent agent', async () => {
      const result = await remoteDelete('nonexistent-agent-xyz');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('not found');
    });
  });

  // ==================== Error Handling ====================
  describe('Error handling', () => {
    it('should return error for unknown command', async () => {
      const result = await remote('/unknown-command-xyz');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('Unknown command');
    });

    it('should return error for empty command', async () => {
      const result = await remote('');

      // Empty command returns HTTP 400 with error message
      expect(result.ok).toBe(false);
      expect((result.data as { error: string }).error).toContain('Missing command');
    });

    it('should return error for malformed command', async () => {
      const result = await remote('/spawn'); // Missing agent name

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('Usage');
    });
  });

  // ==================== /hey (alias for /ask) ====================
  describe('/hey command (alias)', () => {
    const heyAgentName = `${TEST_PREFIX}-hey`;

    beforeAll(async () => {
      createdAgents.push(heyAgentName);
      await remoteSpawn(heyAgentName);
      await waitForAgent(heyAgentName, 30000);
    }, 60000);

    afterAll(async () => {
      try {
        await remoteDelete(heyAgentName);
      } catch {
        // Ignore
      }
    });

    it('should send a message using /hey alias', async () => {
      const result = await remote(`/hey ${heyAgentName} Hello!`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const heyResult = result.data.result as { queryId: string };
      expect(heyResult.queryId).toBeDefined();
    });
  });

  // ==================== /agent command ====================
  describe('/agent command', () => {
    const agentCtrlName = `${TEST_PREFIX}-agentctrl`;

    beforeAll(async () => {
      createdAgents.push(agentCtrlName);
      await remoteSpawn(agentCtrlName);
      await waitForAgent(agentCtrlName, 30000);
    }, 60000);

    afterAll(async () => {
      try {
        await remoteDelete(agentCtrlName);
      } catch {
        // Ignore
      }
    });

    it('should get agent logs via /agent <name> logs', async () => {
      const result = await remote(`/agent ${agentCtrlName} logs`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const logsResult = result.data.result as { name: string; logs: string };
      expect(logsResult.name).toBe(agentCtrlName);
      expect(logsResult.logs).toBeDefined();
      expect(logsResult.logs).toContain('Starting'); // Logs should contain startup message
    });

    it('should stop agent via /agent <name> stop', async () => {
      const result = await remote(`/agent ${agentCtrlName} stop`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const stopResult = result.data.result as { action: string; name: string };
      expect(stopResult.action).toBe('stopped');
      expect(stopResult.name).toBe(agentCtrlName);
    });

    it('should start agent via /agent <name> start', async () => {
      const result = await remote(`/agent ${agentCtrlName} start`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const startResult = result.data.result as { action: string; name: string; port: number };
      expect(startResult.action).toBe('started');
      expect(startResult.name).toBe(agentCtrlName);
      expect(startResult.port).toBeGreaterThan(0);
    }, 30000);

    it('should rebuild agent via /agent <name> rebuild', async () => {
      const result = await remote(`/agent ${agentCtrlName} rebuild`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const rebuildResult = result.data.result as { action: string; name: string; port: number };
      expect(rebuildResult.action).toBe('rebuilt');
      expect(rebuildResult.name).toBe(agentCtrlName);
      expect(rebuildResult.port).toBeGreaterThan(0);
    }, 30000);

    it('should fail for non-existent agent', async () => {
      const result = await remote('/agent nonexistent-xyz stop');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('not found');
    });

    it('should fail for invalid action', async () => {
      const result = await remote(`/agent ${agentCtrlName} invalid-action`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('Unknown agent action');
    });
  });

  // ==================== /model command ====================
  describe('/model command', () => {
    const modelAgentName = `${TEST_PREFIX}-modeltest`;

    beforeAll(async () => {
      createdAgents.push(modelAgentName);
      await remoteSpawn(modelAgentName);
      await waitForAgent(modelAgentName, 30000);
    }, 60000);

    afterAll(async () => {
      try {
        await remoteDelete(modelAgentName);
      } catch {
        // Ignore
      }
    });

    it('should change agent model via /model', async () => {
      const result = await remote(`/model ${modelAgentName} sonnet`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);

      const modelResult = result.data.result as { name: string; model: string };
      expect(modelResult.name).toBe(modelAgentName);
      expect(modelResult.model).toContain('sonnet');
    }, 30000);

    it('should fail for non-existent agent', async () => {
      const result = await remote('/model nonexistent-xyz sonnet');

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('not found');
    });

    it('should fail without model parameter', async () => {
      const result = await remote(`/model ${modelAgentName}`);

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(false);
      expect(result.data.error).toContain('Usage');
    });
  });
});
