// Follow-up hardening to the 2026-07-03 hang-timeout watchdog
// (codex-hang-timeout.test.ts / cursor-cli-hang-timeout.test.ts).
//
// Those tests mock `child_process.spawn` with a FakeChildProcess whose
// 'exit'/stdout 'end' events are emitted on cue by the test, which always
// resolves `completionPromise`. That can't catch a real-world case: `codex
// exec` and `cursor-agent` both run shell commands as children, so a killed
// process can leave an orphaned grandchild holding the inherited stdout pipe
// open. `stdout.on('end')` then never fires, `completionPromise` never
// resolves, and — reproduced against the pre-fix code on 2026-07-03 — the
// generator (and the dispatch behind it) hangs indefinitely even though the
// watchdog correctly SIGTERM'd/SIGKILL'd the process it knew about. This is
// the exact "one hung child blocks the queue forever" failure the watchdog
// exists to prevent, just one process level deeper.
//
// These tests spawn a REAL child that forks-and-detaches a background
// `sleep` before the watchdog fires, so the pipe genuinely stays open, and
// assert the harness still completes within a bounded window.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodexHarness } from '../../src/harness/codex.js';
import { CursorCliHarness } from '../../src/harness/cursor-cli.js';

/**
 * A shell script that forks a detached `sleep` (inheriting stdout) and exits
 * itself only when signalled — leaving the `sleep` grandchild as the one
 * actually holding the stdout pipe open after the parent is SIGTERM'd.
 */
function writeOrphaningBinary(dir: string, name: string): string {
  const binPath = path.join(dir, name);
  fs.writeFileSync(binPath, '#!/bin/sh\nsleep 999999 &\nwait\n', { mode: 0o755 });
  return binPath;
}

async function collectMessages(gen: AsyncGenerator<any>): Promise<any[]> {
  const out: any[] = [];
  for await (const msg of gen) out.push(msg);
  return out;
}

describe('CodexHarness — hang-timeout watchdog survives an orphaned grandchild holding the pipe open', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-codex-orphan-'));
    writeOrphaningBinary(tmpDir, 'codex');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('completes within a bounded window instead of hanging on an unclosed stdout pipe', async () => {
    const harness = new CodexHarness();
    const start = Date.now();

    const messages = await collectMessages(
      harness.run('do something', {
        workingDirectory: tmpDir,
        timeoutMs: 200,
        env: { PATH: `${tmpDir}:${process.env.PATH}` },
      }),
    );

    const elapsed = Date.now() - start;
    // Bounded: timeoutMs (200) + poll interval (~100) + KILL_GRACE_MS (2000)
    // + 1000ms safety margin. Without the fix this never resolves.
    expect(elapsed).toBeLessThan(8000);

    const errorMsg = messages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.content).toMatch(/hang timeout exceeded/i);
  }, 15_000);
});

describe('CursorCliHarness — hang-timeout watchdog survives an orphaned grandchild holding the pipe open', () => {
  let tmpDir: string;
  let originalCursorPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-agents-cursor-orphan-'));
    writeOrphaningBinary(tmpDir, 'cursor-agent');
    originalCursorPath = process.env.CURSOR_AGENT_PATH;
    process.env.CURSOR_AGENT_PATH = path.join(tmpDir, 'cursor-agent');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalCursorPath === undefined) delete process.env.CURSOR_AGENT_PATH;
    else process.env.CURSOR_AGENT_PATH = originalCursorPath;
  });

  it('completes within a bounded window instead of hanging on an unclosed stdout pipe', async () => {
    const harness = new CursorCliHarness();
    const start = Date.now();

    const messages = await collectMessages(
      harness.run('do something', {
        workingDirectory: tmpDir,
        timeoutMs: 200,
      }),
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(8000);

    const errorMsg = messages.find((m) => m.type === 'error');
    expect(errorMsg).toBeDefined();
    expect(errorMsg.content).toMatch(/hang timeout exceeded/i);
  }, 15_000);
});
