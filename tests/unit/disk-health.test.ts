import { describe, expect, it } from "vitest";

import {
  DEFAULT_DISK_MIN_FREE_BYTES,
  DEFAULT_DISK_WARN_FREE_BYTES,
  readDiskHeadroom,
} from "../../src/disk-health.js";

describe("readDiskHeadroom", () => {
  const protectedCheckouts = [
    { name: "5100", path: "/protected/5100" },
    { name: "3016", path: "/protected/3016" },
    { name: "RC", path: "/protected/rc" },
  ];
  const allPresent = (path: string) => path.endsWith("5100") ? 500 : path.endsWith("3016") ? 300 : 100;

  it("uses the NAS-era fleet thresholds by default", () => {
    expect(DEFAULT_DISK_WARN_FREE_BYTES).toBe(25 * 1024 ** 3);
    expect(DEFAULT_DISK_MIN_FREE_BYTES).toBe(15 * 1024 ** 3);

    const health = readDiskHeadroom({ path: process.cwd(), protectedCheckouts, readCheckoutBytes: allPresent });
    expect(health.warn_free_bytes).toBe(DEFAULT_DISK_WARN_FREE_BYTES);
    expect(health.min_free_bytes).toBe(DEFAULT_DISK_MIN_FREE_BYTES);
  });

  it("reports filesystem headroom for an existing path", () => {
    const health = readDiskHeadroom({ path: process.cwd(), minFreeBytes: 1, warnFreeBytes: 2, protectedCheckouts, readCheckoutBytes: allPresent });

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
      protectedCheckouts,
      readCheckoutBytes: allPresent,
    });

    expect(health.state).toBe("critical");
    expect(health.reason).toMatch(/available disk headroom is below/);
  });

  it("returns unknown when the probe path is unreadable", () => {
    const health = readDiskHeadroom({ path: "/definitely/missing/id-agents-disk-health-test", protectedCheckouts, readCheckoutBytes: allPresent });

    expect(health.state).toBe("unknown");
    expect(health.available_bytes).toBeNull();
    expect(health.reason).toEqual(expect.any(String));
  });

  it("projects deterministic ok and warn states from 1h/6h consumption slopes", () => {
    const baseline = readDiskHeadroom({ path: process.cwd(), protectedCheckouts, readCheckoutBytes: allPresent });
    const available = baseline.available_bytes ?? 0;
    const nowMs = 10 * 60 * 60 * 1000;
    const history = [
      { at_ms: nowMs - 6 * 60 * 60 * 1000, available_bytes: available + 12_000, checkout_bytes: { "5100": 100, "3016": 300, RC: 100 } },
      { at_ms: nowMs - 60 * 60 * 1000, available_bytes: available + 3_000, checkout_bytes: { "5100": 200, "3016": 300, RC: 100 } },
    ];
    const ok = readDiskHeadroom({ path: process.cwd(), minFreeBytes: 1, warnFreeBytes: 2, nowMs, history, protectedCheckouts, readCheckoutBytes: allPresent });
    expect(ok.state).toBe("ok");
    expect(ok.consumption_bytes_per_hour_1h).toBe(3_000);
    expect(ok.consumption_bytes_per_hour_6h).toBe(2_000);
    expect(ok.largest_recent_checkout_growth).toMatchObject({ name: "5100", growth_bytes: 300 });

    const warn = readDiskHeadroom({
      path: process.cwd(), minFreeBytes: 1, warnFreeBytes: available - 1_000,
      nowMs, history: [{ at_ms: nowMs - 6 * 60 * 60 * 1000, available_bytes: available + 12_000, checkout_bytes: {} }],
      protectedCheckouts, readCheckoutBytes: allPresent,
    });
    expect(warn.state).toBe("warn");
    expect(warn.reason).toMatch(/projects disk headroom/);
  });

  it("reports a missing protected checkout as critical", () => {
    const health = readDiskHeadroom({
      path: process.cwd(), minFreeBytes: 1, warnFreeBytes: 2,
      protectedCheckouts,
      readCheckoutBytes: (path) => path.endsWith("3016") ? null : 100,
    });
    expect(health.state).toBe("critical");
    expect(health.reason).toBe("protected checkout missing: 3016");
    expect(health.protected_checkouts.find((checkout) => checkout.name === "3016")?.present).toBe(false);
  });
});
