// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  parseTeamConfig,
  resolveConfigLibraryRoot,
  resolveLibraryAgentPath,
  validateConfig,
} from '../../src/config-parser.js';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-team-config-'));
}

describe('team-config parser helpers', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = '';
    }
  });

  it('parses a foundry-demo style config with name and agent', () => {
    tmpDir = mkTmp();
    const configPath = path.join(tmpDir, 'configs', 'foundry-demo.yaml');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `name: foundry-demo

agents:
  - name: solidity-dev
    runtime: claude-code-cli
    workingDirectory: ~/projects/demo-solidity
    agent: foundry-dev
`);

    const config = parseTeamConfig(configPath);
    expect(config.name).toBe('foundry-demo');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].agent).toBe('foundry-dev');
  });

  it('defaults the library root to the config parent directory', () => {
    const configPath = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
    expect(resolveConfigLibraryRoot(configPath)).toBe('/Users/nxt3d/projects/id2/public-agents/configs');
  });

  it('resolves agent references under <library-root>/agents/<agent>', () => {
    const configPath = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
    expect(resolveLibraryAgentPath(configPath, 'foundry-dev')).toBe(
      '/Users/nxt3d/projects/id2/public-agents/configs/agents/foundry-dev'
    );
  });

  it('rejects non-string agent values in deploy config validation', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'solidity-dev', agent: 42 as unknown as string }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].agent',
      message: 'agent must be a string',
    });
  });

  it('rejects reserved manager name for automators with the hard-error message', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'manager', type: 'automator' }],
    } as any);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].name',
      message: 'Agent manager with type automator is no longer valid. The name manager is reserved for the control plane. Rename this agent to lead-automator (or any non-reserved name) and re-deploy.',
    });
  });

  it('accepts lead-automator as the first automator name in config validation', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'lead-automator', type: 'automator' }],
    } as any);

    expect(result.valid).toBe(true);
  });

  it('rejects reserved manager name for non-automators with the same hard-error message', () => {
    const result = validateConfig({
      version: '1',
      agents: [{ name: 'manager', type: 'claude' }],
    } as any);

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual({
      path: 'agents[0].name',
      message: 'Agent manager with type automator is no longer valid. The name manager is reserved for the control plane. Rename this agent to lead-automator (or any non-reserved name) and re-deploy.',
    });
  });

  describe('catalog seed parsing', () => {
    it('surfaces a full catalog block on the agent spec via parseTeamConfig', () => {
      tmpDir = mkTmp();
      const configPath = path.join(tmpDir, 'team-with-catalog.yaml');
      fs.writeFileSync(configPath, `name: catalog-team

agents:
  - name: jrdev
    runtime: cursor-cli
    model: composer-2
    workingDirectory: ~/projects/demo
    catalog:
      role: junior-developer
      description: "Junior dev for low-stakes work."
      expertise: [typescript, simple-refactors, doc-edits]
      costTier: low
      notSuitableFor: [multi-file-schema-migrations, security-key-handling]
      status: available
`);

      const config = parseTeamConfig(configPath);
      expect(config.agents).toHaveLength(1);
      const cat = config.agents[0].catalog;
      expect(cat).toBeDefined();
      expect(cat?.role).toBe('junior-developer');
      expect(cat?.description).toBe('Junior dev for low-stakes work.');
      expect(cat?.expertise).toEqual(['typescript', 'simple-refactors', 'doc-edits']);
      expect(cat?.costTier).toBe('low');
      expect(cat?.notSuitableFor).toEqual(['multi-file-schema-migrations', 'security-key-handling']);
      expect(cat?.status).toBe('available');
    });

    it('treats catalog as optional — agents without a catalog block parse with catalog: undefined', () => {
      tmpDir = mkTmp();
      const configPath = path.join(tmpDir, 'team-no-catalog.yaml');
      fs.writeFileSync(configPath, `name: catalog-team

agents:
  - name: noseed
    runtime: claude-code-cli
`);
      const config = parseTeamConfig(configPath);
      expect(config.agents).toHaveLength(1);
      expect(config.agents[0].catalog).toBeUndefined();
    });

    it('validateConfig accepts a well-formed catalog block', () => {
      const result = validateConfig({
        version: '1',
        agents: [{
          name: 'good',
          catalog: {
            role: 'developer',
            description: 'desc',
            expertise: ['a', 'b'],
            costTier: 'medium',
            notSuitableFor: ['x'],
            status: 'available',
          },
        }],
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('validateConfig rejects non-object catalog values', () => {
      const arrResult = validateConfig({
        version: '1',
        agents: [{ name: 'bad', catalog: ['not', 'an', 'object'] as any }],
      });
      expect(arrResult.valid).toBe(false);
      expect(arrResult.errors).toContainEqual({
        path: 'agents[0].catalog',
        message: 'catalog must be an object',
      });

      const stringResult = validateConfig({
        version: '1',
        agents: [{ name: 'bad', catalog: 'string' as any }],
      });
      expect(stringResult.valid).toBe(false);
      expect(stringResult.errors).toContainEqual({
        path: 'agents[0].catalog',
        message: 'catalog must be an object',
      });
    });

    it('validateConfig rejects bad catalog field types and unknown costTier', () => {
      const result = validateConfig({
        version: '1',
        agents: [{
          name: 'bad',
          catalog: {
            role: 42 as any,
            expertise: 'not-an-array' as any,
            notSuitableFor: [1, 2] as any,
            costTier: 'extreme' as any,
            status: { nested: true } as any,
          },
        }],
      });
      expect(result.valid).toBe(false);
      const messages = result.errors.map(e => `${e.path}: ${e.message}`);
      expect(messages).toContain('agents[0].catalog.role: catalog.role must be a string');
      expect(messages).toContain('agents[0].catalog.expertise: catalog.expertise must be a string array');
      expect(messages).toContain('agents[0].catalog.notSuitableFor: catalog.notSuitableFor must be a string array');
      expect(messages).toContain('agents[0].catalog.costTier: catalog.costTier must be one of: low, medium, high');
      expect(messages).toContain('agents[0].catalog.status: catalog.status must be a string');
    });
  });
});
