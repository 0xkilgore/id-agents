import { describe, expect, it, vi } from "vitest";

import { createManagerDbWithAbiRecovery } from "../../src/lib/startup-db.js";

function abiError(): Error & { code: string } {
  const err = new Error("The module was compiled against a different Node.js version");
  (err as Error & { code: string }).code = "ERR_DLOPEN_FAILED";
  return err as Error & { code: string };
}

describe("createManagerDbWithAbiRecovery", () => {
  it("runs ABI repair exactly once and retries DB open exactly once", async () => {
    const db = { adapter: { dialect: "sqlite" }, close: async () => {} } as any;
    const createDb = vi.fn()
      .mockRejectedValueOnce(abiError())
      .mockResolvedValueOnce(db);
    const migrateDb = vi.fn().mockResolvedValue(undefined);
    const runAbiRepair = vi.fn();
    const log = { warn: vi.fn(), error: vi.fn() };

    await expect(createManagerDbWithAbiRecovery(createDb, migrateDb, { runAbiRepair, log })).resolves.toBe(db);

    expect(createDb).toHaveBeenCalledTimes(2);
    expect(runAbiRepair).toHaveBeenCalledTimes(1);
    expect(migrateDb).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not repair non-ABI startup errors", async () => {
    const createDb = vi.fn().mockRejectedValue(new Error("permission denied"));
    const migrateDb = vi.fn();
    const runAbiRepair = vi.fn();

    await expect(createManagerDbWithAbiRecovery(createDb, migrateDb, { runAbiRepair })).rejects.toThrow("permission denied");

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(runAbiRepair).not.toHaveBeenCalled();
    expect(migrateDb).not.toHaveBeenCalled();
  });

  it("logs MANAGER_STARTUP_ABI_REBUILD_FAILED and fails fast when retry still cannot open DB", async () => {
    const createDb = vi.fn()
      .mockRejectedValueOnce(abiError())
      .mockRejectedValueOnce(abiError());
    const migrateDb = vi.fn();
    const runAbiRepair = vi.fn();
    const log = { warn: vi.fn(), error: vi.fn() };

    await expect(createManagerDbWithAbiRecovery(createDb, migrateDb, { runAbiRepair, log })).rejects.toThrow(/different Node/);

    expect(createDb).toHaveBeenCalledTimes(2);
    expect(runAbiRepair).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("MANAGER_STARTUP_ABI_REBUILD_FAILED"));
  });
});
