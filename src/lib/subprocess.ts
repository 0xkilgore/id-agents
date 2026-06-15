// R.1 subprocess-timeout reliability (W-004 silent-fail root cause).
//
// A typed, timeout-enforced wrapper for the agent-server's one-shot subprocess
// invocations (ows / lsof / ps / and any chrome-equivalent child). The bug it
// fixes: bare `execFileSync('ows', ...)` with no `timeout` blocks the
// agent-server thread forever when the child wedges (network/onchain stall,
// headless browser that never exits). Here EVERY call has an enforced OS-level
// timeout, and a wedged child is killed (SIGKILL on timeout by default) and
// returned as a typed failure instead of hanging.

import { execFileSync } from "node:child_process";

export type SubprocessResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; kind: "timeout"; timeoutMs: number; signal: string | null }
  | { ok: false; kind: "nonzero_exit"; code: number; stdout: string; stderr: string }
  | { ok: false; kind: "spawn_error"; message: string };

export interface RunOptions {
  /** Hard OS-level timeout. On expiry the child is sent `killSignal` and the
   *  call returns a typed `timeout` result. Required — the whole point. */
  timeoutMs: number;
  /** Signal used to kill on timeout. Default SIGKILL so a wedged child is
   *  definitively gone (no zombie survives the call). */
  killSignal?: NodeJS.Signals;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdin to feed the child. */
  input?: string;
  /** Output cap (bytes). Default 8 MiB. Exceeding it is a spawn_error. */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Run a subprocess to completion with an enforced timeout. Never throws;
 * returns a typed result. Synchronous (matches the existing agent-server
 * execFileSync call sites); the timeout is enforced by the OS via
 * execFileSync's `timeout` + `killSignal`.
 */
export function runWithTimeout(
  file: string,
  args: readonly string[],
  opts: RunOptions,
): SubprocessResult {
  const killSignal = opts.killSignal ?? "SIGKILL";
  try {
    const stdout = execFileSync(file, args as string[], {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      killSignal,
      cwd: opts.cwd,
      env: opts.env,
      input: opts.input,
      maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    return classifyError(err, opts.timeoutMs);
  }
}

interface ExecError {
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  code?: string | number | null;
  status?: number | null;
  errno?: number;
  stdout?: Buffer | string | null;
  stderr?: Buffer | string | null;
  message?: string;
}

function classifyError(err: unknown, timeoutMs: number): SubprocessResult {
  const e = (err ?? {}) as ExecError;

  // Timeout: execFileSync sets `killed: true` and `signal` to the kill signal
  // when the `timeout` fires. (code 'ETIMEDOUT' on some platforms.)
  if (e.killed === true || e.code === "ETIMEDOUT") {
    return { ok: false, kind: "timeout", timeoutMs, signal: e.signal ?? null };
  }

  // Nonzero exit: the child ran and exited with a non-zero status.
  if (typeof e.status === "number") {
    return {
      ok: false,
      kind: "nonzero_exit",
      code: e.status,
      stdout: toStr(e.stdout),
      stderr: toStr(e.stderr),
    };
  }

  // Spawn error (ENOENT missing binary, EACCES, maxBuffer exceeded, etc.).
  return { ok: false, kind: "spawn_error", message: e.message ?? String(err) };
}

function toStr(v: Buffer | string | null | undefined): string {
  if (v == null) return "";
  return typeof v === "string" ? v : v.toString("utf8");
}
