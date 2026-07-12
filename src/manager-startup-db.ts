// SPDX-License-Identifier: MIT

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { createDb, migrateDb } from './db.js';
import { resolveManagerNode } from './lib/native-node.js';

const ABI_REBUILD_FAILURE_MARKER = 'MANAGER_STARTUP_ABI_REBUILD_FAILED';

export interface ManagerStartupDbDeps {
  createDb: () => Promise<Db>;
  migrateDb: (db: Db) => Promise<void>;
  rebuildNativeAbi: () => void;
  logWarn: (message: string) => void;
  logError: (message: string) => void;
}

function isErrDlopenFailed(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ERR_DLOPEN_FAILED';
}

export function rebuildNativeAbiForStartup(): void {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(moduleDir, '..');
  const scriptPath = join(repoRoot, 'scripts', 'ensure-native-abi.mjs');
  const nodeBin = resolveManagerNode();
  execFileSync(nodeBin, [scriptPath, 'rebuild-and-retry'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_BIN: nodeBin,
      IDAGENTS_BUILD_NODE: nodeBin,
    },
  });
}

async function openAndMigrateDb(deps: Pick<ManagerStartupDbDeps, 'createDb' | 'migrateDb'>): Promise<Db> {
  const db = await deps.createDb();
  await deps.migrateDb(db);
  return db;
}

export async function openManagerDbWithAbiRebuildRetry(
  deps: ManagerStartupDbDeps = {
    createDb,
    migrateDb,
    rebuildNativeAbi: rebuildNativeAbiForStartup,
    logWarn: (message) => console.warn(message),
    logError: (message) => console.error(message),
  },
): Promise<Db> {
  try {
    return await openAndMigrateDb(deps);
  } catch (err) {
    if (!isErrDlopenFailed(err)) {
      throw err;
    }

    deps.logWarn(
      `Manager DB open failed with ERR_DLOPEN_FAILED; running scripts/ensure-native-abi.mjs rebuild-and-retry once before retrying DB open.`,
    );

    try {
      deps.rebuildNativeAbi();
    } catch (rebuildErr) {
      deps.logError(`${ABI_REBUILD_FAILURE_MARKER}: rebuild-and-retry failed: ${rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr)}`);
      throw rebuildErr;
    }

    try {
      return await openAndMigrateDb(deps);
    } catch (retryErr) {
      deps.logError(`${ABI_REBUILD_FAILURE_MARKER}: DB open still failed after one rebuild-and-retry: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      throw retryErr;
    }
  }
}
