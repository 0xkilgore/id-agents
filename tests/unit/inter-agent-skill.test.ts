// SPDX-License-Identifier: MIT

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  INTER_AGENT_SKILL,
  INTER_AGENT_SKILL_LIGHT,
  stripYamlFrontmatter,
  withInterAgentSkill,
} from '../../src/inter-agent-skill.js';

const SKILL_MD_PATH = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  '..',
  'skills',
  'inter-agent',
  'SKILL.md'
);

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

  it('includes a manager-discovery recipe (env var + jq url extraction)', () => {
    // The full skill is now sourced from skills/inter-agent/SKILL.md, which uses
    // shell env vars ($MANAGER_URL) rather than {{MANAGER_URL}} placeholders.
    // The recipe should still reference the manager URL *and* fan out to each peer's /catalog.
    const block = INTER_AGENT_SKILL;
    expect(block).toContain('$MANAGER_URL/agents');
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

describe('INTER_AGENT_SKILL — single source of truth (skills/inter-agent/SKILL.md)', () => {
  it('TS export matches the MD file body (frontmatter stripped) — divergence guard', () => {
    // skills/inter-agent/SKILL.md is the source of truth. INTER_AGENT_SKILL is
    // loaded from it at module init. If anyone edits the TS export by hand
    // and lets it drift from the MD, this assertion fires.
    const raw = readFileSync(SKILL_MD_PATH, 'utf8');
    const expectedBody = stripYamlFrontmatter(raw);
    // The export prepends a single newline for legacy formatting parity; trim
    // a leading newline before comparing so the assertion is content-only.
    expect(INTER_AGENT_SKILL.replace(/^\n/, '')).toBe(expectedBody);
  });

  it('stripYamlFrontmatter removes a leading --- ... --- block and leaves body untouched', () => {
    const sample = '---\nname: x\ndescription: y\n---\n# Body\nhello';
    expect(stripYamlFrontmatter(sample)).toBe('# Body\nhello');
    // No frontmatter → returned unchanged
    expect(stripYamlFrontmatter('# Body\nhello')).toBe('# Body\nhello');
  });

  it('lightweight skill remains a separate, hand-maintained inline string', () => {
    // The lightweight skill is intentionally NOT loaded from disk — it's a
    // shorter inline variant for non-Claude / cost-sensitive models and uses
    // the {{}} placeholder substitution pattern at runtime.
    const out = withInterAgentSkill('BASE PROMPT BODY', { name: 'lite-agent', team: 'lite-team' }, { lightweight: true });
    expect(out).toContain('BASE PROMPT BODY');
    expect(out).not.toContain('{{AGENT_NAME}}');
    expect(out).not.toContain('{{TEAM_NAME}}');
    expect(out).toContain('lite-agent');
    expect(out).toContain('lite-team');
    expect(INTER_AGENT_SKILL_LIGHT).toContain('/agents');
    // Sanity: lightweight is materially shorter than the full skill.
    expect(INTER_AGENT_SKILL_LIGHT.length).toBeLessThan(INTER_AGENT_SKILL.length);
  });
});
