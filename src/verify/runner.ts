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
  HttpGetCheck,
  FileMtimeCheck,
  ApiCallCheck,
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
    case 'http_get': {
      const failure = await checkHttpGet(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
    case 'file_mtime': {
      const failure = await checkFileMtime(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
    case 'api_call': {
      const failure = await checkApiCall(signal, ctx);
      if (failure) failures.push(failure);
      break;
    }
  }

  return { status: failures.length ? 'fail' : 'pass', failures };
}

async function checkApiCall(check: ApiCallCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  if (check.service !== 'vercel_deploy') {
    return {
      check,
      reason: `api_call service "${check.service}" not yet implemented (file separate spec)`,
    };
  }
  const fetcher = ctx.fetch;
  if (!fetcher && !process.env.VERCEL_TOKEN) {
    return { check, reason: 'VERCEL_TOKEN env var not set' };
  }
  const f = fetcher ?? fetch;
  const headers: Record<string, string> = {};
  if (process.env.VERCEL_TOKEN) headers.Authorization = `Bearer ${process.env.VERCEL_TOKEN}`;
  let response: Response;
  try {
    response = await f(`https://api.vercel.com/v13/deployments/${check.id}`, { headers });
  } catch (err) {
    return { check, reason: `vercel api fetch failed: ${(err as Error).message}` };
  }
  if (response.status !== 200) {
    return { check, reason: `vercel api returned ${response.status}` };
  }
  const body = (await response.json()) as { readyState?: string };
  if (body.readyState !== 'READY') {
    return { check, reason: `deployment readyState=${body.readyState ?? 'unknown'}` };
  }
  return null;
}

async function checkHttpGet(check: HttpGetCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const fetcher = ctx.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(check.url);
  } catch (err) {
    return { check, reason: `fetch failed: ${(err as Error).message}` };
  }
  const expected = check.status ?? 200;
  if (response.status !== expected) {
    return { check, reason: `status ${response.status} != expected ${expected}` };
  }
  if (check.must_contain) {
    const text = await response.text();
    if (!text.includes(check.must_contain)) {
      return { check, reason: `body missing "${check.must_contain}"` };
    }
  }
  return null;
}

async function checkFileMtime(check: FileMtimeCheck, ctx: VerifyContext): Promise<VerifyFailure | null> {
  const stat = ctx.statFile ?? (async (p: string) => {
    const s = await fs.stat(p);
    return { mtimeMs: s.mtimeMs };
  });
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(check.path)).mtimeMs;
  } catch (err) {
    return { check, reason: `stat failed: ${(err as Error).message}` };
  }
  // `after` is unix epoch seconds per the spec.
  if (mtimeMs / 1000 < check.after) {
    return {
      check,
      reason: `mtime ${new Date(mtimeMs).toISOString()} is before ${new Date(check.after * 1000).toISOString()}`,
    };
  }
  return null;
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
