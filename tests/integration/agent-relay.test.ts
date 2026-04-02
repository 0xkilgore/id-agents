// SPDX-License-Identifier: MIT
/**
 * Agent Relay Tests (Pizza & Color Tests)
 *
 * Tests that agents can relay information to each other:
 * 1. Tell Agent A a fact (favorite food/color)
 * 2. Agent A tells Agent B
 * 3. Ask Agent B what Agent A's favorite is
 *
 * Prerequisites:
 * - Manager must be running (`npm start` in CLI)
 *
 * Run with: npm test -- tests/integration/agent-relay.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  waitForManager,
  waitForAgent,
  remoteDeploy,
  remoteDelete,
  listAgents,
} from '../helpers/manager-client.js';

const AGENT_A = `relay-a-${Date.now()}`;
const AGENT_B = `relay-b-${Date.now()}`;

let agentAPort: number | null = null;
let agentBPort: number | null = null;

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
        reply_endpoint: null, // We'll poll for response
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
      await new Promise((r) => setTimeout(r, 3000)); // Poll every 3 seconds

      const newsRes = await fetch(`http://localhost:${port}/news?since=0`);
      if (!newsRes.ok) continue;

      const news = await newsRes.json() as { items: Array<{ type: string; data?: { query_id?: string; result?: { result: string } } }> };

      // Find completed response for our query
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

// Extract JSON from agent response (agents sometimes wrap JSON in markdown)
function extractJson(text: string): Record<string, unknown> | null {
  // Try to find JSON in code blocks first
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1].trim());
    } catch {
      // Continue to try other patterns
    }
  }

  // Try to find raw JSON object
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

describe('Agent Relay Tests', () => {
  beforeAll(async () => {
    // Wait for manager
    const isHealthy = await waitForManager(30000);
    if (!isHealthy) {
      throw new Error('Manager not healthy. Start the manager with `npm start` first.');
    }

    // Deploy two agents
    console.log(`[Test] Deploying agents: ${AGENT_A}, ${AGENT_B}`);

    const deployA = await remoteDeploy('test', { name: AGENT_A });
    if (!deployA.ok) {
      throw new Error(`Failed to deploy ${AGENT_A}: ${JSON.stringify(deployA.data)}`);
    }

    const deployB = await remoteDeploy('test', { name: AGENT_B });
    if (!deployB.ok) {
      throw new Error(`Failed to deploy ${AGENT_B}: ${JSON.stringify(deployB.data)}`);
    }

    // Wait for both agents
    const readyA = await waitForAgent(AGENT_A, 60000);
    const readyB = await waitForAgent(AGENT_B, 60000);

    if (!readyA || !readyB) {
      throw new Error('Agents failed to start');
    }

    // Get ports
    const agents = await listAgents();
    const agentA = agents.data.find((a) => a.name === AGENT_A || a.name.startsWith(AGENT_A));
    const agentB = agents.data.find((a) => a.name === AGENT_B || a.name.startsWith(AGENT_B));

    if (!agentA?.port || !agentB?.port) {
      throw new Error('Could not find agent ports');
    }

    agentAPort = agentA.port;
    agentBPort = agentB.port;

    console.log(`[Test] Agent A (${AGENT_A}) on port ${agentAPort}`);
    console.log(`[Test] Agent B (${AGENT_B}) on port ${agentBPort}`);
  }, 180000); // 3 min setup timeout

  afterAll(async () => {
    // Cleanup
    try {
      await remoteDelete(AGENT_A);
      await remoteDelete(AGENT_B);
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Pizza Test (Favorite Food)', () => {
    const SECRET_FOOD = 'pizza';

    it('should tell Agent A their favorite food', async () => {
      expect(agentAPort).not.toBeNull();

      const result = await talkToAgent(
        agentAPort!,
        `Remember this: Your favorite food is "${SECRET_FOOD}". ` +
        `When anyone asks about your favorite food, respond with JSON: {"favorite_food": "${SECRET_FOOD}"}`
      );

      expect(result.ok).toBe(true);
      expect(result.reply).toBeDefined();
      console.log(`[Test] Agent A acknowledged: ${result.reply?.substring(0, 100)}...`);
    }, 240000);

    it('should have Agent A tell Agent B about their favorite food', async () => {
      expect(agentAPort).not.toBeNull();

      // Get Agent B's name for the message
      const agents = await listAgents();
      const agentB = agents.data.find((a) => a.name === AGENT_B || a.name.startsWith(AGENT_B));
      const agentBName = agentB?.name || AGENT_B;

      const result = await talkToAgent(
        agentAPort!,
        `Use /talk-to to tell "${agentBName}" what your favorite food is. ` +
        `Tell them: "My favorite food is ${SECRET_FOOD}. Remember this for later."`
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Agent A relay result: ${result.reply?.substring(0, 200)}...`);
    }, 300000); // 5 min for inter-agent communication

    it('should ask Agent B what Agent A\'s favorite food is', async () => {
      expect(agentBPort).not.toBeNull();

      // Get Agent A's name
      const agents = await listAgents();
      const agentA = agents.data.find((a) => a.name === AGENT_A || a.name.startsWith(AGENT_A));
      const agentAName = agentA?.name || AGENT_A;

      const result = await talkToAgent(
        agentBPort!,
        `What is ${agentAName}'s favorite food? ` +
        `Respond with ONLY a JSON object: {"agent": "${agentAName}", "favorite_food": "..."}`
      );

      expect(result.ok).toBe(true);
      expect(result.reply).toBeDefined();

      console.log(`[Test] Agent B response: ${result.reply}`);

      // Try to extract JSON
      const json = extractJson(result.reply!);
      if (json) {
        expect(json.favorite_food).toBe(SECRET_FOOD);
      } else {
        // Fallback: check if response contains the food
        expect(result.reply!.toLowerCase()).toContain(SECRET_FOOD);
      }
    }, 240000);
  });

  describe('Color Test (Favorite Color)', () => {
    const SECRET_COLOR = 'blue';

    it('should tell Agent B their favorite color', async () => {
      expect(agentBPort).not.toBeNull();

      const result = await talkToAgent(
        agentBPort!,
        `Remember this: Your favorite color is "${SECRET_COLOR}". ` +
        `When anyone asks about your favorite color, respond with JSON: {"favorite_color": "${SECRET_COLOR}"}`
      );

      expect(result.ok).toBe(true);
      expect(result.reply).toBeDefined();
      console.log(`[Test] Agent B acknowledged: ${result.reply?.substring(0, 100)}...`);
    }, 240000);

    it('should have Agent B tell Agent A about their favorite color', async () => {
      expect(agentBPort).not.toBeNull();

      // Get Agent A's name
      const agents = await listAgents();
      const agentA = agents.data.find((a) => a.name === AGENT_A || a.name.startsWith(AGENT_A));
      const agentAName = agentA?.name || AGENT_A;

      const result = await talkToAgent(
        agentBPort!,
        `Use /talk-to to tell "${agentAName}" what your favorite color is. ` +
        `Tell them: "My favorite color is ${SECRET_COLOR}. Remember this for later."`
      );

      expect(result.ok).toBe(true);
      console.log(`[Test] Agent B relay result: ${result.reply?.substring(0, 200)}...`);
    }, 300000);

    it('should ask Agent A what Agent B\'s favorite color is', async () => {
      expect(agentAPort).not.toBeNull();

      // Get Agent B's name
      const agents = await listAgents();
      const agentB = agents.data.find((a) => a.name === AGENT_B || a.name.startsWith(AGENT_B));
      const agentBName = agentB?.name || AGENT_B;

      const result = await talkToAgent(
        agentAPort!,
        `What is ${agentBName}'s favorite color? ` +
        `Respond with ONLY a JSON object: {"agent": "${agentBName}", "favorite_color": "..."}`
      );

      expect(result.ok).toBe(true);
      expect(result.reply).toBeDefined();

      console.log(`[Test] Agent A response: ${result.reply}`);

      // Try to extract JSON
      const json = extractJson(result.reply!);
      if (json) {
        expect(json.favorite_color).toBe(SECRET_COLOR);
      } else {
        // Fallback: check if response contains the color
        expect(result.reply!.toLowerCase()).toContain(SECRET_COLOR);
      }
    }, 240000);
  });
});
