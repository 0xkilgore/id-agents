// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { validateName, getReservedWords } from '../../src/name-validation.js';

describe('validateName', () => {
  describe('valid names', () => {
    it('accepts a simple alphanumeric name', () => {
      expect(validateName('idchain', 'team')).toEqual({ valid: true });
    });

    it('accepts names with hyphens and underscores', () => {
      expect(validateName('my-agent', 'agent')).toEqual({ valid: true });
      expect(validateName('my_agent', 'agent')).toEqual({ valid: true });
    });

    it('accepts names with dots (valid for teams)', () => {
      expect(validateName('v2.0', 'team')).toEqual({ valid: true });
    });

    it('accepts names with numbers', () => {
      expect(validateName('agent42', 'agent')).toEqual({ valid: true });
    });

    it('accepts single character names', () => {
      expect(validateName('x', 'agent')).toEqual({ valid: true });
    });

    it('accepts 64-character names', () => {
      const name = 'a'.repeat(64);
      expect(validateName(name, 'agent')).toEqual({ valid: true });
    });
  });

  describe('reserved command words', () => {
    it('rejects "delete" as a team name', () => {
      const result = validateName('delete', 'team');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved command word');
    });

    it('rejects "deploy" as an agent name', () => {
      const result = validateName('deploy', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reserved command word');
    });

    it('rejects reserved words case-insensitively', () => {
      expect(validateName('DELETE', 'team').valid).toBe(false);
      expect(validateName('Deploy', 'agent').valid).toBe(false);
      expect(validateName('SYNC', 'team').valid).toBe(false);
    });

    it('rejects all specified reserved words', () => {
      const reserved = getReservedWords();
      for (const word of reserved) {
        const result = validateName(word, 'agent');
        expect(result.valid, `"${word}" should be rejected`).toBe(false);
      }
    });

    it('does not reject words that contain reserved words as substrings', () => {
      expect(validateName('delete-bot', 'agent').valid).toBe(true);
      expect(validateName('my-deploy', 'agent').valid).toBe(true);
      expect(validateName('syncer', 'agent').valid).toBe(true);
    });
  });

  describe('shell wildcards and globs', () => {
    it('rejects names containing *', () => {
      const result = validateName('agent*', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('shell metacharacters');
    });

    it('rejects names containing ?', () => {
      expect(validateName('agent?', 'agent').valid).toBe(false);
    });

    it('rejects names containing brackets', () => {
      expect(validateName('agent[0]', 'agent').valid).toBe(false);
      expect(validateName('agent{a,b}', 'agent').valid).toBe(false);
    });
  });

  describe('flag-like prefixes', () => {
    it('rejects names starting with -', () => {
      const result = validateName('-agent', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot start with "-"');
    });

    it('rejects names starting with --', () => {
      const result = validateName('--team', 'team');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot start with "-"');
    });
  });

  describe('empty and whitespace', () => {
    it('rejects empty string', () => {
      const result = validateName('', 'team');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('rejects whitespace-only string', () => {
      const result = validateName('   ', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('cannot be empty');
    });

    it('rejects names containing spaces', () => {
      const result = validateName('my agent', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('whitespace or control characters');
    });

    it('rejects names containing tabs', () => {
      expect(validateName('my\tagent', 'agent').valid).toBe(false);
    });

    it('rejects names containing newlines', () => {
      expect(validateName('my\nagent', 'agent').valid).toBe(false);
    });
  });

  describe('control characters and null bytes', () => {
    it('rejects names containing null bytes', () => {
      const result = validateName('agent\x00name', 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('control characters');
    });

    it('rejects names containing other control chars', () => {
      expect(validateName('agent\x01', 'agent').valid).toBe(false);
      expect(validateName('agent\x7f', 'agent').valid).toBe(false);
    });
  });

  describe('length limits', () => {
    it('rejects names longer than 64 characters', () => {
      const name = 'a'.repeat(65);
      const result = validateName(name, 'agent');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('exceeds 64 characters');
    });
  });

  describe('error messages include kind', () => {
    it('says "team name" for team validation', () => {
      expect(validateName('', 'team').error).toContain('team name');
    });

    it('says "agent name" for agent validation', () => {
      expect(validateName('', 'agent').error).toContain('agent name');
    });
  });
});

describe('getReservedWords', () => {
  it('returns a sorted array', () => {
    const words = getReservedWords();
    const sorted = [...words].sort();
    expect(words).toEqual(sorted);
  });

  it('includes key command words', () => {
    const words = getReservedWords();
    expect(words).toContain('delete');
    expect(words).toContain('deploy');
    expect(words).toContain('sync');
    expect(words).toContain('spawn');
    expect(words).toContain('artifact');
    expect(words).toContain('output');
    expect(words).toContain('verify');
  });
});
