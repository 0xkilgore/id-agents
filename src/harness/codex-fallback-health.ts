// SPDX-License-Identifier: MIT
//
// Codex fallback runtime health probe (C1), modeled on cursor-fallback-health.ts.
//
// The npm Codex vendor binary is present but its Apple Developer-ID cert is
// REVOKED, so macOS kills it intermittently: sometimes SIGKILL/hang (exit 137),
// sometimes a silent exit-0 with NO output. A probe that trusts the exit code
// alone reports the dead binary healthy (the false-green bug). So this probe:
//   - closes stdin (so a legitimately-installed binary can't hang the probe),
//   - bounds the run with a short timeout,
//   - and ASSERTS a non-empty, version-shaped stdout (/\d+\.\d+\.\d+/) — the
//     exit-code trap. Exit 0 with empty/garbage stdout is `unavailable`, not live.
// Returns a tri-state (live/unavailable/degraded) + a reason code.

import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export type CodexFallbackStatus = 'live' | 'degraded' | 'unavailable';

/** Why the Codex fallback is not live (null when live). */
export type CodexUnavailableReason =
  | 'not_installed' // spawn ENOENT — the binary really is absent
  | 'timeout' // timed out / SIGKILL(137) — the revoked-cert kill or a hang
  | 'no_output' // exit 0 but empty / non-version-shaped stdout (the exit-code trap)
  | 'cert_revoked' // execution failed in a way consistent with a revoked signing cert
  | null;

export interface CodexFallbackHealth {
  status: CodexFallbackStatus;
  binary: string;
  version: string | null;
  checked_at: number;
  live_checked: boolean;
  reason: CodexUnavailableReason;
  detail: string;
}

export interface CodexFallbackHealthOptions {
  binary?: string;
  timeoutMs?: number;
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
}

const DEFAULT_BINARY = 'codex';
const DEFAULT_TIMEOUT_MS = 3_000;
/** A usable `codex --version` MUST print a semver-shaped token. */
const VERSION_SHAPE = /\d+\.\d+\.\d+/;

function asText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value || '';
}

function compactDetail(value: unknown): string {
  if (value instanceof Error && value.message) return value.message.slice(0, 500);
  return String(value || 'unknown error').slice(0, 500);
}

/** Classify a spawn/exec failure into an unavailable reason. */
function classifyExecError(err: unknown): CodexUnavailableReason {
  const e = err as { code?: string; signal?: string; killed?: boolean; status?: number };
  if (e?.code === 'ENOENT') return 'not_installed';
  if (e?.code === 'ETIMEDOUT' || e?.killed || e?.signal === 'SIGKILL' || e?.status === 137) {
    return 'timeout';
  }
  // Present-but-won't-run (non-zero exit / abnormal signal): consistent with the
  // revoked-cert kill that doesn't cleanly time out.
  return 'cert_revoked';
}

/**
 * Probe the Codex fallback runtime. Pure over an injectable `execFile` so the
 * revoked-cert failure modes (SIGKILL, exit-0-no-output) are unit-testable.
 */
export async function checkCodexFallbackHealth(
  options: CodexFallbackHealthOptions = {},
): Promise<CodexFallbackHealth> {
  const binary = options.binary || process.env.CODEX_PATH || DEFAULT_BINARY;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.execFile || execFile;
  const checked_at = Date.now();

  let stdout = '';
  let stderr = '';
  try {
    const result = await run(binary, ['--version'], { timeout, maxBuffer: 128 * 1024 });
    stdout = asText(result.stdout).trim();
    stderr = asText(result.stderr).trim();
  } catch (err) {
    const reason = classifyExecError(err);
    return {
      status: 'unavailable',
      binary,
      version: null,
      checked_at,
      live_checked: true,
      reason,
      detail: `codex --version failed (${reason}): ${compactDetail(err)}`,
    };
  }

  // The exit-code trap: the revoked binary can exit 0 with empty / non-version
  // output. A live runtime MUST print a semver-shaped version.
  if (!VERSION_SHAPE.test(stdout)) {
    return {
      status: 'unavailable',
      binary,
      version: null,
      checked_at,
      live_checked: true,
      reason: 'no_output',
      detail:
        stdout.length === 0
          ? 'codex --version exited without printing a version (revoked-cert silent exit-0)'
          : `codex --version printed non-version-shaped output: ${stdout.slice(0, 120)}`,
    };
  }

  return {
    status: 'live',
    binary,
    version: stdout,
    checked_at,
    live_checked: true,
    reason: null,
    detail: `codex fallback is live${stderr ? `; stderr=${stderr.slice(0, 120)}` : ''}`,
  };
}
