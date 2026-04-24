// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  enumerateLibraryAgents,
  enumerateLibrarySkills,
  getLibraryPaths,
} from '../../src/lib/agent-library.js';

/* ------------------------------------------------------------------ */
/*  Fixture helpers                                                    */
/* ------------------------------------------------------------------ */

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-lib-'));
}

function writeFile(p: string, content = ''): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function mkdir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

/* ------------------------------------------------------------------ */
/*  getLibraryPaths                                                    */
/* ------------------------------------------------------------------ */

describe('getLibraryPaths', () => {
  it('returns agents and skills subpaths joined to the plural configs root', () => {
    const paths = getLibraryPaths('/repo/configs');
    expect(paths.agents).toBe(path.join('/repo/configs', 'agents'));
    expect(paths.skills).toBe(path.join('/repo/configs', 'skills'));
  });
});

/* ------------------------------------------------------------------ */
/*  enumerateLibraryAgents                                             */
/* ------------------------------------------------------------------ */

describe('enumerateLibraryAgents', () => {
  let tmpDir: string;
  let agentsDir: string;

  beforeEach(() => {
    tmpDir = mkTmp();
    agentsDir = path.join(tmpDir, 'agents');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty scan when agents dir does not exist', () => {
    const scan = enumerateLibraryAgents(path.join(tmpDir, 'missing'));
    expect(scan).toEqual({ entries: [], errors: [] });
  });

  it('returns empty scan when agents dir is empty', () => {
    mkdir(agentsDir);
    const scan = enumerateLibraryAgents(agentsDir);
    expect(scan).toEqual({ entries: [], errors: [] });
  });

  it('detects a claude-native entry (CLAUDE.md inside directory)', () => {
    writeFile(path.join(agentsDir, 'frontend', 'CLAUDE.md'), '# frontend');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.errors).toEqual([]);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toEqual({
      name: 'frontend',
      shape: 'claude-native',
      dirPath: path.join(agentsDir, 'frontend'),
      memoryFile: path.join(agentsDir, 'frontend', 'CLAUDE.md'),
    });
  });

  it('detects an agents-md-native entry (sibling .md + directory)', () => {
    writeFile(path.join(agentsDir, 'backend.md'), '# backend persona');
    mkdir(path.join(agentsDir, 'backend'));
    mkdir(path.join(agentsDir, 'backend', 'skills'));
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.errors).toEqual([]);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0]).toEqual({
      name: 'backend',
      shape: 'agents-md-native',
      dirPath: path.join(agentsDir, 'backend'),
      memoryFile: path.join(agentsDir, 'backend.md'),
    });
  });

  it('flags mixed-shape collision as a validation error and emits no entry', () => {
    writeFile(path.join(agentsDir, 'mixed', 'CLAUDE.md'), '# claude side');
    writeFile(path.join(agentsDir, 'mixed.md'), '# agents side');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries).toEqual([]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0].name).toBe('mixed');
    expect(scan.errors[0].code).toBe('mixed-shape');
    expect(scan.errors[0].message).toMatch(/both/);
  });

  it('flags incomplete agents-md-native pair (sibling .md without directory)', () => {
    writeFile(path.join(agentsDir, 'orphan.md'), '# orphan');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries).toEqual([]);
    expect(scan.errors).toHaveLength(1);
    expect(scan.errors[0].name).toBe('orphan');
    expect(scan.errors[0].code).toBe('incomplete-agents-md-native');
  });

  it('silently skips a directory with neither CLAUDE.md nor sibling .md', () => {
    mkdir(path.join(agentsDir, 'stray'));
    writeFile(path.join(agentsDir, 'stray', 'README.md'), 'notes');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries).toEqual([]);
    expect(scan.errors).toEqual([]);
  });

  it('silently skips a directory containing only AGENTS.md (not a v3 shape)', () => {
    // v3 agents-md-native lives as a sibling .md + directory, NOT as
    // <name>/AGENTS.md inside. This directory is not a valid entry.
    writeFile(path.join(agentsDir, 'codexy', 'AGENTS.md'), '# not a v3 shape');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries).toEqual([]);
    expect(scan.errors).toEqual([]);
  });

  it('silently skips dotfile and invalid-name entries', () => {
    mkdir(path.join(agentsDir, '.hidden'));
    writeFile(path.join(agentsDir, '.hidden', 'CLAUDE.md'), '# hidden');
    writeFile(path.join(agentsDir, '.DS_Store'), '');
    writeFile(path.join(agentsDir, 'bad@name.md'), '# bad');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries).toEqual([]);
    expect(scan.errors).toEqual([]);
  });

  it('silently skips non-.md files at the top level', () => {
    writeFile(path.join(agentsDir, 'README.txt'), 'not a template');
    writeFile(path.join(agentsDir, 'keep', 'CLAUDE.md'), '# keep');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.errors).toEqual([]);
    expect(scan.entries).toHaveLength(1);
    expect(scan.entries[0].name).toBe('keep');
  });

  it('returns entries sorted alphabetically', () => {
    writeFile(path.join(agentsDir, 'zulu', 'CLAUDE.md'), '');
    writeFile(path.join(agentsDir, 'alpha', 'CLAUDE.md'), '');
    writeFile(path.join(agentsDir, 'mike.md'), '');
    mkdir(path.join(agentsDir, 'mike'));
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries.map(e => e.name)).toEqual(['alpha', 'mike', 'zulu']);
    expect(scan.entries.map(e => e.shape)).toEqual([
      'claude-native',
      'agents-md-native',
      'claude-native',
    ]);
  });

  it('returns errors sorted alphabetically by name', () => {
    writeFile(path.join(agentsDir, 'zorro.md'), '');
    writeFile(path.join(agentsDir, 'alpha.md'), '');
    writeFile(path.join(agentsDir, 'mixed', 'CLAUDE.md'), '');
    writeFile(path.join(agentsDir, 'mixed.md'), '');
    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.errors.map(e => e.name)).toEqual(['alpha', 'mixed', 'zorro']);
  });

  it('handles a realistic mixed directory correctly', () => {
    writeFile(path.join(agentsDir, 'frontend', 'CLAUDE.md'), '# fe');
    writeFile(path.join(agentsDir, 'backend.md'), '# be');
    mkdir(path.join(agentsDir, 'backend'));
    writeFile(path.join(agentsDir, 'backend', 'skills', 'x', 'SKILL.md'), '# x');
    writeFile(path.join(agentsDir, 'broken.md'), '# broken (no sibling dir)');
    mkdir(path.join(agentsDir, 'half-built'));
    writeFile(path.join(agentsDir, 'half-built', 'notes.md'), '# wip');

    const scan = enumerateLibraryAgents(agentsDir);

    expect(scan.entries.map(e => ({ name: e.name, shape: e.shape }))).toEqual([
      { name: 'backend', shape: 'agents-md-native' },
      { name: 'frontend', shape: 'claude-native' },
    ]);
    expect(scan.errors).toEqual([
      {
        name: 'broken',
        code: 'incomplete-agents-md-native',
        message: expect.any(String),
      },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/*  enumerateLibrarySkills                                             */
/* ------------------------------------------------------------------ */

describe('enumerateLibrarySkills', () => {
  let tmpDir: string;
  let skillsDir: string;

  beforeEach(() => {
    tmpDir = mkTmp();
    skillsDir = path.join(tmpDir, 'skills');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty when skills dir does not exist', () => {
    expect(enumerateLibrarySkills(path.join(tmpDir, 'missing'))).toEqual([]);
  });

  it('returns empty when skills dir is empty', () => {
    mkdir(skillsDir);
    expect(enumerateLibrarySkills(skillsDir)).toEqual([]);
  });

  it('detects a skill with SKILL.md', () => {
    writeFile(path.join(skillsDir, 'wallet', 'SKILL.md'), '# wallet');
    const entries = enumerateLibrarySkills(skillsDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: 'wallet',
      dirPath: path.join(skillsDir, 'wallet'),
      skillFile: path.join(skillsDir, 'wallet', 'SKILL.md'),
    });
  });

  it('skips a directory without SKILL.md', () => {
    mkdir(path.join(skillsDir, 'not-a-skill'));
    writeFile(path.join(skillsDir, 'not-a-skill', 'README.md'), 'docs');
    expect(enumerateLibrarySkills(skillsDir)).toEqual([]);
  });

  it('skips invalid names and stray files', () => {
    writeFile(path.join(skillsDir, 'top-level.md'), 'stray');
    mkdir(path.join(skillsDir, '.hidden'));
    writeFile(path.join(skillsDir, '.hidden', 'SKILL.md'), '# hidden');
    writeFile(path.join(skillsDir, 'ok', 'SKILL.md'), '# ok');
    const entries = enumerateLibrarySkills(skillsDir);

    expect(entries.map(e => e.name)).toEqual(['ok']);
  });

  it('returns entries sorted alphabetically', () => {
    writeFile(path.join(skillsDir, 'zebra', 'SKILL.md'), '');
    writeFile(path.join(skillsDir, 'apple', 'SKILL.md'), '');
    writeFile(path.join(skillsDir, 'mango', 'SKILL.md'), '');
    const entries = enumerateLibrarySkills(skillsDir);

    expect(entries.map(e => e.name)).toEqual(['apple', 'mango', 'zebra']);
  });
});
