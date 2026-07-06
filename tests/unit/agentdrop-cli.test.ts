// SPDX-License-Identifier: MIT
//
// Fleet file-drop sender CLI — real subprocess-level tests against the
// actual `scripts/agentdrop` executable (not a mock of it), with a tiny
// local HTTP server standing in for the manager's GET /agents. Never invokes
// the real `tailscale` binary or a live tailnet — every test here asserts
// the CLI fails BEFORE attempting any transfer, which is exactly the
// plan (Slice A) acceptance criterion this covers. Manifest-construction
// correctness itself is covered separately, and without any subprocess, in
// agentdrop-manifest.test.ts.

import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const AGENTDROP_BIN = path.resolve(__dirname, '../../scripts/agentdrop');

let server: http.Server;
let serverUrl: string;
let agentsResponse: { agents: Array<{ name: string; alias: string; workingDirectory: string }> };

beforeAll(async () => {
  agentsResponse = { agents: [] };
  server = http.createServer((req, res) => {
    if (req.url?.startsWith('/agents')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: agentsResponse.agents.length, total: agentsResponse.agents.length, agents: agentsResponse.agents }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  serverUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let workDir: string;

afterEach(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

describe('agentdrop CLI — fails fast before attempting any transfer', () => {
  it('--for <unknown-agent> exits non-zero, names the agent, and never writes a manifest', async () => {
    agentsResponse.agents = []; // no agents at all -> "finances" unresolvable
    workDir = mkdtempSync(path.join(tmpdir(), 'agentdrop-cli-test-'));
    const csvPath = path.join(workDir, 'a.csv');
    writeFileSync(csvPath, 'x');

    await expect(
      execFileAsync(AGENTDROP_BIN, ['--for', 'finances', csvPath], {
        env: { ...process.env, AGENTDROP_MANAGER_URL: serverUrl },
      }),
    ).rejects.toMatchObject({
      code: expect.any(Number),
      stderr: expect.stringContaining('finances'),
    });

    // No _dropmeta.json was ever written — the failure happened before any
    // manifest/transfer attempt, exactly as the acceptance criterion requires.
    expect(existsSync(path.join(workDir, '_dropmeta.json'))).toBe(false);
  });

  it('a missing input file is rejected before any network call or manifest write', async () => {
    agentsResponse.agents = [{ name: 'finances', alias: 'finances', workingDirectory: '/tmp/whatever' }];
    workDir = mkdtempSync(path.join(tmpdir(), 'agentdrop-cli-test-'));
    const missingPath = path.join(workDir, 'does-not-exist.csv');

    await expect(
      execFileAsync(AGENTDROP_BIN, ['--for', 'finances', missingPath], {
        env: { ...process.env, AGENTDROP_MANAGER_URL: serverUrl },
      }),
    ).rejects.toMatchObject({
      code: expect.any(Number),
      stderr: expect.stringContaining('does-not-exist.csv'),
    });

    expect(existsSync(path.join(workDir, '_dropmeta.json'))).toBe(false);
  });

  it('a resolvable agent writes a correct manifest before attempting the transfer', async () => {
    // AGENTDROP_FAKE_TRANSFER=1 is a test-only escape hatch (see scripts/agentdrop)
    // that skips the real `tailscale` call entirely — this environment may have
    // genuine Tailscale connectivity to a real "blitz" peer, and a test must
    // never risk an actual file transfer over Chris's real tailnet.
    workDir = mkdtempSync(path.join(tmpdir(), 'agentdrop-cli-test-'));
    agentsResponse.agents = [{ name: 'finances', alias: 'finances', workingDirectory: '/tmp/whatever' }];
    const csvPath = path.join(workDir, 'a.csv');
    writeFileSync(csvPath, 'hello');

    const { stdout } = await execFileAsync(AGENTDROP_BIN, ['--for', 'finances', csvPath], {
      env: { ...process.env, AGENTDROP_MANAGER_URL: serverUrl, AGENTDROP_FAKE_TRANSFER: '1' },
    });
    expect(stdout).toMatch(/AGENTDROP_FAKE_TRANSFER=1/);

    const manifestPath = path.join(workDir, '_dropmeta.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
    expect(manifest.schema).toBe('agentdrop.v1');
    expect(manifest.agent).toBe('finances');
    expect(manifest.files).toEqual(['a.csv']);
  });
});
