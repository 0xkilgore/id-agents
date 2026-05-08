// SPDX-License-Identifier: MIT
/**
 * extractCurrentTaskTitle — pure helper that converts a dispatch's
 * markdown body into a card-safe single-line title.
 *
 * Plan: docs/superpowers/plans/2026-05-08-vetra-readside-dashboard.md
 * Phase 1 / Task 1.
 */

import { describe, expect, it } from 'vitest';
import { extractCurrentTaskTitle } from '../../src/dispatches/current-task-title.js';

describe('extractCurrentTaskTitle', () => {
  it('returns the first non-empty line as the title', () => {
    expect(extractCurrentTaskTitle('build the thing\nmore notes')).toBe('build the thing');
  });

  it('skips leading blank lines and finds the first content line', () => {
    expect(extractCurrentTaskTitle('\n\n   \n\nfix the auth bug\n')).toBe('fix the auth bug');
  });

  it('strips a leading dash bullet', () => {
    expect(extractCurrentTaskTitle('- build X')).toBe('build X');
  });

  it('strips a leading asterisk bullet', () => {
    expect(extractCurrentTaskTitle('* build X')).toBe('build X');
  });

  it('strips an ordered-list prefix like "1. "', () => {
    expect(extractCurrentTaskTitle('1. build X')).toBe('build X');
    expect(extractCurrentTaskTitle('42.   build X')).toBe('build X');
  });

  it('strips heading markers', () => {
    expect(extractCurrentTaskTitle('# Build X')).toBe('Build X');
    expect(extractCurrentTaskTitle('### Build X')).toBe('Build X');
  });

  it('returns "Untitled dispatch" for empty input', () => {
    expect(extractCurrentTaskTitle('')).toBe('Untitled dispatch');
  });

  it('returns "Untitled dispatch" for whitespace-only input', () => {
    expect(extractCurrentTaskTitle('   \n\n\t\n')).toBe('Untitled dispatch');
  });

  it('returns "Untitled dispatch" when only markdown punctuation is present', () => {
    expect(extractCurrentTaskTitle('---\n')).toBe('Untitled dispatch');
    expect(extractCurrentTaskTitle('-\n')).toBe('Untitled dispatch');
    expect(extractCurrentTaskTitle('#  \n')).toBe('Untitled dispatch');
  });

  it('trims surrounding whitespace from the chosen line', () => {
    expect(extractCurrentTaskTitle('   build X   ')).toBe('build X');
  });

  it('truncates with ASCII ellipsis once over maxLen', () => {
    const long = 'a'.repeat(200);
    const out = extractCurrentTaskTitle(long, 10);
    expect(out.length).toBeLessThanOrEqual(13); // 10 + '...'
    expect(out.endsWith('...')).toBe(true);
    expect(out).toBe('aaaaaaaaaa...');
  });

  it('does NOT truncate when length is within maxLen', () => {
    expect(extractCurrentTaskTitle('short title', 100)).toBe('short title');
  });

  it('uses default maxLen of 120', () => {
    const long = 'a'.repeat(200);
    const out = extractCurrentTaskTitle(long);
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBe(123);
  });

  it('CRLF line endings are handled', () => {
    expect(extractCurrentTaskTitle('build the thing\r\nmore')).toBe('build the thing');
  });
});
