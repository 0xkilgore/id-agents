#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Narrow smoke for the manager orchestration read endpoints that Kapelle ops
// depends on. It deliberately does not restart or rewrite scheduler state; it
// just fails fast with enough context for the next bounded probe.

const MANAGER_URL = stripTrailingSlash(process.env.MANAGER_URL || process.env.ORCHESTRATION_HTTP_SMOKE_URL || 'http://127.0.0.1:4100');
const TIMEOUT_MS = positiveInt(process.env.ORCHESTRATION_HTTP_SMOKE_TIMEOUT_MS, 2000);

const probes = [
  {
    endpoint: '/orchestration/status',
    followUp: '/orchestration/backlog?state=ready',
  },
  {
    endpoint: '/orchestration/backlog',
    followUp: '/orchestration/backlog?state=needs_review',
  },
];

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

function isTimeoutError(err, elapsedMs) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError' || elapsedMs >= TIMEOUT_MS;
}

function boundedFollowUp(endpoint) {
  return `curl -fsS --max-time ${Math.max(1, Math.ceil(TIMEOUT_MS / 1000))} "${MANAGER_URL}${endpoint}"`;
}

async function probe({ endpoint, followUp }) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${MANAGER_URL}${endpoint}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const elapsedMs = Date.now() - startedAt;
    if (!res.ok) {
      return {
        ok: false,
        endpoint,
        elapsed_ms: elapsedMs,
        status: res.status,
        error: `HTTP ${res.status}`,
        suggested_bounded_query_follow_up: boundedFollowUp(followUp),
      };
    }
    await res.arrayBuffer();
    return { ok: true, endpoint, elapsed_ms: elapsedMs, status: res.status };
  } catch (err) {
    const elapsedMs = Date.now() - startedAt;
    return {
      ok: false,
      endpoint,
      elapsed_ms: elapsedMs,
      status: null,
      error: isTimeoutError(err, elapsedMs) ? `timed out after ${TIMEOUT_MS}ms` : messageOf(err),
      suggested_bounded_query_follow_up: boundedFollowUp(followUp),
    };
  }
}

for (const target of probes) {
  const result = await probe(target);
  if (!result.ok) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
  console.log(JSON.stringify(result));
}
