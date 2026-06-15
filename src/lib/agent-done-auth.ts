// SPDX-License-Identifier: MIT
// R.2: tighten POST /agent-done so a closeout cannot spoof or accidentally
// complete the wrong dispatch.
//
// The route already enforces strict dispatch_id/query_id matching (Task 9): when
// BOTH ids are supplied and resolve to different docs it returns 409. What it
// lacked was an authentication gate — anything that could reach the management
// port could post a closeout for any dispatch. This adds the smallest gate
// consistent with the existing manager pattern (isAdminRequest = loopback +
// header): a trusted-local caller, or a matching shared token when one is
// configured.
//
// Both decisions are pure and unit-testable; the route maps the result to HTTP.

import crypto from 'node:crypto';

export interface AgentDoneAuthConfig {
  /** When set, callers MUST present this token (x-id-dispatch-token header).
   *  A configured token is mandatory and decisive — loopback no longer bypasses. */
  token: string | null;
  /** When true (default), a loopback source IP is itself sufficient auth.
   *  This keeps the local agent fleet working with no per-agent changes. */
  trustLoopback: boolean;
}

/** Build the auth config from the process environment. Defaults keep the
 *  endpoint open to trusted-local callers so the fleet works unchanged; setting
 *  DISPATCH_DONE_TOKEN locks it to a shared secret without a framework rewrite. */
export function agentDoneAuthConfigFromEnv(env: NodeJS.ProcessEnv): AgentDoneAuthConfig {
  const token = (env.DISPATCH_DONE_TOKEN ?? '').trim();
  const trust = (env.DISPATCH_DONE_TRUST_LOOPBACK ?? 'true').trim().toLowerCase();
  return {
    token: token.length > 0 ? token : null,
    trustLoopback: trust !== 'false' && trust !== '0',
  };
}

/** The loopback source forms the manager accepts (same set as isAdminRequest). */
export function isLoopback(ip: string | undefined | null): boolean {
  if (!ip) return false;
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403; error: string };

export interface AuthInput {
  /** Source IP of the request (express req.ip). */
  remoteIp?: string | null;
  /** Value of the x-id-dispatch-token header, if any. */
  headerToken?: string | null;
}

/**
 * Decide whether a /agent-done caller is authorised.
 *  - Token mode (token configured): the token is mandatory. Missing -> 401,
 *    wrong -> 403, correct -> ok. Loopback does NOT bypass.
 *  - Trusted-local mode (no token): a loopback source is sufficient; anything
 *    else is 403.
 */
export function authenticateAgentDone(input: AuthInput, cfg: AgentDoneAuthConfig): AuthResult {
  if (cfg.token) {
    const presented = (input.headerToken ?? '').trim();
    if (presented.length === 0) {
      return { ok: false, status: 401, error: 'agent-done: missing auth token' };
    }
    if (!timingSafeEqualStr(presented, cfg.token)) {
      return { ok: false, status: 403, error: 'agent-done: invalid auth token' };
    }
    return { ok: true };
  }

  if (cfg.trustLoopback && isLoopback(input.remoteIp)) {
    return { ok: true };
  }
  return {
    ok: false,
    status: 403,
    error: 'agent-done: caller is not trusted-local and no valid auth token was presented',
  };
}

/** Constant-time string compare that tolerates length mismatch without throwing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
