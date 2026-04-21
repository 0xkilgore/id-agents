// SPDX-License-Identifier: MIT
/**
 * Fatal-error handlers for the manager process.
 *
 * Pins: (1) both handlers register on the target process, (2) each one logs
 * a [FATAL]-prefixed line AND calls exit(1) with its reason.
 */

import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFatalHandlers } from '../../src/lib/fatal-handlers.js';

class FakeProc extends EventEmitter {
  exit = vi.fn((_code?: number) => { /* no-op: we only assert */ }) as unknown as (code?: number) => never;
}

describe('installFatalHandlers', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('registers handlers for unhandledRejection and uncaughtException', () => {
    const proc = new FakeProc();
    installFatalHandlers(proc as any);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
    expect(proc.listenerCount('uncaughtException')).toBe(1);
  });

  it('logs [FATAL] and calls exit(1) on unhandledRejection', () => {
    const proc = new FakeProc();
    const exitSpy = vi.fn();
    proc.exit = exitSpy as any;

    installFatalHandlers(proc as any);

    const reason = new Error('scheduler blew up');
    const promise = Promise.reject(reason);
    // Prevent the real runtime from also flagging this as unhandled.
    promise.catch(() => {});
    proc.emit('unhandledRejection', reason, promise);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const joined = errSpy.mock.calls.flat().map(String).join('\n');
    expect(joined).toMatch(/\[FATAL\]/);
    expect(joined).toMatch(/scheduler blew up/);
  });

  it('logs [FATAL] and calls exit(1) on uncaughtException', () => {
    const proc = new FakeProc();
    const exitSpy = vi.fn();
    proc.exit = exitSpy as any;

    installFatalHandlers(proc as any);

    const err = new Error('sync boom');
    proc.emit('uncaughtException', err);

    expect(exitSpy).toHaveBeenCalledWith(1);
    const joined = errSpy.mock.calls.flat().map(String).join('\n');
    expect(joined).toMatch(/\[FATAL\]/);
    expect(joined).toMatch(/sync boom/);
  });

  it('formats non-Error rejections without throwing', () => {
    const proc = new FakeProc();
    proc.exit = vi.fn() as any;
    installFatalHandlers(proc as any);
    proc.emit('unhandledRejection', 'bare string', Promise.resolve().catch(() => {}));
    proc.emit('unhandledRejection', { code: 'EFOO' }, Promise.resolve().catch(() => {}));
    const joined = errSpy.mock.calls.flat().map(String).join('\n');
    expect(joined).toMatch(/bare string/);
    expect(joined).toMatch(/EFOO/);
  });
});
