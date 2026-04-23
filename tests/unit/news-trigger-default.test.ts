// SPDX-License-Identifier: MIT
/**
 * resolveNewsTrigger — defaults for /news trigger semantics.
 *
 * Replies (in_reply_to present) must default to trigger=true so the
 * receiver wakes up when its /talk-to wait has already timed out. An
 * explicit trigger value (true or false) wins over the default.
 */

import { describe, expect, it } from 'vitest';
import { resolveNewsTrigger } from '../../src/core/messaging-service.js';

describe('resolveNewsTrigger', () => {
  it('defaults to true when in_reply_to is present and trigger is omitted', () => {
    expect(resolveNewsTrigger({ in_reply_to: 'q-123' })).toBe(true);
  });

  it('defaults to false when in_reply_to is absent and trigger is omitted', () => {
    expect(resolveNewsTrigger({})).toBe(false);
    expect(resolveNewsTrigger({ in_reply_to: '' })).toBe(false);
    expect(resolveNewsTrigger({ in_reply_to: null })).toBe(false);
  });

  it('honors explicit trigger=false on a reply (caller opt-out)', () => {
    expect(resolveNewsTrigger({ in_reply_to: 'q-123', trigger: false })).toBe(false);
  });

  it('honors explicit trigger=true on a non-reply', () => {
    expect(resolveNewsTrigger({ trigger: true })).toBe(true);
  });

  it('treats null trigger like missing (defaults from in_reply_to)', () => {
    expect(resolveNewsTrigger({ in_reply_to: 'q-123', trigger: null })).toBe(true);
    expect(resolveNewsTrigger({ trigger: null })).toBe(false);
  });
});
