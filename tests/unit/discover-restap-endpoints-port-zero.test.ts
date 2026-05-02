// SPDX-License-Identifier: MIT
// Regression: after the manager-collapse refactor, "interactive" agents
// (manager-<team> rows) have endpoint='' and port=0. A few code paths fall
// back to `http://localhost:${port}` which produces `http://localhost:0`,
// then catalog discovery fetched it and logged a noisy warning.
// discoverRestAPEndpoints must short-circuit on these inputs and return
// defaults silently.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { discoverRestAPEndpoints } from '../../src/agent-manager-db.js';

describe('discoverRestAPEndpoints port-zero guard', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('returns REST-AP defaults for an empty baseEndpoint without fetching or logging', async () => {
    const result = await discoverRestAPEndpoints('');
    expect(result).toEqual({ talk: '/talk', news: '/news', schedule: null });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns REST-AP defaults for http://localhost:0 without fetching or logging', async () => {
    const result = await discoverRestAPEndpoints('http://localhost:0');
    expect(result).toEqual({ talk: '/talk', news: '/news', schedule: null });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('returns REST-AP defaults for http://localhost:0/with/path without fetching or logging', async () => {
    const result = await discoverRestAPEndpoints('http://localhost:0/with/path');
    expect(result).toEqual({ talk: '/talk', news: '/news', schedule: null });
    expect(logSpy).not.toHaveBeenCalled();
  });
});
