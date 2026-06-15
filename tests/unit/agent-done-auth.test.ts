// SPDX-License-Identifier: MIT
// R.2: tighten POST /agent-done so a closeout cannot spoof or accidentally
// complete the wrong dispatch. These are the pure decision functions behind the
// route gate — the route itself just maps their results to HTTP status codes.

import { describe, expect, it } from 'vitest';
import {
  agentDoneAuthConfigFromEnv,
  authenticateAgentDone,
  isLoopback,
} from '../../src/lib/agent-done-auth.js';

describe('agentDoneAuthConfigFromEnv', () => {
  it('defaults to no token + trustLoopback when env is empty', () => {
    const cfg = agentDoneAuthConfigFromEnv({});
    expect(cfg.token).toBeNull();
    expect(cfg.trustLoopback).toBe(true);
  });

  it('picks up a configured token and trims it', () => {
    const cfg = agentDoneAuthConfigFromEnv({ DISPATCH_DONE_TOKEN: '  s3cret  ' });
    expect(cfg.token).toBe('s3cret');
    expect(cfg.trustLoopback).toBe(true);
  });

  it('treats a blank/whitespace token as no token', () => {
    expect(agentDoneAuthConfigFromEnv({ DISPATCH_DONE_TOKEN: '   ' }).token).toBeNull();
  });

  it('can disable loopback trust explicitly (token-only enforcement)', () => {
    expect(agentDoneAuthConfigFromEnv({ DISPATCH_DONE_TRUST_LOOPBACK: 'false' }).trustLoopback).toBe(false);
    expect(agentDoneAuthConfigFromEnv({ DISPATCH_DONE_TRUST_LOOPBACK: '0' }).trustLoopback).toBe(false);
  });
});

describe('isLoopback', () => {
  it('recognises the loopback forms', () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
  });
  it('rejects non-loopback and empty', () => {
    expect(isLoopback('10.0.0.5')).toBe(false);
    expect(isLoopback('')).toBe(false);
    expect(isLoopback(null)).toBe(false);
    expect(isLoopback(undefined)).toBe(false);
  });
});

describe('authenticateAgentDone — trusted-local mode (no token configured)', () => {
  const cfg = { token: null, trustLoopback: true };

  it('accepts a loopback caller', () => {
    expect(authenticateAgentDone({ remoteIp: '127.0.0.1' }, cfg)).toEqual({ ok: true });
  });

  it('rejects a non-loopback caller with 403', () => {
    const r = authenticateAgentDone({ remoteIp: '10.0.0.5' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('rejects when loopback trust is disabled and no token is presented', () => {
    const r = authenticateAgentDone({ remoteIp: '127.0.0.1' }, { token: null, trustLoopback: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe('authenticateAgentDone — token mode (token configured)', () => {
  const cfg = { token: 's3cret', trustLoopback: true };

  it('accepts the correct token regardless of source ip', () => {
    expect(authenticateAgentDone({ remoteIp: '10.0.0.5', headerToken: 's3cret' }, cfg)).toEqual({ ok: true });
  });

  it('returns 401 when the token is missing entirely', () => {
    const r = authenticateAgentDone({ remoteIp: '127.0.0.1' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('returns 403 when the token is present but wrong', () => {
    const r = authenticateAgentDone({ remoteIp: '127.0.0.1', headerToken: 'nope' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('does NOT let a loopback source bypass a configured token', () => {
    // Token, once configured, is mandatory: loopback alone is not enough.
    const r = authenticateAgentDone({ remoteIp: '127.0.0.1', headerToken: '' }, cfg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });
});
