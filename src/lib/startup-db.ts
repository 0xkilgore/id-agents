import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Db } from "../db/index.js";
import { abiMismatchDiagnostic, isAbiMismatchError } from "./native-node.js";

export type CreateDbFn = () => Promise<Db>;
export type MigrateDbFn = (db: Db) => Promise<void>;
export type RunAbiRepairFn = () => void;

export function defaultRunAbiRepair(): void {
  const script = path.resolve(process.cwd(), "scripts/ensure-native-abi.mjs");
  if (!existsSync(script)) {
    throw new Error(`ensure-native-abi script not found at ${script}`);
  }
  execFileSync(process.execPath, [script], {
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
}

export async function createManagerDbWithAbiRecovery(
  createDb: CreateDbFn,
  migrateDb: MigrateDbFn,
  opts: {
    runAbiRepair?: RunAbiRepairFn;
    log?: Pick<Console, "warn" | "error">;
  } = {},
): Promise<Db> {
  const runAbiRepair = opts.runAbiRepair ?? defaultRunAbiRepair;
  const log = opts.log ?? console;

  try {
    const db = await createDb();
    await migrateDb(db);
    return db;
  } catch (err) {
    if (!isAbiMismatchError(err)) throw err;
    log.warn(abiMismatchDiagnostic(err));
  }

  try {
    runAbiRepair();
  } catch (repairErr) {
    log.error(`MANAGER_STARTUP_ABI_REBUILD_FAILED repair_command_failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)}`);
    throw repairErr;
  }

  try {
    const db = await createDb();
    await migrateDb(db);
    return db;
  } catch (retryErr) {
    log.error(`MANAGER_STARTUP_ABI_REBUILD_FAILED db_retry_failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
    throw retryErr;
  }
}
