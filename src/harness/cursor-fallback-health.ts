// SPDX-License-Identifier: MIT
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';

const execFile = promisify(execFileCb);

export type CursorFallbackStatus = 'live' | 'degraded' | 'unavailable';

export interface CursorFallbackHealth {
  status: CursorFallbackStatus;
  binary: string;
  version: string | null;
  checked_at: number;
  live_checked: boolean;
  detail: string;
  smoke_stdout?: string;
}

export interface CursorFallbackHealthOptions {
  live?: boolean;
  binary?: string;
  timeoutMs?: number;
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;
}

const DEFAULT_BINARY = '/Users/kilgore/.local/bin/cursor-agent';
const SMOKE_PROMPT = 'Say exactly: cursor-agent smoke test ok';
const EXPECTED_SMOKE = 'cursor-agent smoke test ok';

function asText(value: string | Buffer | undefined): string {
  return Buffer.isBuffer(value) ? value.toString('utf8') : value || '';
}

function compactDetail(value: unknown): string {
  if (value instanceof Error && value.message) return value.message.slice(0, 500);
  return String(value || 'unknown error').slice(0, 500);
}

export async function checkCursorFallbackHealth(
  options: CursorFallbackHealthOptions = {},
): Promise<CursorFallbackHealth> {
  const binary = options.binary || process.env.CURSOR_AGENT_PATH || DEFAULT_BINARY;
  const timeout = options.timeoutMs ?? 20_000;
  const run = options.execFile || execFile;
  const checked_at = Date.now();

  let version: string | null = null;
  try {
    const versionResult = await run(binary, ['--version'], { timeout: 5_000, maxBuffer: 128 * 1024 });
    version = asText(versionResult.stdout).trim() || asText(versionResult.stderr).trim() || null;
  } catch (err) {
    return {
      status: 'unavailable',
      binary,
      version: null,
      checked_at,
      live_checked: false,
      detail: `cursor-agent binary/version check failed: ${compactDetail(err)}`,
    };
  }

  if (!options.live) {
    return {
      status: 'degraded',
      binary,
      version,
      checked_at,
      live_checked: false,
      detail: 'cursor-agent is installed, but no live host-context smoke has run for this status request',
    };
  }

  try {
    const smokeResult = await run(
      binary,
      ['--print', '--output-format', 'text', '-f', SMOKE_PROMPT],
      { timeout, maxBuffer: 1024 * 1024 },
    );
    const stdout = asText(smokeResult.stdout).trim();
    const stderr = asText(smokeResult.stderr).trim();
    if (stdout.includes(EXPECTED_SMOKE)) {
      return {
        status: 'live',
        binary,
        version,
        checked_at,
        live_checked: true,
        detail: 'cursor-agent host-context smoke returned the expected phrase',
        smoke_stdout: stdout,
      };
    }

    return {
      status: 'degraded',
      binary,
      version,
      checked_at,
      live_checked: true,
      detail: `cursor-agent smoke completed without expected phrase${stderr ? `; stderr=${stderr.slice(0, 300)}` : ''}`,
      smoke_stdout: stdout.slice(0, 500),
    };
  } catch (err) {
    return {
      status: 'degraded',
      binary,
      version,
      checked_at,
      live_checked: true,
      detail: `cursor-agent smoke failed in this process context: ${compactDetail(err)}`,
    };
  }
}
