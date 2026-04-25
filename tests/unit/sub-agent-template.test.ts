// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  loadSubAgentTemplate,
  parseSubAgentTemplate,
  processConfig,
  copyAgentDirOverlay,
  copyLibraryAgentOverlay,
  appendLibraryPersonaToAgentsMd,
  upsertMarkedBlock,
  writePersonalityFile,
} from '../../src/config-parser.js';

/* ------------------------------------------------------------------ */
/*  parseSubAgentTemplate — pure string parsing                        */
/* ------------------------------------------------------------------ */

describe('parseSubAgentTemplate', () => {
  it('parses frontmatter and body', () => {
    const raw = `---
description: Security auditor agent
model: claude-opus-4-6
---

You are a security auditor. Review code for vulnerabilities.`;

    const result = parseSubAgentTemplate(raw);

    expect(result.description).toBe('Security auditor agent');
    expect(result.frontmatter.model).toBe('claude-opus-4-6');
    expect(result.body).toBe('You are a security auditor. Review code for vulnerabilities.');
  });

  it('handles missing frontmatter — entire content is body', () => {
    const raw = 'You are a helpful coding assistant.\n\nFocus on clean code.';

    const result = parseSubAgentTemplate(raw);

    expect(result.body).toBe('You are a helpful coding assistant.\n\nFocus on clean code.');
    expect(result.description).toBeUndefined();
    expect(result.frontmatter).toEqual({});
  });

  it('handles empty frontmatter', () => {
    const raw = `---
---

Just the body here.`;

    const result = parseSubAgentTemplate(raw);

    expect(result.body).toBe('Just the body here.');
    expect(result.frontmatter).toEqual({});
    expect(result.description).toBeUndefined();
  });

  it('handles frontmatter with no body', () => {
    const raw = `---
description: An agent with no body
---
`;

    const result = parseSubAgentTemplate(raw);

    expect(result.body).toBe('');
    expect(result.description).toBe('An agent with no body');
  });

  it('ignores non-string description in frontmatter', () => {
    const raw = `---
description: 42
---

Body text.`;

    const result = parseSubAgentTemplate(raw);

    // yaml parses 42 as a number, not a string
    expect(result.description).toBeUndefined();
    expect(result.frontmatter.description).toBe(42);
  });

  it('preserves complex frontmatter fields', () => {
    const raw = `---
description: Full agent
tags:
  - security
  - audit
priority: high
---

Do security things.`;

    const result = parseSubAgentTemplate(raw);

    expect(result.description).toBe('Full agent');
    expect(result.frontmatter.tags).toEqual(['security', 'audit']);
    expect(result.frontmatter.priority).toBe('high');
  });
});

/* ------------------------------------------------------------------ */
/*  loadSubAgentTemplate — filesystem integration                      */
/* ------------------------------------------------------------------ */

describe('loadSubAgentTemplate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns undefined when file does not exist', () => {
    const result = loadSubAgentTemplate(tmpDir, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('loads template from .claude/agents/<name>.md', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'auditor.md'), `---
description: Security auditor
---

You audit code for security issues.`);

    const result = loadSubAgentTemplate(tmpDir, 'auditor');

    expect(result).toBeDefined();
    expect(result!.description).toBe('Security auditor');
    expect(result!.body).toBe('You audit code for security issues.');
  });

  it('loads template without frontmatter', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'helper.md'), 'Just help people.');

    const result = loadSubAgentTemplate(tmpDir, 'helper');

    expect(result).toBeDefined();
    expect(result!.body).toBe('Just help people.');
    expect(result!.description).toBeUndefined();
  });

  it('returns undefined when .claude dir exists but agents subdir does not', () => {
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });

    const result = loadSubAgentTemplate(tmpDir, 'missing');
    expect(result).toBeUndefined();
  });

  it('loads template from directory pattern .claude/agents/<name>/CLAUDE.md', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'reviewer');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), `---
description: Code reviewer
---

You review pull requests carefully.`);

    const result = loadSubAgentTemplate(tmpDir, 'reviewer');

    expect(result).toBeDefined();
    expect(result!.description).toBe('Code reviewer');
    expect(result!.body).toBe('You review pull requests carefully.');
  });

  it('directory pattern takes priority over single-file pattern', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    // Create both patterns
    const agentDir = path.join(agentsDir, 'coder');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), `---
description: Directory version
---

I am from the directory.`);
    fs.writeFileSync(path.join(agentsDir, 'coder.md'), `---
description: File version
---

I am from the file.`);

    const result = loadSubAgentTemplate(tmpDir, 'coder');

    expect(result).toBeDefined();
    expect(result!.description).toBe('Directory version');
    expect(result!.body).toBe('I am from the directory.');
  });

  it('falls back to single-file when directory pattern does not exist', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Only create the .md file, no directory
    fs.writeFileSync(path.join(agentsDir, 'writer.md'), 'Write things.');

    const result = loadSubAgentTemplate(tmpDir, 'writer');

    expect(result).toBeDefined();
    expect(result!.body).toBe('Write things.');
  });

  it('returns undefined when neither pattern exists', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = loadSubAgentTemplate(tmpDir, 'ghost');
    expect(result).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  processConfig integration — template loading sets roleBody         */
/* ------------------------------------------------------------------ */

describe('processConfig sub-agent template integration', () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-cfg-'));
    configDir = path.join(tmpDir, 'configs');
    fs.mkdirSync(configDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(filename: string, content: string): string {
    const filePath = path.join(configDir, filename);
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  function setupAgentTemplate(workingDir: string, agentName: string, content: string) {
    const agentsDir = path.join(workingDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, `${agentName}.md`), content);
  }

  it('sets roleBody from template file', () => {
    const workDir = path.join(tmpDir, 'workspace', 'myproject');
    fs.mkdirSync(workDir, { recursive: true });

    setupAgentTemplate(workDir, 'coder', `---
description: A coding agent
---

You write clean TypeScript code.`);

    const configPath = writeConfig('test.yaml', `
version: "1.0"
agents:
  - name: coder
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents.length).toBe(1);

    const agent = result.agents[0];
    expect(agent.roleBody).toBe('You write clean TypeScript code.');
    expect(agent.description).toBe('A coding agent');
  });

  it('uses template description when agent has none', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project2');
    fs.mkdirSync(workDir, { recursive: true });

    setupAgentTemplate(workDir, 'reviewer', `---
description: Code review specialist
---

Review PRs carefully.`);

    const configPath = writeConfig('test2.yaml', `
version: "1.0"
agents:
  - name: reviewer
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].description).toBe('Code review specialist');
    expect(result.agents[0].roleBody).toBe('Review PRs carefully.');
  });

  it('does not override agent description with template description', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project3');
    fs.mkdirSync(workDir, { recursive: true });

    setupAgentTemplate(workDir, 'writer', `---
description: Template description
---

Body text.`);

    const configPath = writeConfig('test3.yaml', `
version: "1.0"
agents:
  - name: writer
    description: "Config description wins"
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].description).toBe('Config description wins');
  });

  it('no-ops when template file does not exist', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project4');
    fs.mkdirSync(workDir, { recursive: true });

    const configPath = writeConfig('test4.yaml', `
version: "1.0"
agents:
  - name: coder
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBeUndefined();
  });

  it('does not use agent field to override role-file lookup', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project5');
    fs.mkdirSync(workDir, { recursive: true });

    setupAgentTemplate(workDir, 'auditor', `---
description: Auditor template
---

Review PRs carefully.`);
    setupAgentTemplate(workDir, 'security-audit', `---
description: Security audit specialist
---

You perform thorough security audits.`);

    const configPath = writeConfig('test5.yaml', `
version: "1.0"
agents:
  - name: auditor
    agent: security-audit
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBe('Review PRs carefully.');
    expect(result.agents[0].description).toBe('Auditor template');
  });

  it('skips template loading when agent has no workingDirectory', () => {
    const configPath = writeConfig('test6.yaml', `
version: "1.0"
agents:
  - name: cloud-agent
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].roleBody).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  copyAgentDirOverlay — recursive directory copy                     */
/* ------------------------------------------------------------------ */

describe('copyAgentDirOverlay', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-overlay-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when agent directory does not exist', () => {
    const result = copyAgentDirOverlay(tmpDir, 'nonexistent');
    expect(result).toBe(false);
  });

  it('returns false when template name points to a file, not a directory', () => {
    const agentsDir = path.join(tmpDir, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'myagent'), 'not a directory');

    const result = copyAgentDirOverlay(tmpDir, 'myagent');
    expect(result).toBe(false);
  });

  it('copies CLAUDE.md from agent dir into .claude/', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'reviewer');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), 'Agent instructions');

    const result = copyAgentDirOverlay(tmpDir, 'reviewer');
    expect(result).toBe(true);

    // CLAUDE.md should now exist at .claude/CLAUDE.md (overlay destination)
    const dest = path.join(tmpDir, '.claude', 'CLAUDE.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('Agent instructions');
  });

  it('copies nested skills into .claude/skills/', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'auditor');
    const skillDir = path.join(agentDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Skill content');

    const result = copyAgentDirOverlay(tmpDir, 'auditor');
    expect(result).toBe(true);

    const destSkill = path.join(tmpDir, '.claude', 'skills', 'test-skill', 'SKILL.md');
    expect(fs.existsSync(destSkill)).toBe(true);
    expect(fs.readFileSync(destSkill, 'utf-8')).toBe('Skill content');
  });

  it('copies hooks into .claude/hooks/', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'builder');
    const hooksDir = path.join(agentDir, 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit.sh'), '#!/bin/bash\necho test');

    const result = copyAgentDirOverlay(tmpDir, 'builder');
    expect(result).toBe(true);

    const destHook = path.join(tmpDir, '.claude', 'hooks', 'pre-commit.sh');
    expect(fs.existsSync(destHook)).toBe(true);
    expect(fs.readFileSync(destHook, 'utf-8')).toBe('#!/bin/bash\necho test');
  });

  it('copies MEMORY.md into .claude/', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'researcher');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), '# Agent Memory\n- fact 1');

    const result = copyAgentDirOverlay(tmpDir, 'researcher');
    expect(result).toBe(true);

    const destMemory = path.join(tmpDir, '.claude', 'MEMORY.md');
    expect(fs.existsSync(destMemory)).toBe(true);
    expect(fs.readFileSync(destMemory, 'utf-8')).toBe('# Agent Memory\n- fact 1');
  });

  it('copies full directory tree with multiple file types', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'fullstack');
    // Create a realistic agent directory
    fs.mkdirSync(path.join(agentDir, 'skills', 'deploy-skill'), { recursive: true });
    fs.mkdirSync(path.join(agentDir, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), 'Main instructions');
    fs.writeFileSync(path.join(agentDir, 'MEMORY.md'), 'Memory content');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{"key": "value"}');
    fs.writeFileSync(path.join(agentDir, 'skills', 'deploy-skill', 'SKILL.md'), 'Deploy skill');
    fs.writeFileSync(path.join(agentDir, 'hooks', 'test-hook.sh'), 'hook script');

    const result = copyAgentDirOverlay(tmpDir, 'fullstack');
    expect(result).toBe(true);

    // Verify all files landed in .claude/
    const claude = path.join(tmpDir, '.claude');
    expect(fs.readFileSync(path.join(claude, 'CLAUDE.md'), 'utf-8')).toBe('Main instructions');
    expect(fs.readFileSync(path.join(claude, 'MEMORY.md'), 'utf-8')).toBe('Memory content');
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf-8')).toBe('{"key": "value"}');
    expect(fs.readFileSync(path.join(claude, 'skills', 'deploy-skill', 'SKILL.md'), 'utf-8')).toBe('Deploy skill');
    expect(fs.readFileSync(path.join(claude, 'hooks', 'test-hook.sh'), 'utf-8')).toBe('hook script');
  });

  it('overwrites existing files in .claude/ (force: true)', () => {
    // Pre-existing file in .claude/
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"old": true}');

    // Agent dir with same file
    const agentDir = path.join(claudeDir, 'agents', 'overwriter');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'settings.json'), '{"new": true}');

    const result = copyAgentDirOverlay(tmpDir, 'overwriter');
    expect(result).toBe(true);

    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf-8')).toBe('{"new": true}');
  });

  it('does not remove pre-existing files not in the overlay', () => {
    // Pre-existing file in .claude/
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'existing.md'), 'keep me');

    // Agent dir with different file
    const agentDir = path.join(claudeDir, 'agents', 'additive');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), 'new content');

    copyAgentDirOverlay(tmpDir, 'additive');

    // Both files should exist
    expect(fs.readFileSync(path.join(claudeDir, 'existing.md'), 'utf-8')).toBe('keep me');
    expect(fs.readFileSync(path.join(claudeDir, 'CLAUDE.md'), 'utf-8')).toBe('new content');
  });
});

/* ------------------------------------------------------------------ */
/*  copyLibraryAgentOverlay — configs/agents → runtime overlay target */
/* ------------------------------------------------------------------ */

describe('copyLibraryAgentOverlay', () => {
  let libraryRoot: string;
  let agentsDir: string;
  let workDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-liboverlay-'));
    libraryRoot = path.join(tmp, 'configs');
    agentsDir = path.join(libraryRoot, 'agents');
    workDir = path.join(tmp, 'workspace');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(libraryRoot), { recursive: true, force: true });
  });

  it('returns false when the library root does not exist', () => {
    fs.rmSync(agentsDir, { recursive: true, force: true });
    expect(copyLibraryAgentOverlay(workDir, 'missing', 'claude-agent-sdk', libraryRoot)).toBe(false);
  });

  it('returns false when the named entry is not present', () => {
    expect(copyLibraryAgentOverlay(workDir, 'absent', 'claude-agent-sdk', libraryRoot)).toBe(false);
  });

  it('routes a claude-native persona into .claude/rules/agent-<name>.md for a Claude runtime', () => {
    // Library CLAUDE.md must NOT land at .claude/CLAUDE.md — the framework
    // overwrites that path with PROTOCOL_DEFAULTS + roleBody right after
    // overlay. Routing the persona to .claude/rules/agent-<name>.md keeps
    // both visible to Claude (auto-loaded as a rule).
    fs.mkdirSync(path.join(agentsDir, 'frontend', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'frontend', 'CLAUDE.md'), 'frontend persona');
    fs.writeFileSync(path.join(agentsDir, 'frontend', 'rules', 'style.md'), 'rule body');

    const copied = copyLibraryAgentOverlay(workDir, 'frontend', 'claude-agent-sdk', libraryRoot);

    expect(copied).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(workDir, '.claude', 'rules', 'agent-frontend.md'), 'utf-8'),
    ).toBe('frontend persona');
    // Other rule files copied as-is.
    expect(fs.readFileSync(path.join(workDir, '.claude', 'rules', 'style.md'), 'utf-8')).toBe('rule body');
  });

  it('routes the overlay to .agents/ for the Codex runtime (drops inert CLAUDE.md)', () => {
    // Codex personas live in workspace-root AGENTS.md (appended via
    // appendLibraryPersonaToAgentsMd in the spawn flow). The recursive
    // copy still drops other library files into .agents/, but the inert
    // CLAUDE.md artifact is removed so it doesn't sit unused.
    fs.mkdirSync(path.join(agentsDir, 'frontend', 'skills', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'frontend', 'CLAUDE.md'), 'persona');
    fs.writeFileSync(
      path.join(agentsDir, 'frontend', 'skills', 'demo', 'SKILL.md'),
      'skill body',
    );

    const copied = copyLibraryAgentOverlay(workDir, 'frontend', 'codex', libraryRoot);

    expect(copied).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.agents', 'CLAUDE.md'))).toBe(false);
    expect(
      fs.readFileSync(
        path.join(workDir, '.agents', 'skills', 'demo', 'SKILL.md'),
        'utf-8',
      ),
    ).toBe('skill body');
  });

  it('routes the overlay to .cursor/ for the Cursor CLI runtime (drops inert CLAUDE.md)', () => {
    fs.mkdirSync(path.join(agentsDir, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'frontend', 'CLAUDE.md'), 'persona');

    const copied = copyLibraryAgentOverlay(workDir, 'frontend', 'cursor-cli', libraryRoot);

    expect(copied).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.cursor', 'CLAUDE.md'))).toBe(false);
  });

  it('routes the sibling persona to the rules sidecar for an agents-md-native entry on Claude', () => {
    fs.mkdirSync(path.join(agentsDir, 'backend', 'skills', 'using-foundry'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'backend.md'), 'backend persona');
    fs.writeFileSync(
      path.join(agentsDir, 'backend', 'skills', 'using-foundry', 'SKILL.md'),
      'skill body',
    );

    const copied = copyLibraryAgentOverlay(workDir, 'backend', 'claude-agent-sdk', libraryRoot);

    expect(copied).toBe(true);
    // Sibling directory contents land in the overlay target.
    expect(
      fs.readFileSync(
        path.join(workDir, '.claude', 'skills', 'using-foundry', 'SKILL.md'),
        'utf-8',
      ),
    ).toBe('skill body');
    // Persona is preserved in the Claude rules sidecar so the framework's
    // CLAUDE.md write does not erase it. .claude/CLAUDE.md must NOT exist
    // and the sibling .md file is not placed at the overlay root either.
    expect(fs.existsSync(path.join(workDir, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.claude', 'backend.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(workDir, '.claude', 'rules', 'agent-backend.md'), 'utf-8'),
    ).toBe('backend persona');
  });

  it('returns false when the enumerator reports a mixed-shape conflict', () => {
    fs.mkdirSync(path.join(agentsDir, 'mixed'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'mixed', 'CLAUDE.md'), 'claude side');
    fs.writeFileSync(path.join(agentsDir, 'mixed.md'), 'agents side');

    expect(copyLibraryAgentOverlay(workDir, 'mixed', 'claude-agent-sdk', libraryRoot)).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.claude'))).toBe(false);
  });

  it('returns false for an incomplete agents-md-native pair (no sibling dir)', () => {
    fs.writeFileSync(path.join(agentsDir, 'orphan.md'), 'orphan');

    expect(copyLibraryAgentOverlay(workDir, 'orphan', 'claude-agent-sdk', libraryRoot)).toBe(false);
  });

  it('defaults to the Claude overlay target (with sidecar persona) when no runtime is given', () => {
    fs.mkdirSync(path.join(agentsDir, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'frontend', 'CLAUDE.md'), 'persona');

    const copied = copyLibraryAgentOverlay(workDir, 'frontend', undefined, libraryRoot);

    expect(copied).toBe(true);
    expect(fs.existsSync(path.join(workDir, '.claude', 'CLAUDE.md'))).toBe(false);
    expect(
      fs.readFileSync(path.join(workDir, '.claude', 'rules', 'agent-frontend.md'), 'utf-8'),
    ).toBe('persona');
  });

  it('preserves persona through symlinked library entries', () => {
    // Library author may symlink an external agent dir into configs/agents.
    // Without symlink-aware enumeration the entry was silently dropped.
    // Anchor the external dir outside libraryRoot so the recursive copy
    // can't follow the symlink back through the source tree.
    const externalAgentDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'id-agents-symlink-target-'),
    );
    try {
      fs.writeFileSync(path.join(externalAgentDir, 'CLAUDE.md'), 'symlinked persona');
      fs.symlinkSync(externalAgentDir, path.join(agentsDir, 'linked'));

      const copied = copyLibraryAgentOverlay(workDir, 'linked', 'claude-agent-sdk', libraryRoot);

      expect(copied).toBe(true);
      expect(
        fs.readFileSync(path.join(workDir, '.claude', 'rules', 'agent-linked.md'), 'utf-8'),
      ).toBe('symlinked persona');
    } finally {
      fs.rmSync(externalAgentDir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------ */
/*  upsertMarkedBlock                                                  */
/* ------------------------------------------------------------------ */

describe('upsertMarkedBlock', () => {
  let tmpDir: string;
  let target: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-marker-'));
    target = path.join(tmpDir, 'AGENTS.md');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file with a marker block when target is missing', () => {
    upsertMarkedBlock(target, 'agent:foo', '# Foo persona\nbody line');

    const out = fs.readFileSync(target, 'utf-8');
    expect(out).toBe(
      '<!-- BEGIN id-agents agent:foo -->\n# Foo persona\nbody line\n<!-- END id-agents agent:foo -->\n',
    );
  });

  it('appends the block below existing content when no markers are present', () => {
    fs.writeFileSync(target, '# Framework section\nuser line\n');
    upsertMarkedBlock(target, 'agent:foo', 'persona body');

    const out = fs.readFileSync(target, 'utf-8');
    expect(out).toBe(
      '# Framework section\nuser line\n\n' +
        '<!-- BEGIN id-agents agent:foo -->\npersona body\n<!-- END id-agents agent:foo -->\n',
    );
  });

  it('replaces only the marked block on re-upsert, preserving content outside', () => {
    fs.writeFileSync(
      target,
      '# Framework section\nuser line\n\n' +
        '<!-- BEGIN id-agents agent:foo -->\nold persona\n<!-- END id-agents agent:foo -->\n' +
        'after-marker user note\n',
    );

    upsertMarkedBlock(target, 'agent:foo', 'new persona');

    const out = fs.readFileSync(target, 'utf-8');
    expect(out).toBe(
      '# Framework section\nuser line\n\n' +
        '<!-- BEGIN id-agents agent:foo -->\nnew persona\n<!-- END id-agents agent:foo -->\n' +
        'after-marker user note\n',
    );
  });
});

/* ------------------------------------------------------------------ */
/*  appendLibraryPersonaToAgentsMd — Codex/Cursor persona append      */
/* ------------------------------------------------------------------ */

describe('appendLibraryPersonaToAgentsMd', () => {
  let libraryRoot: string;
  let agentsDir: string;
  let workDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-codex-persona-'));
    libraryRoot = path.join(tmp, 'configs');
    agentsDir = path.join(libraryRoot, 'agents');
    workDir = path.join(tmp, 'workspace');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(libraryRoot), { recursive: true, force: true });
  });

  function seedClaudeNativeEntry(name: string, persona: string): void {
    fs.mkdirSync(path.join(agentsDir, name), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, name, 'CLAUDE.md'), persona);
  }

  function readAgentsMd(): string {
    return fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf-8');
  }

  const begin = (name: string): string => `<!-- BEGIN id-agents agent:${name} -->`;
  const end = (name: string): string => `<!-- END id-agents agent:${name} -->`;

  it('fresh deploy: appends a marker block below the framework section on Codex', () => {
    seedClaudeNativeEntry('foundry-dev', '# Foundry persona\nuse forge.\n');
    // Simulate the framework personality file write that happens just
    // before this helper runs in the spawn flow.
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '# Protocol defaults\nframework body\n');

    const ok = appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);
    expect(ok).toBe(true);

    const out = readAgentsMd();
    expect(out.startsWith('# Protocol defaults\nframework body\n')).toBe(true);
    expect(out).toContain(`${begin('foundry-dev')}\n# Foundry persona\nuse forge.\n${end('foundry-dev')}\n`);
  });

  it('re-deploy: replaces only the marked block, framework section untouched', () => {
    seedClaudeNativeEntry('foundry-dev', '# Foundry persona v1\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '# Protocol defaults\nframework body\n');

    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    // Library content changes, framework rewrites AGENTS.md identically.
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), '# Foundry persona v2\nupdated\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'),
      '# Protocol defaults\nframework body\n\n' +
      `${begin('foundry-dev')}\n# Foundry persona v1\n${end('foundry-dev')}\n`,
    );

    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    const out = readAgentsMd();
    expect(out).toBe(
      '# Protocol defaults\nframework body\n\n' +
      `${begin('foundry-dev')}\n# Foundry persona v2\nupdated\n${end('foundry-dev')}\n`,
    );
  });

  it('preserves user edits ABOVE the marker block on re-deploy', () => {
    seedClaudeNativeEntry('foundry-dev', '# Foundry persona v1\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'),
      '# Protocol defaults\nframework body\n\n## User notes\nimportant local context\n',
    );

    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    // Update library and re-run.
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), '# Foundry persona v2\n');
    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    const out = readAgentsMd();
    // User notes block above the marker is preserved verbatim.
    expect(out).toContain('## User notes\nimportant local context\n');
    // Persona is the latest v2 inside markers.
    expect(out).toContain(`${begin('foundry-dev')}\n# Foundry persona v2\n${end('foundry-dev')}\n`);
    // The v1 persona is no longer present anywhere in the file.
    expect(out).not.toContain('# Foundry persona v1');
  });

  it('Cursor runtime: same behavior — appends to root AGENTS.md', () => {
    seedClaudeNativeEntry('foundry-dev', '# Cursor persona\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '# Cursor framework\n');

    const ok = appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'cursor-cli', libraryRoot);
    expect(ok).toBe(true);

    const out = readAgentsMd();
    expect(out).toContain('# Cursor framework\n');
    expect(out).toContain(`${begin('foundry-dev')}\n# Cursor persona\n${end('foundry-dev')}\n`);
  });

  it('agents-md-native source: persona body comes from the sibling .md', () => {
    fs.mkdirSync(path.join(agentsDir, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'backend.md'), '# Backend persona\n');
    fs.writeFileSync(path.join(workDir, 'AGENTS.md'), '# framework\n');

    const ok = appendLibraryPersonaToAgentsMd(workDir, 'backend', 'codex', libraryRoot);
    expect(ok).toBe(true);
    expect(readAgentsMd()).toContain(`${begin('backend')}\n# Backend persona\n${end('backend')}\n`);
  });

  it('Claude runtime: helper is a no-op (sidecar handles persona)', () => {
    seedClaudeNativeEntry('foundry-dev', '# persona\n');

    const ok = appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'claude-code-cli', libraryRoot);
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'AGENTS.md'))).toBe(false);
  });

  it('returns false when the named library entry is missing', () => {
    const ok = appendLibraryPersonaToAgentsMd(workDir, 'unknown', 'codex', libraryRoot);
    expect(ok).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'AGENTS.md'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  copyLibraryAgentOverlay — orphan CLAUDE.md cleanup (Codex/Cursor)  */
/* ------------------------------------------------------------------ */

describe('copyLibraryAgentOverlay orphan cleanup', () => {
  let libraryRoot: string;
  let agentsDir: string;
  let workDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-orphan-'));
    libraryRoot = path.join(tmp, 'configs');
    agentsDir = path.join(libraryRoot, 'agents');
    workDir = path.join(tmp, 'workspace');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(libraryRoot), { recursive: true, force: true });
  });

  it('Codex: removes inert .agents/CLAUDE.md after recursive copy', () => {
    fs.mkdirSync(path.join(agentsDir, 'foundry-dev', 'skills', 'forge'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), 'persona');
    fs.writeFileSync(
      path.join(agentsDir, 'foundry-dev', 'skills', 'forge', 'SKILL.md'),
      'skill body',
    );

    copyLibraryAgentOverlay(workDir, 'foundry-dev', 'codex', libraryRoot);

    expect(fs.existsSync(path.join(workDir, '.agents', 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, '.agents', 'skills', 'forge', 'SKILL.md'))).toBe(true);
  });

  it('Cursor: removes inert .cursor/CLAUDE.md after recursive copy', () => {
    fs.mkdirSync(path.join(agentsDir, 'foundry-dev'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), 'persona');

    copyLibraryAgentOverlay(workDir, 'foundry-dev', 'cursor-cli', libraryRoot);

    expect(fs.existsSync(path.join(workDir, '.cursor', 'CLAUDE.md'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  writePersonalityFile + spawn-flow refresh                          */
/* ------------------------------------------------------------------ */

describe('writePersonalityFile', () => {
  let libraryRoot: string;
  let agentsDir: string;
  let workDir: string;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-personality-'));
    libraryRoot = path.join(tmp, 'configs');
    agentsDir = path.join(libraryRoot, 'agents');
    workDir = path.join(tmp, 'workspace');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(workDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(path.dirname(libraryRoot), { recursive: true, force: true });
  });

  function readAgentsMd(): string {
    return fs.readFileSync(path.join(workDir, 'AGENTS.md'), 'utf-8');
  }

  it('Claude runtime: full overwrite of .claude/CLAUDE.md (legacy behavior)', () => {
    writePersonalityFile(workDir, 'claude-code-cli', '# Protocol defaults\nbody');
    expect(fs.readFileSync(path.join(workDir, '.claude', 'CLAUDE.md'), 'utf-8'))
      .toBe('# Protocol defaults\nbody');

    // Re-write with new content fully replaces the file.
    writePersonalityFile(workDir, 'claude-code-cli', '# Updated\nv2');
    expect(fs.readFileSync(path.join(workDir, '.claude', 'CLAUDE.md'), 'utf-8'))
      .toBe('# Updated\nv2');
  });

  it('Codex runtime: framework body wrapped in framework markers', () => {
    writePersonalityFile(workDir, 'codex', '# Protocol defaults\nbody');
    const out = readAgentsMd();
    expect(out).toBe(
      '<!-- BEGIN id-agents framework -->\n# Protocol defaults\nbody\n<!-- END id-agents framework -->\n',
    );
  });

  it('Codex re-deploy: framework block refreshes in place; user content above and below survives', () => {
    // Initial deploy.
    writePersonalityFile(workDir, 'codex', '# Protocol defaults\nv1 body');

    // User edits AGENTS.md outside the framework block — both above and below.
    const initial = readAgentsMd();
    fs.writeFileSync(
      path.join(workDir, 'AGENTS.md'),
      `# Local preface\nuser preface line\n\n${initial}\n## User notes below\nlocal context\n`,
    );

    // Re-deploy with updated framework body.
    writePersonalityFile(workDir, 'codex', '# Protocol defaults\nv2 body');

    const out = readAgentsMd();
    expect(out).toContain('# Local preface\nuser preface line\n');
    expect(out).toContain(
      '<!-- BEGIN id-agents framework -->\n# Protocol defaults\nv2 body\n<!-- END id-agents framework -->\n',
    );
    expect(out).toContain('## User notes below\nlocal context\n');
    // v1 framework body is gone — only the marked block was replaced.
    expect(out).not.toContain('v1 body');
  });

  it('spawn-flow refresh on Codex preserves user edits above markers across both managed blocks', () => {
    // Stage a library entry so the agent persona append step has something to read.
    fs.mkdirSync(path.join(agentsDir, 'foundry-dev'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), '# persona v1');

    // Step 4: framework write.
    writePersonalityFile(workDir, 'codex', '# Protocol defaults\nbody');
    // Step 5: agent persona append.
    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    // User now hand-edits AGENTS.md: adds notes above the framework block,
    // between the two managed blocks, and below the agent block.
    const afterFirstDeploy = readAgentsMd();
    fs.writeFileSync(
      path.join(workDir, 'AGENTS.md'),
      `# user preface\nlocal preface line\n\n${afterFirstDeploy.replace(
        '<!-- END id-agents framework -->\n\n<!-- BEGIN id-agents agent:foundry-dev -->',
        '<!-- END id-agents framework -->\n\n## interstitial\nuser-only middle\n\n<!-- BEGIN id-agents agent:foundry-dev -->',
      )}## tail notes\nlocal tail line\n`,
    );

    // Library content rotates and a redeploy happens (sync/rebuild path):
    // step 4 + step 5 run again with fresh inputs.
    fs.writeFileSync(path.join(agentsDir, 'foundry-dev', 'CLAUDE.md'), '# persona v2');
    writePersonalityFile(workDir, 'codex', '# Protocol defaults\nbody');
    appendLibraryPersonaToAgentsMd(workDir, 'foundry-dev', 'codex', libraryRoot);

    const out = readAgentsMd();
    // All three pockets of user content survive intact.
    expect(out).toContain('# user preface\nlocal preface line\n');
    expect(out).toContain('## interstitial\nuser-only middle\n');
    expect(out).toContain('## tail notes\nlocal tail line\n');
    // Framework block stays in place (idempotent re-write of identical body).
    expect(out).toContain(
      '<!-- BEGIN id-agents framework -->\n# Protocol defaults\nbody\n<!-- END id-agents framework -->\n',
    );
    // Persona block reflects v2.
    expect(out).toContain(
      '<!-- BEGIN id-agents agent:foundry-dev -->\n# persona v2\n<!-- END id-agents agent:foundry-dev -->\n',
    );
    // Old persona body is gone.
    expect(out).not.toContain('# persona v1');
  });
});
