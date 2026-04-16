// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  loadSubAgentTemplate,
  parseSubAgentTemplate,
  processConfig,
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
});

/* ------------------------------------------------------------------ */
/*  processConfig integration — template merging during spawn          */
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

  it('prepends template body to agent claudeMd', () => {
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
    claudeMd: "Follow the team style guide."
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents.length).toBe(1);

    const agent = result.agents[0];
    expect(agent.claudeMd).toContain('You write clean TypeScript code.');
    expect(agent.claudeMd).toContain('Follow the team style guide.');
    // Template body should come before agent's own claudeMd
    const templateIdx = agent.claudeMd!.indexOf('You write clean TypeScript code.');
    const agentIdx = agent.claudeMd!.indexOf('Follow the team style guide.');
    expect(templateIdx).toBeLessThan(agentIdx);
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
    claudeMd: "Original instructions."
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].claudeMd).toContain('Original instructions.');
  });

  it('uses agent field to load a different template filename', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project5');
    fs.mkdirSync(workDir, { recursive: true });

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
    expect(result.agents[0].claudeMd).toContain('You perform thorough security audits.');
    expect(result.agents[0].description).toBe('Security audit specialist');
  });

  it('skips template loading when agent has no workingDirectory', () => {
    const configPath = writeConfig('test6.yaml', `
version: "1.0"
agents:
  - name: cloud-agent
    claudeMd: "Cloud instructions."
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].claudeMd).toContain('Cloud instructions.');
  });

  it('template body is prepended before defaults.claudeMd content', () => {
    const workDir = path.join(tmpDir, 'workspace', 'project7');
    fs.mkdirSync(workDir, { recursive: true });

    setupAgentTemplate(workDir, 'agent1', 'Template personality.');

    const configPath = writeConfig('test7.yaml', `
version: "1.0"
defaults:
  claudeMd: "Default team rules."
agents:
  - name: agent1
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);

    const claudeMd = result.agents[0].claudeMd!;
    expect(claudeMd).toContain('Template personality.');
    expect(claudeMd).toContain('Default team rules.');
    // Template body should come before defaults
    const templateIdx = claudeMd.indexOf('Template personality.');
    const defaultsIdx = claudeMd.indexOf('Default team rules.');
    expect(templateIdx).toBeLessThan(defaultsIdx);
  });
});
