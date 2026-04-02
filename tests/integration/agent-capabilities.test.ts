// SPDX-License-Identifier: MIT
/**
 * Agent Capabilities Tests
 *
 * Tests that verify agents can:
 * 1. Read shared files (org chart) and report their role
 * 2. Write and execute scripts to compute results that can't be guessed
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 *
 * Run with: npm test -- tests/integration/agent-capabilities.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  waitForManager,
  waitForAgent,
  remoteDeploy,
  remoteDelete,
  listAgents,
} from '../helpers/manager-client.js';

const AGENT_ALPHA = `cap-alpha-${Date.now()}`;
const AGENT_BETA = `cap-beta-${Date.now()}`;
const AGENT_GAMMA = `cap-gamma-${Date.now()}`;

let agentAlphaPort: number | null = null;
let agentBetaPort: number | null = null;
let agentGammaPort: number | null = null;

const WORKSPACE_DIR = path.join(process.cwd(), 'workspace');
const SHARED_DIR = path.join(WORKSPACE_DIR, 'teams', 'default', 'shared');

// Helper to send message to agent and wait for response
async function talkToAgent(
  port: number,
  message: string,
  timeoutMs = 180000
): Promise<{ ok: boolean; reply?: string; error?: string }> {
  try {
    const response = await fetch(`http://localhost:${port}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        from: 'test-runner',
      }),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json() as { query_id?: string };
    const queryId = data.query_id;

    // Poll for response
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 3000));

      const newsRes = await fetch(`http://localhost:${port}/news?since=0`);
      if (!newsRes.ok) continue;

      const news = await newsRes.json() as { items: Array<{ type: string; data?: { query_id?: string; result?: { result: string } } }> };

      const completed = news.items?.find(
        (item) => item.type === 'query.completed' && item.data?.query_id === queryId
      );

      if (completed?.data?.result?.result) {
        return { ok: true, reply: completed.data.result.result };
      }
    }

    return { ok: false, error: 'Timeout waiting for response' };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Extract JSON from agent response
function extractJson(text: string): Record<string, unknown> | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch { /* continue */ }
  }

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* continue */ }
  }

  return null;
}

// Extract a number from text
function extractNumber(text: string): number | null {
  // Look for a number that might be the answer (could be in JSON or plain text)
  const json = extractJson(text);
  if (json && typeof json.result === 'number') {
    return json.result;
  }
  if (json && typeof json.sum === 'number') {
    return json.sum;
  }
  if (json && typeof json.answer === 'number') {
    return json.answer;
  }

  // Try to find a standalone number (the final answer)
  // Look for patterns like "result is 465" or "= 465" or just "465"
  const patterns = [
    /(?:result|answer|sum|total)\s*(?:is|=|:)\s*(\d+)/i,
    /=\s*(\d+)\s*$/m,
    /\b(\d{2,})\b/  // At least 2 digits to avoid matching small numbers
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

describe('Agent Capabilities Tests', () => {
  beforeAll(async () => {
    // Wait for manager
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy. Start the manager with `npm start` first.');
    }

    // Create shared directory and org chart
    fs.mkdirSync(SHARED_DIR, { recursive: true });

    // Deploy three agents
    console.log(`[Test] Deploying agents: ${AGENT_ALPHA}, ${AGENT_BETA}, ${AGENT_GAMMA}`);

    const deployAlpha = await remoteDeploy('test', { name: AGENT_ALPHA });
    const deployBeta = await remoteDeploy('test', { name: AGENT_BETA });
    const deployGamma = await remoteDeploy('test', { name: AGENT_GAMMA });

    if (!deployAlpha.ok || !deployBeta.ok || !deployGamma.ok) {
      throw new Error('Failed to deploy agents');
    }

    // Wait for all agents
    const readyAlpha = await waitForAgent(AGENT_ALPHA, 60000);
    const readyBeta = await waitForAgent(AGENT_BETA, 60000);
    const readyGamma = await waitForAgent(AGENT_GAMMA, 60000);

    if (!readyAlpha || !readyBeta || !readyGamma) {
      throw new Error('Agents failed to start');
    }

    // Get ports
    const agents = await listAgents();
    const findAgent = (name: string) => agents.data.find((a) =>
      a.name === name || a.name.startsWith(name)
    );

    const alphaAgent = findAgent(AGENT_ALPHA);
    const betaAgent = findAgent(AGENT_BETA);
    const gammaAgent = findAgent(AGENT_GAMMA);

    if (!alphaAgent?.port || !betaAgent?.port || !gammaAgent?.port) {
      throw new Error('Could not find agent ports');
    }

    agentAlphaPort = alphaAgent.port;
    agentBetaPort = betaAgent.port;
    agentGammaPort = gammaAgent.port;

    // Create org chart file with agent names
    const orgChart = {
      organization: 'Test Corp',
      created: new Date().toISOString(),
      roles: {
        [alphaAgent.name]: {
          title: 'Chief Technology Officer',
          department: 'Engineering',
          reports_to: 'CEO',
          responsibilities: ['Technical strategy', 'Engineering leadership', 'Architecture decisions']
        },
        [betaAgent.name]: {
          title: 'Senior Software Engineer',
          department: 'Engineering',
          reports_to: alphaAgent.name,
          responsibilities: ['Backend development', 'Code reviews', 'Mentoring']
        },
        [gammaAgent.name]: {
          title: 'Product Manager',
          department: 'Product',
          reports_to: 'CEO',
          responsibilities: ['Product roadmap', 'Feature prioritization', 'Stakeholder communication']
        }
      }
    };

    const orgChartPath = path.join(SHARED_DIR, 'org-chart.json');
    fs.writeFileSync(orgChartPath, JSON.stringify(orgChart, null, 2));
    console.log(`[Test] Created org chart at ${orgChartPath}`);

    console.log(`[Test] Alpha (${AGENT_ALPHA}) on port ${agentAlphaPort}`);
    console.log(`[Test] Beta (${AGENT_BETA}) on port ${agentBetaPort}`);
    console.log(`[Test] Gamma (${AGENT_GAMMA}) on port ${agentGammaPort}`);
  }, 180000);

  afterAll(async () => {
    // Cleanup agents
    try {
      await remoteDelete(AGENT_ALPHA);
      await remoteDelete(AGENT_BETA);
      await remoteDelete(AGENT_GAMMA);
    } catch { /* ignore */ }

    // Cleanup shared files
    try {
      fs.rmSync(path.join(SHARED_DIR, 'org-chart.json'), { force: true });
    } catch { /* ignore */ }
  });

  describe('Org Chart Test - Read Shared File', () => {
    it('Alpha should read org chart and report their role as CTO', async () => {
      expect(agentAlphaPort).not.toBeNull();

      const result = await talkToAgent(
        agentAlphaPort!,
        `Read the file at /workspace/teams/default/shared/org-chart.json and find your role. ` +
        `Your agent name contains "${AGENT_ALPHA}". ` +
        `Respond with JSON: {"agent_name": "...", "title": "...", "department": "..."}`
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Alpha response: ${result.reply?.substring(0, 300)}`);

      const json = extractJson(result.reply!);
      expect(json).not.toBeNull();
      expect(json?.title).toBe('Chief Technology Officer');
      expect(json?.department).toBe('Engineering');
    }, 240000);

    it('Beta should read org chart and report their role as Senior Engineer', async () => {
      expect(agentBetaPort).not.toBeNull();

      const result = await talkToAgent(
        agentBetaPort!,
        `Read the file at /workspace/teams/default/shared/org-chart.json and find your role. ` +
        `Your agent name contains "${AGENT_BETA}". ` +
        `Respond with JSON: {"agent_name": "...", "title": "...", "reports_to": "..."}`
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Beta response: ${result.reply?.substring(0, 300)}`);

      const json = extractJson(result.reply!);
      expect(json).not.toBeNull();
      expect(json?.title).toBe('Senior Software Engineer');
    }, 240000);

    it('Gamma should read org chart and report their role as Product Manager', async () => {
      expect(agentGammaPort).not.toBeNull();

      const result = await talkToAgent(
        agentGammaPort!,
        `Read the file at /workspace/teams/default/shared/org-chart.json and find your role. ` +
        `Your agent name contains "${AGENT_GAMMA}". ` +
        `Respond with JSON: {"agent_name": "...", "title": "...", "department": "..."}`
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Gamma response: ${result.reply?.substring(0, 300)}`);

      const json = extractJson(result.reply!);
      expect(json).not.toBeNull();
      expect(json?.title).toBe('Product Manager');
      expect(json?.department).toBe('Product');
    }, 240000);
  });

  describe('Script Execution Test - Compute Sequence Sum', () => {
    // Sum of (i+1) for i from 0 to 29 = 1+2+3+...+30 = 30*31/2 = 465
    const EXPECTED_SUM = 465;
    const ITERATIONS = 30;

    it('Alpha should write and execute a script to compute the sequence sum', async () => {
      expect(agentAlphaPort).not.toBeNull();

      const result = await talkToAgent(
        agentAlphaPort!,
        `Write a script (bash, python, or node) that computes the sum of (i+1) for i from 0 to ${ITERATIONS - 1}. ` +
        `That is: (0+1) + (1+1) + (2+1) + ... + (${ITERATIONS - 1}+1) = 1 + 2 + 3 + ... + ${ITERATIONS}. ` +
        `Execute the script and respond with JSON: {"result": <the computed sum>}. ` +
        `Do NOT guess - you MUST execute code to compute this.`,
        300000 // 5 min timeout for script execution
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Alpha script result: ${result.reply?.substring(0, 500)}`);

      const num = extractNumber(result.reply!);
      expect(num).toBe(EXPECTED_SUM);
    }, 360000);

    // More complex: Fibonacci-like sequence
    // f(0)=1, f(1)=1, f(n)=f(n-1)+f(n-2) for n>=2
    // f(20) = 10946
    const FIB_N = 20;
    const EXPECTED_FIB = 10946;

    it('Beta should write and execute a script to compute fibonacci', async () => {
      expect(agentBetaPort).not.toBeNull();

      const result = await talkToAgent(
        agentBetaPort!,
        `Write a script to compute the ${FIB_N}th Fibonacci number. ` +
        `Use f(0)=1, f(1)=1, f(n)=f(n-1)+f(n-2) for n>=2. ` +
        `Execute the script and respond with JSON: {"n": ${FIB_N}, "result": <the computed value>}. ` +
        `Do NOT guess - you MUST execute code to compute this.`,
        300000
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Beta fibonacci result: ${result.reply?.substring(0, 500)}`);

      const num = extractNumber(result.reply!);
      expect(num).toBe(EXPECTED_FIB);
    }, 360000);

    // Prime counting: count primes up to 100
    // Primes <= 100: 2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97 = 25 primes
    const PRIME_LIMIT = 100;
    const EXPECTED_PRIME_COUNT = 25;

    it('Gamma should write and execute a script to count primes', async () => {
      expect(agentGammaPort).not.toBeNull();

      const result = await talkToAgent(
        agentGammaPort!,
        `Write a script to count how many prime numbers exist from 2 to ${PRIME_LIMIT} (inclusive). ` +
        `Execute the script and respond with JSON: {"limit": ${PRIME_LIMIT}, "prime_count": <the count>}. ` +
        `Do NOT guess - you MUST execute code to compute this.`,
        300000
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Gamma prime count result: ${result.reply?.substring(0, 500)}`);

      const json = extractJson(result.reply!);
      const count = json?.prime_count ?? extractNumber(result.reply!);
      expect(count).toBe(EXPECTED_PRIME_COUNT);
    }, 360000);
  });
});
