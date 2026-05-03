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
});
