// SPDX-License-Identifier: MIT
/**
 * Remote heartbeat probe for public-agent-remote agents.
 *
 * Tries GET /health first; falls back to GET /.well-known/restap.json.
 * Returns a ProbeResult describing the outcome.
 */

export interface ProbeResult {
  /** Overall online status. */
  ok: boolean;
  /** Which endpoint succeeded (or 'none'). */
  source: 'health' | 'well-known' | 'none';
  /** Unix seconds of last successful probe, or null. */
  last_seen: number | null;
  /** Classified error string, or null on success. */
  last_error: string | null;
}

export interface ProbeFetchResult {
  status: number;
  body?: any;
  error?: string;
}

export type HealthProbeFn = (
  url: string,
  timeoutMs: number,
) => Promise<ProbeFetchResult>;

/** Classify a fetch-level error into canonical error codes. */
function classifyError(err: any, status?: number): string {
  if (status !== undefined && status !== 200) return `http_${status}`;
  if (!err) return 'invalid_body';
  const name: string = err.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  const msg: string = String(err.message ?? err);
  if (
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('network') ||
    name === 'FetchError'
  ) {
    return 'network';
  }
  return 'network';
}

/** Default real implementation using node-fetch / global fetch. */
export const defaultHealthProbeFn: HealthProbeFn = async (
  url: string,
  timeoutMs: number,
): Promise<ProbeFetchResult> => {
  // Dynamic import keeps this module usable in test contexts that mock fetch
  const nodeFetch = (await import('node-fetch')).default;
  try {
    const resp = await (nodeFetch as any)(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: any;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return { status: resp.status, body };
  } catch (err: any) {
    return { status: 0, error: err?.message ?? String(err), body: null };
  }
};

/**
 * Probe a remote agent's health.
 *
 * 1. Try GET <public_endpoint_url>/health (5s timeout, no redirects, JSON).
 * 2. On failure, fall back to GET <public_endpoint_url>/.well-known/restap.json.
 * 3. Both fail → ok=false.
 */
export async function probeRemoteAgent(
  agent: { public_endpoint_url: string | null },
  deps: { fetch?: HealthProbeFn; timeoutMs?: number },
): Promise<ProbeResult> {
  const baseUrl = agent.public_endpoint_url;
  if (!baseUrl) {
    return { ok: false, source: 'none', last_seen: null, last_error: 'no_public_endpoint' };
  }

  const probeFn = deps.fetch ?? defaultHealthProbeFn;
  const timeout = deps.timeoutMs ?? 5000;
  const now = Math.floor(Date.now() / 1000);

  // --- Step 1: /health ---
  let healthResult: ProbeFetchResult;
  try {
    healthResult = await probeFn(`${baseUrl}/health`, timeout);
  } catch (err: any) {
    healthResult = { status: 0, error: err?.message ?? String(err) };
  }

  const healthOk =
    healthResult.status === 200 &&
    healthResult.body != null &&
    typeof healthResult.body === 'object' &&
    healthResult.body.status === 'ok';

  if (healthOk) {
    return { ok: true, source: 'health', last_seen: now, last_error: null };
  }

  // Classify the health probe failure for use in the well-known error
  let healthErr: string;
  if (healthResult.error) {
    healthErr = classifyError({ name: detectErrorName(healthResult.error), message: healthResult.error });
  } else if (healthResult.status !== 200) {
    healthErr = classifyError(null, healthResult.status);
  } else {
    healthErr = 'invalid_body';
  }

  // --- Step 2: /.well-known/restap.json ---
  let wkResult: ProbeFetchResult;
  try {
    wkResult = await probeFn(`${baseUrl}/.well-known/restap.json`, timeout);
  } catch (err: any) {
    wkResult = { status: 0, error: err?.message ?? String(err) };
  }

  const wkOk =
    wkResult.status === 200 &&
    wkResult.body != null &&
    typeof wkResult.body === 'object' &&
    wkResult.body.service_type === 'public-agent';

  if (wkOk) {
    return {
      ok: true,
      source: 'well-known',
      last_seen: now,
      last_error: 'health probe failed, well-known succeeded',
    };
  }

  // Both failed — classify the final error
  let finalErr: string;
  if (wkResult.error) {
    finalErr = classifyError({ name: detectErrorName(wkResult.error), message: wkResult.error });
  } else if (wkResult.status !== 200) {
    finalErr = classifyError(null, wkResult.status);
  } else {
    finalErr = 'invalid_body';
  }

  // Report health error if well-known also failed with a network/timeout issue, else the wk error
  return { ok: false, source: 'none', last_seen: null, last_error: finalErr };
}

/** Heuristically detect error name from an error message string. */
function detectErrorName(msg: string): string {
  if (msg.includes('AbortError') || msg.includes('abort')) return 'AbortError';
  if (msg.includes('TimeoutError') || msg.includes('timeout')) return 'TimeoutError';
  return 'FetchError';
}
