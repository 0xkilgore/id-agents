// SPDX-License-Identifier: MIT
/**
 * CursorCliHarness stream-json parser — tests for parseCursorEvent().
 *
 * Fixture events mirror the schema emitted by
 *   cursor-agent -p --output-format stream-json -f --model composer-2
 */

import { describe, expect, it } from 'vitest';
import {
  createCursorParserState,
  parseCursorEvent,
} from '../../src/harness/cursor-cli.js';

function run(events: any[]) {
  const state = createCursorParserState();
  const yielded: any[] = [];
  for (const ev of events) {
    for (const msg of parseCursorEvent(ev, state)) yielded.push(msg);
  }
  return { state, yielded };
}

describe('parseCursorEvent', () => {
  it('extracts the assistant text and emits a terminal result on success', () => {
    const events = [
      { type: 'system',   subtype: 'init', session_id: 'sess-1', model: 'composer-2', cwd: '/tmp', permissionMode: 'default' },
      { type: 'user',     message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, session_id: 'sess-1' },
      { type: 'thinking', subtype: 'delta', text: 'Hmm, ', session_id: 'sess-1', timestamp_ms: 1 },
      { type: 'thinking', subtype: 'delta', text: 'thinking...', session_id: 'sess-1', timestamp_ms: 2 },
      { type: 'thinking', subtype: 'completed', session_id: 'sess-1', timestamp_ms: 3 },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] }, session_id: 'sess-1' },
      { type: 'result', subtype: 'success', is_error: false, result: 'Hello!', session_id: 'sess-1', duration_ms: 123, usage: {} },
    ];

    const { state, yielded } = run(events);

    const init = yielded.find(m => m.type === 'system' && m.subtype === 'init');
    expect(init?.session_id).toBe('sess-1');

    const result = yielded.find(m => m.type === 'result');
    expect(result).toBeTruthy();
    expect(result.result).toBe('Hello!');
    expect(result.content).toBe('Hello!');
    expect(result.session_id).toBe('sess-1');

    // No stringified objects leaking through as progress/content.
    const leaks = yielded.filter(m => typeof m.content !== 'undefined' && typeof m.content !== 'string');
    expect(leaks).toHaveLength(0);
    expect(yielded.some(m => m.type === 'error')).toBe(false);

    expect(state.terminalEmitted).toBe(true);
    expect(state.thinkingBuffer.join('')).toBe('Hmm, thinking...');
  });

  it('concatenates assistant content across multiple events and text parts', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'one ' }, { type: 'text', text: 'two' }] }, session_id: 's' },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: ' three' }] }, session_id: 's' },
      { type: 'result', subtype: 'success', is_error: false, result: 'unused', session_id: 's' },
    ];
    const { yielded } = run(events);
    const result = yielded.find(m => m.type === 'result');
    expect(result?.result).toBe('one two three');
  });

  it('falls back to result.result when no assistant event fired', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'success', is_error: false, result: 'direct', session_id: 's' },
    ];
    const { yielded } = run(events);
    expect(yielded.find(m => m.type === 'result')?.result).toBe('direct');
  });

  it('emits an error when is_error is true', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'error', is_error: true, result: 'boom', session_id: 's' },
    ];
    const { yielded, state } = run(events);
    expect(yielded.find(m => m.type === 'error')?.content).toBe('boom');
    expect(yielded.some(m => m.type === 'result')).toBe(false);
    expect(state.terminalEmitted).toBe(true);
  });

  it('emits an error when subtype is "error" even without is_error', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'result', subtype: 'error', result: 'sad', session_id: 's' },
    ];
    const { yielded } = run(events);
    expect(yielded.find(m => m.type === 'error')?.content).toBe('sad');
  });

  it('treats unknown event types as no-ops (no progress leak)', () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'mystery', message: { foo: 'bar' }, session_id: 's' },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' },
    ];
    const { yielded } = run(events);
    const leaks = yielded.filter(m => typeof m.content !== 'undefined' && typeof m.content !== 'string');
    expect(leaks).toHaveLength(0);
    expect(yielded.find(m => m.type === 'result')?.result).toBe('ok');
  });
});
