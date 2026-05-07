// SPDX-License-Identifier: MIT
//
// Spec 053 — verify_signal runner. Pure function. Walks the typed
// verify_signal discriminated union and returns a VerifyResult. Tests
// inject fakes via VerifyContext (fetch, statFile, readFile,
// vercelDeployStatus) so checks run hermetically.

import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  VerifySignal,
  VerifyResult,
  VerifyFailure,
  VerifyContext,
  DeskTagCheck,
} from './types.js';

const DEFAULT_DESK_PATH = join(homedir(), 'Dropbox/Obsidian/Desk.md');

export async function runVerifySignal(
  signal: VerifySignal,
  ctx: VerifyContext,
): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];

  switch (signal.type) {
    case 'desk_tag': {
      const failure = await checkDeskTag(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
    case 'all': {
      for (const sub of signal.checks) {
        const subResult = await runVerifySignal(sub, ctx);
        failures.push(...subResult.failures);
      }
      break;
    }
    case 'http_get':
    case 'file_mtime':
    case 'api_call':
      failures.push({ check: signal, reason: `${signal.type} not yet implemented` });
      break;
  }

  return { status: failures.length ? 'fail' : 'pass', failures };
}

async function checkDeskTag(check: DeskTagCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const path = ctx.desk_path ?? DEFAULT_DESK_PATH;
  const reader = ctx.readFile ?? ((p: string) => fs.readFile(p, 'utf-8'));
  let content: string;
  try {
    content = await reader(path);
  } catch (err) {
    return { check, reason: `desk read failed: ${(err as Error).message}` };
  }
  if (!content.includes(check.artifact_path)) {
    return { check, reason: `artifact_path "${check.artifact_path}" not on Desk` };
  }
  const windowEnd = ctx.dispatched_at + check.within_hours * 3600 * 1000;
  if (Date.now() > windowEnd) {
    return { check, reason: `desk_tag window of ${check.within_hours}h elapsed` };
  }
  return null;
}
