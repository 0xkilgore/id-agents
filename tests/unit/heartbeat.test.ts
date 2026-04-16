// SPDX-License-Identifier: MIT

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { processConfig, copyHeartbeatMd } from '../../src/config-parser.js';
import { heartbeatToSchedule, HEARTBEAT_GENERIC_MESSAGE } from '../../src/scheduling/schedule-config.js';

/* ------------------------------------------------------------------ */
/*  Config parser: heartbeat as number or legacy object                */
/* ------------------------------------------------------------------ */

describe('heartbeat config parsing', () => {
  let tmpDir: string;
  let configDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-hb-'));
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

  it('accepts heartbeat as a plain number (seconds)', () => {
    const workDir = path.join(tmpDir, 'work');
    fs.mkdirSync(workDir, { recursive: true });

    const configPath = writeConfig('test.yaml', `
version: "1.0"
agents:
  - name: myagent
    workingDirectory: "${workDir}"
    heartbeat: 86400
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].heartbeat).toBe(86400);
  });

  it('accepts heartbeat as legacy object with interval and message', () => {
    const workDir = path.join(tmpDir, 'work2');
    fs.mkdirSync(workDir, { recursive: true });

    const configPath = writeConfig('test2.yaml', `
version: "1.0"
agents:
  - name: myagent
    workingDirectory: "${workDir}"
    heartbeat:
      interval: 3600
      message: "Check the logs"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    const hb = result.agents[0].heartbeat;
    expect(typeof hb).toBe('object');
    expect((hb as any).interval).toBe(3600);
    expect((hb as any).message).toBe('Check the logs');
  });

  it('inherits heartbeat number from defaults', () => {
    const workDir = path.join(tmpDir, 'work3');
    fs.mkdirSync(workDir, { recursive: true });

    const configPath = writeConfig('test3.yaml', `
version: "1.0"
defaults:
  heartbeat: 43200
agents:
  - name: myagent
    workingDirectory: "${workDir}"
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].heartbeat).toBe(43200);
  });

  it('agent heartbeat overrides defaults heartbeat', () => {
    const workDir = path.join(tmpDir, 'work4');
    fs.mkdirSync(workDir, { recursive: true });

    const configPath = writeConfig('test4.yaml', `
version: "1.0"
defaults:
  heartbeat: 43200
agents:
  - name: myagent
    workingDirectory: "${workDir}"
    heartbeat: 86400
`);

    const result = processConfig(configPath, '/workspace');
    expect(result.errors).toEqual([]);
    expect(result.agents[0].heartbeat).toBe(86400);
  });
});

/* ------------------------------------------------------------------ */
/*  Schedule config: heartbeatToSchedule with number vs object         */
/* ------------------------------------------------------------------ */

describe('heartbeatToSchedule', () => {
  it('creates schedule with generic message for number config', () => {
    const { definition } = heartbeatToSchedule('agent_1', 'myagent', 86400, 1000);

    expect(definition.interval_seconds).toBe(86400);
    expect(definition.message).toBe(HEARTBEAT_GENERIC_MESSAGE);
    expect(definition.kind).toBe('heartbeat');
    expect(definition.delivery_mode).toBe('internal');
    expect(definition.max_runs).toBeNull();
    expect(definition.expires_at).toBeNull();
  });

  it('creates schedule with custom message for legacy object config', () => {
    const { definition } = heartbeatToSchedule('agent_2', 'myagent', {
      interval: 3600,
      message: 'Check the logs now',
    }, 1000);

    expect(definition.interval_seconds).toBe(3600);
    expect(definition.message).toBe('Check the logs now');
    expect(definition.kind).toBe('heartbeat');
  });

  it('preserves maxBeats and expiresAfter for legacy object', () => {
    const { definition } = heartbeatToSchedule('agent_3', 'myagent', {
      interval: 300,
      message: 'ping',
      maxBeats: 10,
      expiresAfter: 7200,
    }, 1000);

    expect(definition.max_runs).toBe(10);
    expect(definition.expires_at).toBe(8200); // 1000 + 7200
  });

  it('sets delivery_mode from legacy object config', () => {
    const { definition } = heartbeatToSchedule('agent_4', 'myagent', {
      interval: 300,
      message: 'ping',
      delivery: 'talk',
    }, 1000);

    expect(definition.delivery_mode).toBe('talk');
  });
});

/* ------------------------------------------------------------------ */
/*  copyHeartbeatMd — copies HEARTBEAT.md to working dir root          */
/* ------------------------------------------------------------------ */

describe('copyHeartbeatMd', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-hbmd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when agent template directory does not exist', () => {
    expect(copyHeartbeatMd(tmpDir, 'nonexistent')).toBe(false);
  });

  it('returns false when directory exists but has no HEARTBEAT.md', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'myagent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'CLAUDE.md'), 'instructions');

    expect(copyHeartbeatMd(tmpDir, 'myagent')).toBe(false);
  });

  it('copies HEARTBEAT.md to working directory root', () => {
    const agentDir = path.join(tmpDir, '.claude', 'agents', 'checker');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'HEARTBEAT.md'), '# Checklist\n1. Check things');

    expect(copyHeartbeatMd(tmpDir, 'checker')).toBe(true);

    const dest = path.join(tmpDir, 'HEARTBEAT.md');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest, 'utf-8')).toBe('# Checklist\n1. Check things');
  });

  it('overwrites existing HEARTBEAT.md at root', () => {
    // Pre-existing file
    fs.writeFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'old content');

    const agentDir = path.join(tmpDir, '.claude', 'agents', 'updater');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'HEARTBEAT.md'), 'new content');

    expect(copyHeartbeatMd(tmpDir, 'updater')).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'utf-8')).toBe('new content');
  });
});
