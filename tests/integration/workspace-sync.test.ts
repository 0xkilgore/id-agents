// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncWorkspaceFromConfig } from '../../src/cli/workspace-sync.js';

const FIXTURE_CONFIG = '/Users/nxt3d/projects/id2/public-agents/configs/foundry-demo.yaml';
const FIXTURE_LIBRARY_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs';
const FIXTURE_AGENT_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs/agents/foundry-dev';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-workspace-sync-'));
}

function walkFiles(rootDir: string): string[] {
  const results: string[] = [];

  const walk = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (entry.isFile()) {
        results.push(path.relative(rootDir, absolutePath).split(path.sep).join('/'));
      }
    }
  };

  walk(rootDir);
  return results;
}

function sha256File(p: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('workspace sync integration', () => {
  let workspacePath = '';

  afterEach(() => {
    if (workspacePath) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
      workspacePath = '';
    }
  });

  it('materializes the foundry demo tree and receipt, then handles no-op and drift cases', () => {
    workspacePath = mkTmp();

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(first.counts).toEqual({
      wroteMissing: 6,
      matchedSource: 0,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(first.warnings).toEqual([]);

    expect(walkFiles(workspacePath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
      '.id-agents/receipt.json',
    ]);

    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      version: number;
      lastDeployedAt: string;
      files: Record<string, { sha256: string; source: string }>;
    };

    expect(receipt.version).toBe(1);
    expect(Object.keys(receipt.files).sort()).toEqual([
      '.claude/CLAUDE.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
    ]);

    for (const [relativeTargetPath, entry] of Object.entries(receipt.files)) {
      expect(entry.source).toBe('agent:foundry-dev');
      const targetPath = path.join(workspacePath, relativeTargetPath);
      expect(entry.sha256).toBe(sha256File(targetPath));

      const sourceRelativePath = relativeTargetPath.replace(/^\.claude\//, '');
      const sourcePath = path.join(FIXTURE_AGENT_ROOT, sourceRelativePath);
      expect(entry.sha256).toBe(sha256File(sourcePath));
    }

    const second = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(second.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 6,
      overwroteManaged: 0,
      drifted: 0,
    });
    expect(second.files.every(file => file.case === 2)).toBe(true);
    expect(second.warnings).toEqual([]);

    const driftPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.writeFileSync(driftPath, `${fs.readFileSync(driftPath, 'utf-8')}\nlocal change\n`);

    const third = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    expect(third.counts).toEqual({
      wroteMissing: 0,
      matchedSource: 5,
      overwroteManaged: 0,
      drifted: 1,
    });
    expect(third.warnings).toEqual(['Skipped drifted file: .claude/CLAUDE.md']);
    expect(fs.readFileSync(driftPath, 'utf-8')).toMatch(/local change/);
  });
});
