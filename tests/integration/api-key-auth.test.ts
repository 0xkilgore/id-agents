// SPDX-License-Identifier: MIT
/**
 * API Key Authentication Tests
 *
 * Tests that:
 * 1. Manager can issue API keys
 * 2. Agents can validate issued keys via manager
 * 3. Invalid/revoked keys are rejected
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 *
 * Run with: npm test -- tests/integration/api-key-auth.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  waitForManager,
  waitForAgent,
  remoteDeploy,
  remoteDelete,
  listAgents,
} from '../helpers/manager-client.js';

const TEST_AGENT = `auth-test-${Date.now()}`;
const MANAGER_URL = process.env.MANAGER_URL || 'http://localhost:3100';

// Read API keys from env or .env file
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
const CONTROL_API_KEY = process.env.ID_CONTROL_API_KEY || envVars.ID_CONTROL_API_KEY;
const AGENT_API_KEY = process.env.ID_AGENT_API_KEY || envVars.ID_AGENT_API_KEY;

let agentPort: number | null = null;
let issuedKeyId: string | null = null;
let issuedKey: string | null = null;

describe('API Key Authentication', () => {
  beforeAll(async () => {
    if (!CONTROL_API_KEY) {
      throw new Error('ID_CONTROL_API_KEY not set in environment or .env file');
    }

    // Wait for manager
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy. Start the manager with `npm start` first.');
    }

    // Deploy test agent
    console.log(`[Test] Deploying agent: ${TEST_AGENT}`);
    const deployResult = await remoteDeploy('test', { name: TEST_AGENT });
    if (!deployResult.ok) {
      throw new Error(`Failed to deploy agent: ${JSON.stringify(deployResult.data)}`);
    }

    const isReady = await waitForAgent(TEST_AGENT, 60000);
    if (!isReady) {
      throw new Error('Agent failed to start');
    }

    // Get agent port
    const agents = await listAgents();
    const agent = agents.data.find((a) => a.name === TEST_AGENT || a.name.startsWith(TEST_AGENT));
    if (!agent?.port) {
      throw new Error('Could not find agent port');
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
          headers: { 'X-API-Key': CONTROL_API_KEY }
        });
      } catch { /* ignore */ }
    }

    try {
      await remoteDelete(TEST_AGENT);
    } catch { /* ignore */ }
  });

  describe('Key Management (Manager)', () => {
    it('should issue a new API key', async () => {
      const response = await fetch(`${MANAGER_URL}/keys/issue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': CONTROL_API_KEY
        },
        body: JSON.stringify({
          name: 'test-client',
          scopes: ['talk'],
          expires_in_days: 1
        })
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as {
        ok: boolean;
        key: string;
        prefix: string;
        name: string;
      };

      expect(data.ok).toBe(true);
      expect(data.key).toMatch(/^sk-id-/);
      expect(data.name).toBe('test-client');

      issuedKey = data.key;
      console.log(`[Test] Issued key: ${data.prefix}...`);
    });

    it('should list issued keys', async () => {
      const response = await fetch(`${MANAGER_URL}/keys`, {
        headers: { 'X-API-Key': CONTROL_API_KEY }
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { keys: Array<{ id: string; name: string; status: string }> };

      expect(Array.isArray(data.keys)).toBe(true);
      const testKey = data.keys.find(k => k.name === 'test-client');
      expect(testKey).toBeDefined();
      expect(testKey?.status).toBe('active');

      issuedKeyId = testKey?.id || null;
    });

    it('should validate a valid key', async () => {
      expect(issuedKey).not.toBeNull();
      expect(AGENT_API_KEY).toBeDefined();

      const response = await fetch(`${MANAGER_URL}/keys/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': AGENT_API_KEY!
        },
        body: JSON.stringify({ key: issuedKey })
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { valid: boolean; name?: string };

      expect(data.valid).toBe(true);
      expect(data.name).toBe('test-client');
    });

    it('should reject an invalid key', async () => {
      const response = await fetch(`${MANAGER_URL}/keys/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': AGENT_API_KEY!
        },
        body: JSON.stringify({ key: 'sk-id-invalid-key-12345' })
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { valid: boolean; reason?: string };

      expect(data.valid).toBe(false);
      expect(data.reason).toBe('Key not found');
    });
  });

  describe('Agent Authentication', () => {
    it('should accept requests with valid issued key', async () => {
      expect(agentPort).not.toBeNull();
      expect(issuedKey).not.toBeNull();

      // Note: Agent needs ID_REQUIRE_CLIENT_AUTH=true to enforce auth
      // For this test, we're just verifying the flow works
      const response = await fetch(`http://localhost:${agentPort}/talk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': issuedKey!
        },
        body: JSON.stringify({
          message: 'Hello, this is an authenticated request',
          from: 'auth-test'
        })
      });

      // Should be accepted (202) or work
      expect(response.status).toBeLessThan(400);
      const data = await response.json();
      expect(data).toBeDefined();
    });

    it('should accept requests with inter-agent key', async () => {
      expect(agentPort).not.toBeNull();
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

      expect(response.status).toBeLessThan(400);
    });

    it('should allow health check without auth', async () => {
      expect(agentPort).not.toBeNull();

      const response = await fetch(`http://localhost:${agentPort}/health`);
      expect(response.ok).toBe(true);
    });

    it('should allow discovery without auth', async () => {
      expect(agentPort).not.toBeNull();

      const response = await fetch(`http://localhost:${agentPort}/.well-known/restap.json`);
      expect(response.ok).toBe(true);
    });
  });

  describe('Key Revocation', () => {
    it('should revoke a key', async () => {
      expect(issuedKeyId).not.toBeNull();

      const response = await fetch(`${MANAGER_URL}/keys/${issuedKeyId}`, {
        method: 'DELETE',
        headers: { 'X-API-Key': CONTROL_API_KEY }
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { ok: boolean };
      expect(data.ok).toBe(true);
    });

    it('should reject validation of revoked key', async () => {
      expect(issuedKey).not.toBeNull();

      const response = await fetch(`${MANAGER_URL}/keys/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': AGENT_API_KEY!
        },
        body: JSON.stringify({ key: issuedKey })
      });

      expect(response.ok).toBe(true);
      const data = await response.json() as { valid: boolean; reason?: string };

      expect(data.valid).toBe(false);
      expect(data.reason).toBe('Key has been revoked');

      // Clear so afterAll doesn't try to delete again
      issuedKeyId = null;
    });
  });
});
