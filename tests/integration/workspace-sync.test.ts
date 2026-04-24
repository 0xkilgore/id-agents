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

    // Drift a managed skill file. CLAUDE.md drift has dedicated slice-4
    // routing coverage below, so this test targets a generic skill file to
    // keep exercising the slice-3 case-4 skip-and-warn path.
    const driftPath = path.join(workspacePath, '.claude', 'skills', 'using-foundry', 'SKILL.md');
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
    expect(third.warnings).toEqual(['Skipped drifted file: .claude/skills/using-foundry/SKILL.md']);
    expect(fs.readFileSync(driftPath, 'utf-8')).toMatch(/local change/);
  });

  /* ------------------------------------------------------------------ */
  /*  Slice 4: Claude memory-file fallback (sidecar routing)             */
  /* ------------------------------------------------------------------ */

  it('routes to .claude/rules/agent-<name>.md when the workspace already has a CLAUDE.md we do not own', () => {
    workspacePath = mkTmp();

    // Seed a user-owned CLAUDE.md before any sync runs.
    const userClaudeMdPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    const userClaudeMdContent = '# my own CLAUDE.md\n\nhand-written instructions\n';
    fs.mkdirSync(path.dirname(userClaudeMdPath), { recursive: true });
    fs.writeFileSync(userClaudeMdPath, userClaudeMdContent);

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

    // User's CLAUDE.md is sacred.
    expect(fs.readFileSync(userClaudeMdPath, 'utf-8')).toBe(userClaudeMdContent);

    // Library persona lands in the sidecar under .claude/rules/.
    const sidecarPath = path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md');
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(sha256File(sidecarPath)).toBe(sha256File(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md')));

    // Skills still land at their normal paths.
    expect(walkFiles(workspacePath)).toEqual([
      '.claude/CLAUDE.md',
      '.claude/rules/agent-foundry-dev.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
      '.id-agents/receipt.json',
    ]);

    // Receipt tracks the sidecar, not the user's CLAUDE.md.
    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      version: number;
      files: Record<string, { sha256: string; source: string }>;
    };
    expect(Object.keys(receipt.files).sort()).toEqual([
      '.claude/rules/agent-foundry-dev.md',
      '.claude/skills/foundry-scripting-and-deploy/SKILL.md',
      '.claude/skills/gas-optimization-foundry/SKILL.md',
      '.claude/skills/solidity-style-modern/SKILL.md',
      '.claude/skills/using-foundry/SKILL.md',
      '.claude/skills/writing-foundry-tests/SKILL.md',
    ]);
    expect(receipt.files['.claude/rules/agent-foundry-dev.md'].source).toBe('agent:foundry-dev');
    expect(receipt.files['.claude/rules/agent-foundry-dev.md'].sha256).toBe(sha256File(sidecarPath));
    expect(receipt.files['.claude/CLAUDE.md']).toBeUndefined();
  });

  it('is idempotent when re-syncing into a sidecar-owned workspace', () => {
    workspacePath = mkTmp();

    const userClaudeMdPath = path.join(workspacePath, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(userClaudeMdPath), { recursive: true });
    fs.writeFileSync(userClaudeMdPath, '# user CLAUDE.md\n');

    syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

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
  });

  it('uses the primary .claude/CLAUDE.md path when no pre-existing CLAUDE.md is on disk', () => {
    workspacePath = mkTmp();

    const first = syncWorkspaceFromConfig({
      configPath: FIXTURE_CONFIG,
      libraryRoot: FIXTURE_LIBRARY_ROOT,
      workspacePath,
    });

    // No sidecar file should be created when the baseline path is free.
    expect(fs.existsSync(path.join(workspacePath, '.claude', 'rules'))).toBe(false);
    expect(
      fs.existsSync(path.join(workspacePath, '.claude', 'rules', 'agent-foundry-dev.md')),
    ).toBe(false);

    // Library CLAUDE.md lands at the primary target.
    expect(
      sha256File(path.join(workspacePath, '.claude', 'CLAUDE.md')),
    ).toBe(sha256File(path.join(FIXTURE_AGENT_ROOT, 'CLAUDE.md')));

    const receipt = JSON.parse(fs.readFileSync(path.join(workspacePath, '.id-agents', 'receipt.json'), 'utf-8')) as {
      files: Record<string, { sha256: string; source: string }>;
    };
    expect(receipt.files['.claude/CLAUDE.md']).toBeDefined();
    expect(receipt.files['.claude/CLAUDE.md'].source).toBe('agent:foundry-dev');

    void first; // reference so the linter sees it used even if no other assertions follow
  });
});
