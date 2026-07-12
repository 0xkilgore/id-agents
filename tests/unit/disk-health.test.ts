import { describe, expect, it } from "vitest";

import { readDiskHeadroom } from "../../src/disk-health.js";

describe("readDiskHeadroom", () => {
  it("reports filesystem headroom for an existing path", () => {
    const health = readDiskHeadroom({ path: process.cwd(), minFreeBytes: 1, warnFreeBytes: 2 });

    expect(health.schema_version).toBe("disk-headroom.v1");
    expect(health.path).toBe(process.cwd());
    expect(health.state).toBe("ok");
    expect(health.available_bytes).toEqual(expect.any(Number));
    expect(health.available_gib).toEqual(expect.any(Number));
    expect(health.used_percent).toEqual(expect.any(Number));
  });

  it("classifies low headroom as critical before warn", () => {
    const baseline = readDiskHeadroom({ path: process.cwd() });
    expect(baseline.available_bytes).toEqual(expect.any(Number));

    const available = baseline.available_bytes ?? 0;
    const health = readDiskHeadroom({
      path: process.cwd(),
      minFreeBytes: available + 1,
      warnFreeBytes: available + 2,
    });

    expect(health.state).toBe("critical");
    expect(health.reason).toMatch(/available disk headroom is below/);
  });

  it("returns unknown when the probe path is unreadable", () => {
    const health = readDiskHeadroom({ path: "/definitely/missing/id-agents-disk-health-test" });

    expect(health.state).toBe("unknown");
    expect(health.available_bytes).toBeNull();
    expect(health.reason).toEqual(expect.any(String));
  });
});
