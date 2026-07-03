// Extends W-004 to the Cursor harness — same 2026-07-03 hang-timeout
// hardening as codex.ts (see tests/unit/codex-hang-timeout.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...args: any[]) => spawnMock(...args) }));

import { CursorCliHarness } from '../../src/harness/cursor-cli.js';

class FakeChildProcess extends EventEmitter {
  pid = 5150;
  killed = false;
  stdin = { write: vi.fn(), end: vi.fn() };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill(signal?: string) {
    this.killed = true;
    return true;
  }
}

describe('CursorCliHarness hang timeout', () => {
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

  it('kills a hung cursor-agent child and yields a hang-timeout error', async () => {
    const harness = new CursorCliHarness();
    const messages: any[] = [];

    const gen = harness.run('do the thing', { timeoutMs: 30_000 });
    const pump = (async () => {
      for await (const msg of gen) messages.push(msg);
    })();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(proc.killed).toBe(true);

    proc.emit('exit', null);
    proc.stdout.emit('end');

    // cursor-cli.ts's run() loop polls completion via `await new Promise(r =>
    // setTimeout(r, 100))` rather than reacting to events directly. Under
    // fake timers, that poll's in-flight 100ms timer must be advanced once
    // more for the loop to observe `done` and let the generator finish —
    // this mirrors the same advance the second test below already performs
    // after its own manual emits (and the same fix applied to codex.ts's
    // hang-timeout test).
    await vi.advanceTimersByTimeAsync(100);

    await pump;

    const errorMessages = messages.filter((m) => m.type === 'error');
    expect(errorMessages.some((m) => m.content.includes('hang timeout exceeded'))).toBe(true);
  });

  it('does not kill a child that finishes before the timeout', async () => {
    const harness = new CursorCliHarness();
    const messages: any[] = [];

    const gen = harness.run('do the thing', { timeoutMs: 30_000 });
    const pump = (async () => {
      for await (const msg of gen) messages.push(msg);
    })();

    await vi.advanceTimersByTimeAsync(100);
    proc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'abc' }) + '\n',
      ),
    );
    proc.emit('exit', 0);
    proc.stdout.emit('end');

    await vi.advanceTimersByTimeAsync(100);
    await pump;

    expect(proc.killed).toBe(false);
    expect(messages.some((m) => m.type === 'error' && m.content?.includes('hang timeout'))).toBe(false);
  });
});
