// SPDX-License-Identifier: MIT
/**
 * Agent Lifecycle Integration Tests
 *
 * Tests the Manager API directly (like the CLI does)
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 * - ANTHROPIC_API_KEY must be set
 *
 * Run with: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  waitForManager,
  waitForAgent,
  getHealth,
  listAgents,
  spawnAgent,
  deleteAgentByName,
  remoteStatus,
  askAndWait,
} from '../helpers/manager-client.js';

const TEST_AGENT = `test-agent-${Date.now()}`;

describe('Agent Lifecycle', () => {
  beforeAll(async () => {
    // Wait for Manager to be healthy
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error(
        'Manager not healthy. Make sure to start the manager with `npm start` before running tests.'
      );
    }
  });

  afterAll(async () => {
    // Clean up: delete test agent
    try {
      await deleteAgentByName(TEST_AGENT);
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('Manager Health', () => {
    it('should return healthy status', async () => {
      const result = await getHealth();

      expect(result.ok).toBe(true);
    });

    it('should show status via /remote', async () => {
      const result = await remoteStatus();

      expect(result.ok).toBe(true);
      expect(result.data.ok).toBe(true);
      expect(result.data.result).toBeDefined();
    });
  });

  describe('Agent Spawning', () => {
    it('should spawn a new claude agent', async () => {
      const result = await spawnAgent(TEST_AGENT, {
        model: 'haiku',
        systemPrompt: 'You are a helpful math assistant. Answer questions concisely with just the answer.',
      });

      expect(result.ok).toBe(true);
      expect(result.data.name).toBe(TEST_AGENT);
      expect(result.data.type).toBe('claude');
      expect(result.data.status).toBe('running');
      expect(result.data.port).toBeGreaterThan(0);
    }, 60000); // 1 minute timeout for spawn

    it('should list the spawned agent', async () => {
      const result = await listAgents();

      expect(result.ok).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);

      const agent = result.data.find((a) => a.name === TEST_AGENT);
      expect(agent).toBeDefined();
      expect(agent?.type).toBe('claude');
      expect(agent?.status).toBe('running');
    });

    it('should have correct agent properties', async () => {
      const result = await listAgents();
      const agent = result.data.find((a) => a.name === TEST_AGENT);

      expect(agent).toBeDefined();
      expect(agent?.name).toBe(TEST_AGENT);
      expect(agent?.type).toBe('claude');
      expect(agent?.status).toBe('running');
      expect(agent?.port).toBeGreaterThan(0);
      expect(agent?.model).toBe('haiku');
    });

    it('should reject invalid runtime/model combinations at spawn time', async () => {
      const invalidAgentName = `${TEST_AGENT}-invalid`;
      const result = await spawnAgent(invalidAgentName, {
        runtime: 'claude-agent-sdk',
        model: 'gpt-5.4',
        systemPrompt: 'This should be rejected by runtime validation.',
      });

      expect(result.ok).toBe(false);
      expect((result.data as any).error).toContain('incompatible with OpenAI model');
    });
  });

  describe('Agent Messaging', () => {
    it('should ask agent a simple math question and get correct answer', async () => {
      // Wait for agent to be fully ready
      const isReady = await waitForAgent(TEST_AGENT, 60000);
      expect(isReady).toBe(true);

      // Ask 2+2 - a simple question to verify agent is working
      // Note: This test involves a full Claude API round-trip which can be slow
      const result = await askAndWait(
        TEST_AGENT,
        'What is 2+2? Reply with just the number.',
        180000, // 3 minute wait for Claude API response
        3000    // Poll every 3 seconds
      );

      expect(result.success).toBe(true);
      expect(result.response).toBeDefined();
      // The response should contain "4" somewhere
      expect(result.response).toContain('4');
    }, 240000); // 4 minute timeout for full test
  });

  describe('Agent Cleanup', () => {
    it('should delete the test agent', async () => {
      const result = await deleteAgentByName(TEST_AGENT);

      expect(result.ok).toBe(true);
    });

    it('should no longer list the deleted agent', async () => {
      const result = await listAgents();

      expect(result.ok).toBe(true);
      const agent = result.data.find((a) => a.name === TEST_AGENT);
      expect(agent).toBeUndefined();
    });
  });
});
