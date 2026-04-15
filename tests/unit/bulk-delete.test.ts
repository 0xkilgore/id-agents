// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

describe('bulk delete argument parsing', () => {
  function parseBulkDelete(args: string[]): { mode: 'single' | 'all' | 'team'; teamName?: string } {
    const first = args[0];
    if (!first) return { mode: 'single' };
    if (first === '*') return { mode: 'all' };
    if (first === '--team') {
      const teamName = args[1];
      return teamName ? { mode: 'team', teamName } : { mode: 'single' };
    }
    return { mode: 'single' };
  }

  it('parses /delete * as bulk all', () => {
    const result = parseBulkDelete(['*']);
    expect(result).toEqual({ mode: 'all' });
  });

  it('parses /delete --team myteam as team delete', () => {
    const result = parseBulkDelete(['--team', 'myteam']);
    expect(result).toEqual({ mode: 'team', teamName: 'myteam' });
  });

  it('parses /delete agent-name as single', () => {
    const result = parseBulkDelete(['agent-name']);
    expect(result).toEqual({ mode: 'single' });
  });

  it('parses /delete --team without name as single (error case)', () => {
    const result = parseBulkDelete(['--team']);
    expect(result).toEqual({ mode: 'single' });
  });
});

describe('team name validation', () => {
  const validPattern = /^[a-zA-Z0-9_.-]+$/;

  it('accepts valid team names', () => {
    expect(validPattern.test('default')).toBe(true);
    expect(validPattern.test('my-team')).toBe(true);
    expect(validPattern.test('team_1')).toBe(true);
    expect(validPattern.test('v2.0')).toBe(true);
  });

  it('rejects path traversal attempts', () => {
    expect(validPattern.test('../etc')).toBe(false);
    expect(validPattern.test('team/../../etc')).toBe(false);
    expect(validPattern.test('')).toBe(false);
  });
});
