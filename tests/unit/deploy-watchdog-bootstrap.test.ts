import { describe, expect, it } from "vitest";
// @ts-expect-error — plain ESM module (no d.ts); imported for runtime behavior.
import { retryLaunchdBootstrap } from "../../scripts/lib/deploy-watchdog-bootstrap.mjs";

describe("retryLaunchdBootstrap", () => {
  it("retries bootout+bootstrap and succeeds on the third attempt", async () => {
    const calls: string[] = [];
    const sleeps: number[] = [];
    let bootstrapAttempts = 0;

    const result = await retryLaunchdBootstrap({
      service: "com.example.manager",
      plist: "/tmp/manager.plist",
      backoffMs: [15, 30, 60],
      sleep: async (ms: number) => { sleeps.push(ms); },
      run: (cmd: string) => {
        calls.push(cmd);
        if (cmd.includes(" bootstrap ")) {
          bootstrapAttempts += 1;
          if (bootstrapAttempts < 3) throw new Error(`bootstrap I/O error ${bootstrapAttempts}`);
        }
      },
    });

    expect(result).toEqual({ ok: true, attempts: 3 });
    expect(bootstrapAttempts).toBe(3);
    expect(sleeps).toEqual([15, 30]);
    expect(calls.filter((cmd) => cmd.includes("bootout"))).toHaveLength(3);
    expect(calls.filter((cmd) => cmd.includes(" bootstrap "))).toHaveLength(3);
  });

  it("returns failure after all bootstrap attempts fail", async () => {
    const sleeps: number[] = [];
    const result = await retryLaunchdBootstrap({
      service: "com.example.manager",
      plist: "/tmp/manager.plist",
      backoffMs: [15, 30, 60],
      sleep: async (ms: number) => { sleeps.push(ms); },
      run: (cmd: string) => {
        if (cmd.includes(" bootstrap ")) throw new Error("bootstrap: I/O error");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error?.message).toContain("I/O error");
    expect(sleeps).toEqual([15, 30]);
  });
});
