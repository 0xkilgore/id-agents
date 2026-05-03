// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  INTER_AGENT_SKILL,
  INTER_AGENT_SKILL_LIGHT,
  withInterAgentSkill,
} from '../../src/inter-agent-skill.js';

describe('INTER_AGENT_SKILL — catalog-aware delegation flow', () => {
  it('contains the exact "Choosing the right agent to delegate to" section title', () => {
    expect(INTER_AGENT_SKILL).toContain('## Choosing the right agent to delegate to');
  });

  it('teaches all four steps in order', () => {
    const idxStep1 = INTER_AGENT_SKILL.indexOf('Step 1');
    const idxStep2 = INTER_AGENT_SKILL.indexOf('Step 2');
    const idxStep3 = INTER_AGENT_SKILL.indexOf('Step 3');
    const idxStep4 = INTER_AGENT_SKILL.indexOf('Step 4');

    expect(idxStep1).toBeGreaterThan(0);
    expect(idxStep2).toBeGreaterThan(idxStep1);
    expect(idxStep3).toBeGreaterThan(idxStep2);
    expect(idxStep4).toBeGreaterThan(idxStep3);
  });

  it('Step 1 enumerates peers via GET /agents', () => {
    expect(INTER_AGENT_SKILL).toMatch(/Step 1[\s\S]{0,400}\/agents/);
  });

  it('Step 2 reads each candidate /catalog before /ask and names the four routing fields', () => {
    const step2Block = INTER_AGENT_SKILL.split('### Step 2')[1]?.split('### Step 3')[0] ?? '';
    expect(step2Block).toContain('/catalog');
    expect(step2Block).toContain('role');
    expect(step2Block).toContain('expertise');
    expect(step2Block).toContain('status');
    expect(step2Block).toContain('costTier');
    expect(step2Block).toContain('notSuitableFor');
  });

  it('Step 3 filters out unavailable peers and notSuitableFor matches', () => {
    const step3Block = INTER_AGENT_SKILL.split('### Step 3')[1]?.split('### Step 4')[0] ?? '';
    expect(step3Block).toMatch(/status\s*!==\s*"available"/);
    expect(step3Block).toContain('notSuitableFor');
  });

  it('Step 4 prefers specialist, prefers lower costTier, and forbids low costTier for sensitive work', () => {
    const step4Block = INTER_AGENT_SKILL.split('### Step 4')[1] ?? '';
    expect(step4Block).toMatch(/specialist/i);
    expect(step4Block).toMatch(/lower\s+`?costTier`?/i);
    expect(step4Block).toMatch(/never/i.source ? /never/i : /never/);
    // The three forbidden categories for costTier=low
    expect(step4Block).toMatch(/multi-file schema/i);
    expect(step4Block).toMatch(/security|key.handling/i);
    expect(step4Block).toMatch(/routing.logic/i);
    expect(step4Block).toMatch(/costTier:\s*"low"/);
  });

  it('includes the per-peer curl recipe', () => {
    expect(INTER_AGENT_SKILL).toContain('curl -s http://localhost:<peer-port>/catalog | jq');
  });

  it('includes a manager-discovery substitution recipe (placeholder + jq url extraction)', () => {
    // Same recipe should reference the manager URL placeholder *and* fan out to each peer's /catalog.
    const block = INTER_AGENT_SKILL;
    expect(block).toContain('{{MANAGER_URL}}/agents');
    expect(block).toMatch(/jq[^\n]*\.agents\[\]\.url/);
    expect(block).toContain('"$url/catalog"');
  });

  it('removes the old "pick by name from /agents alone" framing', () => {
    // The pre-change "Best Practices" line told agents to just "List agents first".
    expect(INTER_AGENT_SKILL).not.toMatch(/^\s*\d+\.\s+\*\*List agents first\*\*/m);
    // And the section that previously told you to "always use this name" should now redirect to the catalog flow.
    expect(INTER_AGENT_SKILL).toContain('Catalog-check before delegating');
  });
});

describe('INTER_AGENT_SKILL — deploy-time substitution still works', () => {
  it('substitutes {{MANAGER_URL}}, {{AGENT_NAME}}, {{TEAM_NAME}} via the deploy-time replace pattern', () => {
    // This mirrors deploySkillsToAgent in src/agent-manager-db.ts, which does:
    //   content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value)
    // for each var in { MANAGER_URL, AGENT_NAME, TEAM_NAME, ... }.
    const vars: Record<string, string> = {
      MANAGER_URL: 'http://manager.test:9999',
      AGENT_NAME: 'coder.test.eth',
      TEAM_NAME: 'unit-test-team',
    };

    let content = INTER_AGENT_SKILL;
    for (const [k, v] of Object.entries(vars)) {
      content = content.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), v);
    }

    // Substitutions actually happened
    expect(content).toContain('http://manager.test:9999/agents');
    expect(content).toContain('http://manager.test:9999/message');

    // No unsubstituted placeholders for the keys we provided
    expect(content).not.toContain('{{MANAGER_URL}}');
    expect(content).not.toContain('{{TEAM_NAME}}');
    expect(content).not.toContain('{{AGENT_NAME}}');

    // The new section survived the substitution pass intact
    expect(content).toContain('## Choosing the right agent to delegate to');
    expect(content).toContain('curl -s http://localhost:<peer-port>/catalog | jq');
  });

  it('lightweight skill substitution still works for non-Claude models', () => {
    const out = withInterAgentSkill('BASE PROMPT BODY', { name: 'lite-agent', team: 'lite-team' }, { lightweight: true });
    expect(out).toContain('BASE PROMPT BODY');
    expect(out).not.toContain('{{AGENT_NAME}}');
    expect(out).not.toContain('{{TEAM_NAME}}');
    expect(out).toContain('lite-agent');
    expect(out).toContain('lite-team');
    // INTER_AGENT_SKILL_LIGHT still defines the basic List Agents pattern.
    expect(INTER_AGENT_SKILL_LIGHT).toContain('/agents');
  });
});
