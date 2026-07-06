// SPDX-License-Identifier: MIT
//
// Fleet file-drop receiver — runOneScanCycle against a REAL temp staging
// directory (real fs.readdir/rename, no mocked filesystem) with a mocked
// `fetch` standing in for the manager (`GET /agents`, `POST /tasks`) and
// Telegram. Each test maps to a plan (Slice B) acceptance criterion.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { runOneScanCycle } from '../../scripts/lib/agentdrop-watcher-cycle.mjs';
// @ts-expect-error — plain ESM module (no d.ts); imported for its runtime behavior.
import { MANIFEST_FILENAME, buildManifest } from '../../scripts/lib/agentdrop-manifest.mjs';

const MANAGER_URL = 'http://127.0.0.1:4100';
const FAKE_ENV = { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' };
const AGENT_WORKING_DIR_BASE = mkdtempSync(path.join(tmpdir(), 'agentdrop-agent-workdir-'));
const FINANCES_WORKING_DIR = path.join(AGENT_WORKING_DIR_BASE, 'finances');
mkdirSync(FINANCES_WORKING_DIR, { recursive: true });

let stagingDir: string;

beforeEach(() => {
  stagingDir = mkdtempSync(path.join(tmpdir(), 'agentdrop-staging-'));
});

afterEach(() => {
  rmSync(stagingDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function fakeFetch(agentsFound = true, taskPostOk = true) {
  return vi.fn(async (url: string, opts?: any) => {
    if (url.includes('/agents')) {
      const agents = agentsFound ? [{ name: 'finances', alias: 'finances', workingDirectory: FINANCES_WORKING_DIR }] : [];
      return { ok: true, status: 200, json: async () => ({ count: agents.length, total: agents.length, agents }) };
    }
    if (url.includes('/tasks')) {
      return { ok: taskPostOk, status: taskPostOk ? 200 : 500, json: async () => ({ ok: taskPostOk }) };
    }
    if (url.includes('api.telegram.org')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function writeBatch(dir: string, manifestOverrides: Record<string, unknown>, fileContents: Record<string, string>) {
  const manifest = { ...buildManifest({ agent: 'finances', sender: 'chris', files: Object.keys(fileContents) }), ...manifestOverrides };
  writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(fileContents)) {
    writeFileSync(path.join(dir, name), content);
  }
  return manifest;
}

describe('runOneScanCycle', () => {
  it('delivers a complete, valid batch: moves files, posts a task, alerts Telegram', async () => {
    const manifest = writeBatch(stagingDir, {}, { 'a.csv': 'x', 'b.csv': 'y' });
    const fetchImpl = fakeFetch();

    const results = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, env: FAKE_ENV });

    expect(results).toHaveLength(1);
    expect(results[0].outcome.action).toBe('deliver');
    expect(results[0].delivered.taskPosted).toBe(true);

    const destDir = path.join(FINANCES_WORKING_DIR, 'inbox', manifest.batch_id);
    expect(existsSync(path.join(destDir, 'a.csv'))).toBe(true);
    expect(existsSync(path.join(destDir, 'b.csv'))).toBe(true);
    expect(existsSync(path.join(destDir, MANIFEST_FILENAME))).toBe(true);
    // Staging is empty after a successful delivery.
    expect(readdirSync(stagingDir)).toEqual([]);

    const telegramCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('api.telegram.org'));
    expect(telegramCall).toBeTruthy();
    expect(JSON.parse(telegramCall![1].body).text).toMatch(/delivered/);
  });

  it('quarantines a malformed manifest and alerts, without crashing the cycle', async () => {
    writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), '{not valid json');
    writeFileSync(path.join(stagingDir, 'a.csv'), 'x');
    const fetchImpl = fakeFetch();

    const results = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, env: FAKE_ENV });

    expect(results[0].outcome.action).toBe('quarantine');
    expect(readdirSync(stagingDir)).toEqual(['_failed']);
    const failedDirs = readdirSync(path.join(stagingDir, '_failed'));
    expect(failedDirs).toHaveLength(1);
    const quarantined = readdirSync(path.join(stagingDir, '_failed', failedDirs[0]));
    expect(quarantined).toContain(MANIFEST_FILENAME);
    expect(quarantined).toContain('a.csv');
    expect(quarantined).toContain('reason.txt');

    const telegramCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes('api.telegram.org'));
    expect(telegramCall).toBeTruthy();
  });

  it('quarantines a manifest naming an unknown agent — never guesses a destination', async () => {
    writeBatch(stagingDir, {}, { 'a.csv': 'x' });
    const fetchImpl = fakeFetch(/* agentsFound */ false);

    const results = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl });

    expect(results[0].outcome.action).toBe('quarantine');
    expect(results[0].outcome.reason).toMatch(/unknown agent/);
    expect(readdirSync(stagingDir)).toEqual(['_failed']);
  });

  it('a batch missing _dropmeta.json entirely is quarantined after the grace period, not silently ignored', async () => {
    writeFileSync(path.join(stagingDir, 'stray.csv'), 'x');
    const fetchImpl = fakeFetch();

    // Within grace: waits, does NOT quarantine yet (files can legitimately
    // land before their manifest, e.g. if tailscale drains files out of
    // send-order).
    const early = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, now: Date.now(), graceMs: 30_000 });
    expect(early[0].outcome.action).toBe('wait');
    expect(existsSync(path.join(stagingDir, 'stray.csv'))).toBe(true);

    // Past grace: quarantined, alerted.
    const later = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, now: Date.now() + 60_000, graceMs: 30_000 });
    expect(later[0].outcome.action).toBe('quarantine');
    expect(readdirSync(stagingDir)).toEqual(['_failed']);
  });

  it('the loop keeps draining subsequent batches even after a malformed one (two cycles, two independent batches)', async () => {
    // Cycle 1: malformed manifest -> quarantined, staging cleared of it.
    writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), 'not json at all');
    const fetchImpl = fakeFetch();
    const cycle1 = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl });
    expect(cycle1[0].outcome.action).toBe('quarantine');

    // Cycle 2: a brand new, VALID batch lands in the now-clean staging dir.
    const manifest = writeBatch(stagingDir, {}, { 'c.csv': 'z' });
    const cycle2 = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl });
    expect(cycle2[0].outcome.action).toBe('deliver');
    expect(existsSync(path.join(FINANCES_WORKING_DIR, 'inbox', manifest.batch_id, 'c.csv'))).toBe(true);
  });

  it('watcher restart mid-batch: an incomplete batch waits, then delivers once the remaining file arrives, across two independent calls', async () => {
    const manifest = writeBatch(stagingDir, {}, { 'a.csv': 'x' }); // 'b.csv' declared missing below
    // Rewrite the manifest to also expect b.csv, which has NOT landed yet —
    // simulating tailscale still mid-transfer when the manifest arrived.
    writeFileSync(path.join(stagingDir, MANIFEST_FILENAME), JSON.stringify({ ...manifest, files: ['a.csv', 'b.csv'] }));
    const fetchImpl = fakeFetch();

    const firstScan = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, now: Date.now() });
    expect(firstScan[0].outcome.action).toBe('wait');
    // Nothing moved — the batch is untouched, exactly as it would be after a
    // real process restart re-scanning the same staging directory.
    expect(existsSync(path.join(stagingDir, 'a.csv'))).toBe(true);
    expect(existsSync(path.join(stagingDir, MANIFEST_FILENAME))).toBe(true);

    // The remaining file arrives (this is what "restart mid-batch" resumes
    // into — a fresh scan, no memory of the prior `wait` needed).
    writeFileSync(path.join(stagingDir, 'b.csv'), 'y');
    const secondScan = await runOneScanCycle(stagingDir, { managerUrl: MANAGER_URL, fetchImpl, now: Date.now() });
    expect(secondScan[0].outcome.action).toBe('deliver');
    expect(existsSync(path.join(FINANCES_WORKING_DIR, 'inbox', manifest.batch_id, 'a.csv'))).toBe(true);
    expect(existsSync(path.join(FINANCES_WORKING_DIR, 'inbox', manifest.batch_id, 'b.csv'))).toBe(true);
  });
});
