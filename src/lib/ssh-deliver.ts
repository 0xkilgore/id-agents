// SPDX-License-Identifier: MIT
/**
 * SSH / SCP identity-file delivery helper.
 *
 * Copies a local file to a remote host over SCP.  Designed to be dependency-
 * injectable so tests can substitute a fake without spawning real processes.
 *
 * Usage:
 *   import { deliverIdentityFile } from './ssh-deliver.js';
 *
 * In tests, override the module-level default by passing a custom function
 * directly to the caller that accepts a DeliverFn.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DeliverResult {
  ok: boolean;
  error?: string;
  stderr?: string;
}

export type DeliverFn = (
  sshTarget: string,
  localPath: string,
  remotePath: string,
  opts?: { timeoutMs?: number; scpPath?: string },
) => Promise<DeliverResult>;

/**
 * Default SCP-based implementation.
 *
 * sshTarget: "user@host" or "user@host:port"
 * localPath:  absolute path to the local file to push
 * remotePath: absolute path on the remote host
 */
export async function deliverIdentityFile(
  sshTarget: string,
  localPath: string,
  remotePath: string,
  opts: { timeoutMs?: number; scpPath?: string } = {},
): Promise<DeliverResult> {
  // Validate sshTarget — no shell injection
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+(:\d+)?$/.test(sshTarget)) {
    return { ok: false, error: 'invalid_ssh_target' };
  }

  const scp = opts.scpPath || 'scp';
  const timeoutMs = opts.timeoutMs ?? 10_000;

  // scp port must be passed via -P flag, not inline colon
  const parts = sshTarget.split(':');
  const hostPart = parts[0]; // user@host
  const port = parts[1];     // optional port string

  const args: string[] = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
  ];
  if (port) {
    args.push('-P', port);
  }
  args.push(localPath, `${hostPart}:${remotePath}`);

  try {
    await execFileAsync(scp, args, { timeout: timeoutMs });
    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      error: err.code || 'scp_failed',
      stderr: (err.stderr || '').toString().slice(0, 500),
    };
  }
}

/**
 * Module-level default delivery function.
 * Replace this in tests to inject a stub without touching AgentManagerDb's
 * constructor signature:
 *
 *   import * as sshDeliver from '../../src/lib/ssh-deliver.js';
 *   sshDeliver.defaultDeliverFn = myStub;
 */
export let defaultDeliverFn: DeliverFn = deliverIdentityFile;

/**
 * Redact the user portion of an ssh target for log output.
 *   "alice@vps.example.com:22" → "<redacted>@vps.example.com:22"
 *
 * The hostname and port stay in the log so an operator can still correlate a
 * failure with the destination host. Keep the full target only in admin API
 * responses, never in stdout/stderr.
 */
export function redactSshTarget(sshTarget: string | null | undefined): string {
  if (!sshTarget) return '<unset>';
  const at = sshTarget.indexOf('@');
  if (at < 0) return '<redacted>';
  return `<redacted>@${sshTarget.slice(at + 1)}`;
}
