// SPDX-License-Identifier: MIT
/**
 * Bounded Claude Code CLI auth/readiness preflight.
 *
 * This intentionally uses the Claude Code CLI login path. It never sets or
 * requires ANTHROPIC_API_KEY, and it strips parent-session handoff variables so
 * launchd/GUI workers validate the same auth path their harness will use.
 */

import { spawn } from 'child_process';
import { detectSessionHandoffVars, SESSION_HANDOFF_VARS } from '../lib/env-hygiene.js';
import { redactSecrets } from './transient-errors.js';

export type ClaudeAuthPreflightSignal =
  | 'CLAUDE AUTH OK'
  | 'CLAUDE AUTH FAIL'
  | 'CLAUDE AUTH PROVIDER_TRANSIENT';

export type ClaudeAuthPreflightStatus = 'ok' | 'fail' | 'provider_transient';

export interface ClaudeAuthPreflightResult {
  status: ClaudeAuthPreflightStatus;
  signal: ClaudeAuthPreflightSignal;
  exitCode: number | null;
  durationMs: number;
  reason: string;
  redactedMessage: string;
}

export interface ClaudeAuthPreflightOptions {
  workingDirectory: string;
  model?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  claudePath?: string;
  spawnImpl?: typeof spawn;
}

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 45_000;
const PREFLIGHT_PROMPT = 'Reply with exactly AUTH_OK and no other text.';

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function resolveClaudeAuthPreflightTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return parsePositiveInt(env.ID_CLAUDE_AUTH_PREFLIGHT_TIMEOUT_MS, DEFAULT_PREFLIGHT_TIMEOUT_MS);
}

export function sanitizeClaudeCliEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SESSION_HANDOFF_VARS) {
    delete childEnv[key];
  }
  delete childEnv.CLAUDECODE;
  delete childEnv.CLAUDE_CODE_SSE_PORT;
  delete childEnv.CLAUDE_CODE_ENTRYPOINT;
  return childEnv;
}

export function classifyClaudeAuthPreflight(
  input: { exitCode: number | null; stdout?: string; stderr?: string; timedOut?: boolean },
): Omit<ClaudeAuthPreflightResult, 'durationMs'> {
  const rawMessage = [input.stderr || '', input.stdout || ''].join('\n').trim();
  const redactedMessage = redactSecrets(rawMessage);
  const lower = redactedMessage.toLowerCase();

  if (input.exitCode === 0 && /\bAUTH_OK\b/.test(input.stdout || '')) {
    return {
      status: 'ok',
      signal: 'CLAUDE AUTH OK',
      exitCode: input.exitCode,
      reason: 'claude_cli_ping_succeeded',
      redactedMessage: '',
    };
  }

  if (
    input.timedOut ||
    /\b5\d\d\b/.test(redactedMessage) ||
    lower.includes('overloaded') ||
    lower.includes('temporarily unavailable') ||
    lower.includes('service unavailable') ||
    lower.includes('bad gateway') ||
    lower.includes('gateway timeout') ||
    lower.includes('rate limit') ||
    lower.includes('too many requests') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound') ||
    lower.includes('network')
  ) {
    return {
      status: 'provider_transient',
      signal: 'CLAUDE AUTH PROVIDER_TRANSIENT',
      exitCode: input.exitCode,
      reason: input.timedOut ? 'claude_cli_ping_timeout' : 'provider_or_network_transient',
      redactedMessage,
    };
  }

  if (
    /\b40[123]\b/.test(redactedMessage) ||
    lower.includes('unauthorized') ||
    lower.includes('not logged in') ||
    lower.includes('login') ||
    lower.includes('authentication') ||
    lower.includes('auth') ||
    lower.includes('invalid api key') ||
    lower.includes('subscription') ||
    lower.includes('billing') ||
    lower.includes('plan')
  ) {
    return {
      status: 'fail',
      signal: 'CLAUDE AUTH FAIL',
      exitCode: input.exitCode,
      reason: 'auth_or_plan_failure',
      redactedMessage,
    };
  }

  return {
    status: 'fail',
    signal: 'CLAUDE AUTH FAIL',
    exitCode: input.exitCode,
    reason: 'claude_cli_ping_failed',
    redactedMessage,
  };
}

export async function runClaudeWorkerAuthPreflight(
  options: ClaudeAuthPreflightOptions,
): Promise<ClaudeAuthPreflightResult> {
  const startedAt = Date.now();
  const env = sanitizeClaudeCliEnv(options.env || process.env);
  const timeoutMs = options.timeoutMs ?? resolveClaudeAuthPreflightTimeoutMs(env);
  const claudePath = options.claudePath || env.CLAUDE_PATH || 'claude';
  const spawnImpl = options.spawnImpl || spawn;
  const args = [
    '-p',
    PREFLIGHT_PROMPT,
    '--output-format',
    'json',
    ...(options.model ? ['--model', options.model] : []),
  ];

  return await new Promise<ClaudeAuthPreflightResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const proc = spawnImpl(claudePath, args, {
      cwd: options.workingDirectory,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (input: { exitCode: number | null; timedOut?: boolean; spawnError?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const classified = classifyClaudeAuthPreflight({
        exitCode: input.exitCode,
        stdout,
        stderr: input.spawnError ? input.spawnError.message : stderr,
        timedOut: input.timedOut,
      });
      resolve({ ...classified, durationMs: Date.now() - startedAt });
    };

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* already gone */ }
      finish({ exitCode: null, timedOut: true });
    }, timeoutMs);

    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (error) => finish({ exitCode: null, spawnError: error }));
    proc.on('close', (code) => finish({ exitCode: code ?? 1 }));
  });
}

export function formatClaudeAuthPreflightLog(
  result: ClaudeAuthPreflightResult,
  context: { runtime: string; model?: string; timeoutMs: number; handoffVars?: string[] },
): string {
  return JSON.stringify({
    event: 'claude_worker_auth_preflight',
    signal: result.signal,
    status: result.status,
    runtime: context.runtime,
    model: context.model,
    timeout_ms: context.timeoutMs,
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    reason: result.reason,
    stripped_handoff_vars: context.handoffVars || [],
    message: result.redactedMessage || undefined,
  });
}

export function detectClaudeAuthPreflightHandoffVars(env: NodeJS.ProcessEnv = process.env): string[] {
  const detected = new Set<string>(detectSessionHandoffVars(env));
  for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_ENTRYPOINT']) {
    if (env[key] !== undefined) detected.add(key);
  }
  return [...detected].sort();
}
