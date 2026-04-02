// SPDX-License-Identifier: MIT
/**
 * RequireAuth Config Integration Tests
 *
 * Tests that:
 * 1. Agents deployed with requireAuth: true reject unauthenticated requests
 * 2. Agents accept requests with valid manager-issued API keys
 * 3. External clients can use API keys to ask questions
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 *
 * Run with: npm test -- tests/integration/require-auth-config.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  waitForManager,
  waitForAgent,
  remote,
  remoteDelete,
  listAgents,
} from '../helpers/manager-client.js';

import * as fs from 'fs';
import * as path from 'path';

function readEnvFile(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env');
  const vars: Record<string, string> = {};
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          vars[trimmed.substring(0, eqIndex)] = trimmed.substring(eqIndex + 1);
        }
      }
    }
  } catch { /* ignore */ }
  return vars;
}

const envVars = readEnvFile();
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:3100';
const CONTROL_API_KEY = process.env.ID_CONTROL_API_KEY || envVars.ID_CONTROL_API_KEY;
const AGENT_API_KEY = process.env.ID_AGENT_API_KEY || envVars.ID_AGENT_API_KEY;

const TEST_AGENT = `require-auth-test-${Date.now()}`;

let agentPort: number | null = null;
let issuedKey: string | null = null;
let issuedKeyId: string | null = null;

describe('RequireAuth Config', () => {
  beforeAll(async () => {
    if (!CONTROL_API_KEY) {
      throw new Error('ID_CONTROL_API_KEY not set in environment or .env file');
    }

    // Wait for manager
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy. Start the manager with `npm start` first.');
    }

    // Deploy agent using config with requireAuth: true
    console.log(`[Test] Deploying agent with requireAuth: true: ${TEST_AGENT}`);
    const deployResult = await remote(`/deploy test-require-auth name=${TEST_AGENT}`);

    if (!deployResult.ok) {
      throw new Error(`Failed to deploy agent: ${JSON.stringify(deployResult.data)}`);
    }

    const isReady = await waitForAgent(TEST_AGENT, 90000);
    if (!isReady) {
      throw new Error('Agent failed to start');
    }

    // Get agent port
    const agents = await listAgents();
    const agent = agents.data.find((a: any) => a.name === TEST_AGENT);
    if (!agent?.port) {
      throw new Error(`Could not find agent port for ${TEST_AGENT}`);
    }
    agentPort = agent.port;
    console.log(`[Test] Agent running on port ${agentPort}`);
  }, 120000);

  afterAll(async () => {
    // Cleanup: revoke key and delete agent
    if (issuedKeyId) {
      try {
        await fetch(`${MANAGER_URL}/keys/${issuedKeyId}`, {
          method: 'DELETE',
          headers: { 'X-API-Key': CONTROL_API_KEY! }
        });
      } catch { /* ignore */ }
    }

    try {
      await remoteDelete(TEST_AGENT);
    } catch { /* ignore */ }
  });

  describe('Unauthenticated Access', () => {
    it('should allow health check without auth', async () => {
      const response = await fetch(`http://localhost:${agentPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('should allow discovery without auth', async () => {
      const response = await fetch(`http://localhost:${agentPort}/.well-known/restap.json`);
      expect(response.ok).toBe(true);
    });

    it('should reject /talk without API key', async () => {
      const response = await fetch(`http://localhost:${agentPort}/talk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'What is 2+2?' })
      });

      // Should get 401 Unauthorized
      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toContain('API key');
    });
  });

  describe('Issue and Use API Key', () => {
    it('should issue a client API key', async () => {
      const response = await fetch(`${MANAGER_URL}/keys/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': CONTROL_API_KEY!
        },
        body: JSON.stringify({
          name: 'require-auth-test-client',
          scopes: ['talk'],
          expires_in_days: 1
        })
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { ok: boolean; key: string; prefix: string };

      expect(data.ok).toBe(true);
      expect(data.key).toMatch(/^sk-id-/);

      issuedKey = data.key;
      console.log(`[Test] Issued key: ${data.prefix}...`);

      // Get key ID for cleanup
      const listResponse = await fetch(`${MANAGER_URL}/keys`, {
        headers: { 'X-API-Key': CONTROL_API_KEY! }
      });
      const listData = await listResponse.json() as { keys: Array<{ id: string; name: string }> };
      const testKey = listData.keys.find(k => k.name === 'require-auth-test-client');
      issuedKeyId = testKey?.id || null;
    });

    it('should accept /talk with valid API key and answer math question', async () => {
      expect(issuedKey).not.toBeNull();

      // Send the question
      const talkResponse = await fetch(`http://localhost:${agentPort}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': issuedKey!
        },
        body: JSON.stringify({
          message: 'What is 2+2? Reply with just the number.',
          from: 'test-client'
        })
      });

      expect(talkResponse.status).toBeLessThan(400);
      const talkData = await talkResponse.json() as { query_id?: string };
      expect(talkData.query_id).toBeDefined();

      console.log(`[Test] Query submitted: ${talkData.query_id}`);

      // Poll for result
      const maxAttempts = 30;
      let answer: string | null = null;

      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));

        const newsResponse = await fetch(
          `http://localhost:${agentPort}/news?since=0&query_id=${talkData.query_id}`,
          { headers: { 'X-API-Key': issuedKey! } }
        );

        if (!newsResponse.ok) continue;

        const newsData = await newsResponse.json() as { items: Array<{ type: string; message?: string }> };
        const resultItem = newsData.items?.find(item => item.type === 'result');

        if (resultItem?.message) {
          answer = resultItem.message;
          break;
        }
      }

      expect(answer).not.toBeNull();
      console.log(`[Test] Agent answer: ${answer}`);

      // Check that the answer contains "4"
      expect(answer).toMatch(/4/);
    }, 90000);

    it('should reject requests with invalid API key', async () => {
      const response = await fetch(`http://localhost:${agentPort}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'sk-id-invalid-key-12345'
        },
        body: JSON.stringify({ message: 'Hello' })
      });

      expect(response.status).toBe(401);
    });
  });

  describe('Inter-Agent Communication', () => {
    it('should accept requests with ID_AGENT_API_KEY (trusted inter-agent)', async () => {
      expect(AGENT_API_KEY).toBeDefined();

      const response = await fetch(`http://localhost:${agentPort}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': AGENT_API_KEY!
        },
        body: JSON.stringify({
          message: 'Hello from another agent',
          from: 'trusted-agent'
        })
      });

      // Should be accepted (trusted)
      expect(response.status).toBeLessThan(400);
    });
  });
});
