// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { PROTOCOL_DEFAULTS } from '../../src/protocol-defaults.js';

describe('PROTOCOL_DEFAULTS', () => {
  it('is a non-empty string', () => {
    expect(typeof PROTOCOL_DEFAULTS).toBe('string');
    expect(PROTOCOL_DEFAULTS.length).toBeGreaterThan(0);
  });

  it('contains scheduling section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Scheduling');
    expect(PROTOCOL_DEFAULTS).toContain('manager-owned scheduler');
  });

  it('contains task discipline section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Task Discipline');
    expect(PROTOCOL_DEFAULTS).toContain('task lifecycle');
  });

  it('contains output convention section', () => {
    expect(PROTOCOL_DEFAULTS).toContain('## Output Convention');
    expect(PROTOCOL_DEFAULTS).toContain('./output/');
  });

  it('contains lifecycle steps', () => {
    expect(PROTOCOL_DEFAULTS).toContain('POST $MANAGER_URL/tasks');
    expect(PROTOCOL_DEFAULTS).toContain('/tasks/<name>/claim');
    expect(PROTOCOL_DEFAULTS).toContain('/tasks/<name>/done');
  });
});
