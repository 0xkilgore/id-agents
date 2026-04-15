// SPDX-License-Identifier: MIT
/**
 * /sync Command Integration Tests
 *
 * Tests the /sync reconciliation command and the /deploy orphan-process fix.
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 * - ANTHROPIC_API_KEY or Claude CLI auth must be available
 * - configs/default.yaml must exist (used for test deploys)
 *
 * Run with: npm test
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  waitForManager,
  listAgents,
  deleteAgentByName,
  remote,
  remoteSync,
} from '../helpers/manager-client.js';

const TEST_SUFFIX = Date.now().toString(36);
const TEST_CONFIG_PATH = `/tmp/sync-test-${TEST_SUFFIX}.yaml`;

const AGENT_A = `sync-a-${TEST_SUFFIX}`;
const AGENT_B = `sync-b-${TEST_SUFFIX}`;
const AGENT_C = `sync-c-${TEST_SUFFIX}`;

let yamlDump: (obj: any) => string;

describe('Sync Command', () => {
  beforeAll(async () => {
    const yaml = await import('js-yaml');
    yamlDump = yaml.default.dump;

    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy. Start the manager with `npm start` before running tests.');
    }
  });

  afterAll(async () => {
    // Clean up test agents
    for (const name of [AGENT_A, AGENT_B, AGENT_C]) {
      try { await deleteAgentByName(name); } catch { /* ignore */ }
    }
    // Clean up test config
    try { fs.unlinkSync(TEST_CONFIG_PATH); } catch { /* ignore */ }
  });

  function writeConfig(agents: Array<{ name: string; description?: string; model?: string }>) {
    const config = {
      version: '1',
      defaults: { model: 'claude-haiku-4-5-20251001' },
      agents: agents.map(a => ({
        name: a.name,
        description: a.description || `Test agent ${a.name}`,
        ...(a.model && { model: a.model }),
      })),
    };
    fs.writeFileSync(TEST_CONFIG_PATH, yamlDump(config));
  }

  describe('Sync dry-run', () => {
    it('should show plan without making changes', async () => {
      // First deploy two agents
      writeConfig([
        { name: AGENT_A, description: 'Agent A' },
        { name: AGENT_B, description: 'Agent B' },
      ]);

      const deployResult = await remote(`/deploy ${TEST_CONFIG_PATH}`);
      expect(deployResult.ok).toBe(true);
      expect((deployResult.data as any).ok).toBe(true);

      // Wait for agents to start
      await new Promise(r => setTimeout(r, 3000));

      // Now write a modified config: change A's model, add C, remove B
      writeConfig([
        { name: AGENT_A, description: 'Agent A', model: 'claude-sonnet-4-6' },
        { name: AGENT_C, description: 'Agent C' },
      ]);

      // Run sync with --dry-run
      const syncResult = await remoteSync(TEST_CONFIG_PATH, {}, ['--dry-run']);
      expect(syncResult.ok).toBe(true);

      const data = (syncResult.data as any).result;
      expect(data.dryRun).toBe(true);
      expect(data.summary).toBeDefined();
      expect(data.plan).toBeDefined();

      // Verify plan categories
      expect(data.plan.added).toContain(AGENT_C);
      expect(data.plan.removed).toContain(AGENT_B);

      // A should be changed (model differs)
      const updatedNames = data.plan.updated.map((u: any) => typeof u === 'string' ? u : u.name);
      expect(updatedNames).toContain(AGENT_A);

      // Verify no actual changes were made — B should still be running
      const agents = await listAgents();
      const agentB = (agents.data as any[]).find((a: any) => a.name === AGENT_B);
      expect(agentB).toBeDefined();
    }, 120000);
  });

  describe('Sync execution', () => {
    it('should reconcile running team with config', async () => {
      // At this point, agents A and B are deployed from the dry-run test.
      // Config has A (changed model) and C (new), missing B (to remove).
      writeConfig([
        { name: AGENT_A, description: 'Agent A', model: 'claude-sonnet-4-6' },
        { name: AGENT_C, description: 'Agent C' },
      ]);

      const syncResult = await remoteSync(TEST_CONFIG_PATH);
      expect(syncResult.ok).toBe(true);

      const data = (syncResult.data as any).result;
      expect(data.added).toContain(AGENT_C);
      expect(data.removed).toContain(AGENT_B);
      expect(data.updated).toContain(AGENT_A);
      expect(data.summary).toBeDefined();

      // Wait for spawns
      await new Promise(r => setTimeout(r, 3000));

      // Verify final state
      const agents = await listAgents();
      const agentList = agents.data as any[];
      const names = agentList.map((a: any) => a.name);

      expect(names).toContain(AGENT_A);
      expect(names).toContain(AGENT_C);
      expect(names).not.toContain(AGENT_B);
    }, 120000);

    it('should preserve agent ID on in-place update', async () => {
      // Record A's current ID
      const agentsBefore = await listAgents();
      const agentA = (agentsBefore.data as any[]).find((a: any) => a.name === AGENT_A);
      const originalId = agentA?.id;
      expect(originalId).toBeDefined();

      // Sync again with a description change for A
      writeConfig([
        { name: AGENT_A, description: 'Agent A updated again', model: 'claude-sonnet-4-6' },
        { name: AGENT_C, description: 'Agent C' },
      ]);

      const syncResult = await remoteSync(TEST_CONFIG_PATH);
      expect(syncResult.ok).toBe(true);

      const data = (syncResult.data as any).result;
      expect(data.updated).toContain(AGENT_A);
      expect(data.unchanged).toContain(AGENT_C);

      // Wait for respawn
      await new Promise(r => setTimeout(r, 3000));

      // Verify A kept same ID
      const agentsAfter = await listAgents();
      const agentAAfter = (agentsAfter.data as any[]).find((a: any) => a.name === AGENT_A);
      expect(agentAAfter?.id).toBe(originalId);
    }, 120000);

    it('should skip unchanged agents', async () => {
      // Sync with same config — everything should be unchanged
      const syncResult = await remoteSync(TEST_CONFIG_PATH);
      expect(syncResult.ok).toBe(true);

      const data = (syncResult.data as any).result;
      expect(data.added.length).toBe(0);
      expect(data.removed.length).toBe(0);
      expect(data.updated.length).toBe(0);
      expect(data.unchanged.length).toBe(2);
    }, 60000);
  });
});

describe('Deploy orphan-process fix', () => {
  const ORPHAN_AGENT = `orphan-test-${TEST_SUFFIX}`;
  const ORPHAN_CONFIG_PATH = `/tmp/orphan-test-${TEST_SUFFIX}.yaml`;

  let yamlDump: (obj: any) => string;

  beforeAll(async () => {
    const yaml = await import('js-yaml');
    yamlDump = yaml.default.dump;

    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy.');
    }
  });

  afterAll(async () => {
    try { await deleteAgentByName(ORPHAN_AGENT); } catch { /* ignore */ }
    try { fs.unlinkSync(ORPHAN_CONFIG_PATH); } catch { /* ignore */ }
  });

  it('should kill old process when redeploying same agent', async () => {
    // Write config with one agent
    const config = {
      version: '1',
      defaults: { model: 'claude-haiku-4-5-20251001' },
      agents: [{ name: ORPHAN_AGENT, description: 'Orphan test' }],
    };
    fs.writeFileSync(ORPHAN_CONFIG_PATH, yamlDump(config));

    // Deploy
    const deploy1 = await remote(`/deploy ${ORPHAN_CONFIG_PATH}`);
    expect(deploy1.ok).toBe(true);
    expect((deploy1.data as any).ok).toBe(true);

    await new Promise(r => setTimeout(r, 3000));

    // Record old port
    const agents1 = await listAgents();
    const agent1 = (agents1.data as any[]).find((a: any) => a.name === ORPHAN_AGENT);
    expect(agent1).toBeDefined();
    const oldPort = agent1.port;

    // Redeploy same config — agent should get new port, old process should be killed
    const deploy2 = await remote(`/deploy ${ORPHAN_CONFIG_PATH}`);
    expect(deploy2.ok).toBe(true);
    expect((deploy2.data as any).ok).toBe(true);

    await new Promise(r => setTimeout(r, 3000));

    // Verify new port is different
    const agents2 = await listAgents();
    const agent2 = (agents2.data as any[]).find((a: any) => a.name === ORPHAN_AGENT);
    expect(agent2).toBeDefined();
    expect(agent2.port).not.toBe(oldPort);

    // Verify old port has no process (the fix)
    let oldPortInUse = false;
    try {
      const { execSync } = await import('child_process');
      execSync(`lsof -ti :${oldPort}`, { encoding: 'utf8' });
      oldPortInUse = true;
    } catch {
      oldPortInUse = false;
    }
    expect(oldPortInUse).toBe(false);
  }, 120000);
});
