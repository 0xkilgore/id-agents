// Extends W-004 (claude-code-cli hang watchdog) to the Codex harness —
// 2026-07-03 incident: a hung `codex exec` child blocked an agent's
// entire serial query queue for 2+ days with no timeout ever firing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: any[]) => spawnMock(...args) }));

import { CodexHarness } from '../../src/harness/codex.js';

class FakeChildProcess extends EventEmitter {
  pid = 4242;
  killed = false;
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal?: string) {
    this.killed = true;
    this.emit('__killed__', signal);
    return true;
  }
}

describe('CodexHarness hang timeout', () => {
  let proc: FakeChildProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    proc = new FakeChildProcess();
    spawnMock.mockReturnValue(proc);
  });

  afterEach(() => {
    vi.useRealTimers();
    spawnMock.mockReset();
  });

  it('kills a hung codex exec child and yields a hang-timeout error', async () => {
    const harness = new CodexHarness();
    const messages: any[] = [];

    const gen = harness.run('do the thing', { timeoutMs: 30_000 });

    const pump = (async () => {
      for await (const msg of gen) messages.push(msg);
    })();

    // Advance past the timeout — the child never emits stdout/exit, simulating a hang.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(proc.killed).toBe(true);

    // Watchdog SIGTERM'd it; simulate the OS actually killing the process now.
    proc.emit('exit', null);
    proc.stdout.emit('end');

    // codex.ts's run() loop polls completion via `await new Promise(r =>
    // setTimeout(r, 100))` rather than reacting to events directly (unlike
    // claude-code-cli.ts). Under fake timers, that poll's in-flight 100ms
    // timer must be advanced once more for the loop to observe `done` and
    // let the generator finish — this mirrors the same advance the second
    // test below already performs after its own manual emits.
    await vi.advanceTimersByTimeAsync(100);

    await pump;

    const errorMessages = messages.filter((m) => m.type === 'error');
    expect(errorMessages.length).toBeGreaterThanOrEqual(1);
    expect(errorMessages.some((m) => m.content.includes('hang timeout exceeded'))).toBe(true);
  });

  it('does not kill a child that finishes before the timeout', async () => {
    const harness = new CodexHarness();
    const messages: any[] = [];

    const gen = harness.run('do the thing', { timeoutMs: 30_000 });
    const pump = (async () => {
      for await (const msg of gen) messages.push(msg);
    })();

    await vi.advanceTimersByTimeAsync(100);
    proc.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'),
    );
    proc.emit('exit', 0);
    proc.stdout.emit('end');

    await vi.advanceTimersByTimeAsync(100);
    await pump;

    expect(proc.killed).toBe(false);
    expect(messages.some((m) => m.type === 'error' && m.content?.includes('hang timeout'))).toBe(false);
  });
});
