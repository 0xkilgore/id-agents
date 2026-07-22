import { existsSync, statfsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const GIB = 1024 ** 3;
const HOUR_MS = 60 * 60 * 1000;

export type DiskHeadroomState = "ok" | "warn" | "critical" | "unknown";

export interface DiskSample {
  at_ms: number;
  available_bytes: number;
  checkout_bytes: Record<string, number>;
}

export interface ProtectedCheckout {
  name: string;
  path: string;
  present: boolean;
  size_bytes: number | null;
}

export interface DiskHeadroom {
  schema_version: "disk-headroom.v1";
  state: DiskHeadroomState;
  path: string;
  free_bytes: number | null;
  available_bytes: number | null;
  total_bytes: number | null;
  free_gib: number | null;
  available_gib: number | null;
  total_gib: number | null;
  used_percent: number | null;
  min_free_bytes: number;
  warn_free_bytes: number;
  consumption_bytes_per_hour_1h: number | null;
  consumption_bytes_per_hour_6h: number | null;
  largest_recent_checkout_growth: { name: string; path: string; growth_bytes: number } | null;
  protected_checkouts: ProtectedCheckout[];
  reason: string | null;
}

export interface DiskHeadroomOptions {
  path?: string;
  minFreeBytes?: number;
  warnFreeBytes?: number;
  nowMs?: number;
  history?: DiskSample[];
  protectedCheckouts?: Array<{ name: string; path: string }>;
  readCheckoutBytes?: (path: string) => number | null;
}

export const DEFAULT_DISK_MIN_FREE_BYTES = 15 * GIB;
export const DEFAULT_DISK_WARN_FREE_BYTES = 25 * GIB;
export const DEFAULT_PROTECTED_CHECKOUTS = [
  { name: "5100", path: "/Users/kilgore/Dropbox/Code/kapelle-console-5100-release" },
  { name: "3016", path: "/Users/kilgore/Dropbox/Code/kapelle-wave140-3016-origin-main" },
  { name: "RC", path: "/Users/kilgore/Dropbox/Code/kapelle-console-worktrees/wave142-ui-consolidation-rc" },
];

const processHistory: DiskSample[] = [];

function roundGib(bytes: number | null): number | null {
  return bytes == null ? null : Math.round((bytes / GIB) * 10) / 10;
}

function checkoutBytes(path: string): number | null {
  if (!existsSync(path)) return null;
  const result = spawnSync("du", ["-sk", path], { encoding: "utf8", timeout: 5_000 });
  if (result.status !== 0) return null;
  const kib = Number.parseInt(result.stdout.trim().split(/\s+/, 1)[0] ?? "", 10);
  return Number.isFinite(kib) ? kib * 1024 : null;
}

function rate(samples: DiskSample[], nowMs: number, availableBytes: number, hours: number): number | null {
  const target = nowMs - hours * HOUR_MS;
  const prior = [...samples].filter((sample) => sample.at_ms <= target).sort((a, b) => b.at_ms - a.at_ms)[0];
  if (!prior) return null;
  const elapsedHours = (nowMs - prior.at_ms) / HOUR_MS;
  return elapsedHours > 0 ? Math.round((prior.available_bytes - availableBytes) / elapsedHours) : null;
}

function largestGrowth(
  samples: DiskSample[],
  nowMs: number,
  current: Record<string, number>,
  checkouts: ProtectedCheckout[],
): DiskHeadroom["largest_recent_checkout_growth"] {
  const prior = [...samples].filter((sample) => sample.at_ms <= nowMs - HOUR_MS).sort((a, b) => b.at_ms - a.at_ms)[0];
  if (!prior) return null;
  let largest: DiskHeadroom["largest_recent_checkout_growth"] = null;
  for (const checkout of checkouts) {
    const before = prior.checkout_bytes[checkout.name];
    const after = current[checkout.name];
    if (before == null || after == null) continue;
    const growth = after - before;
    if (!largest || growth > largest.growth_bytes) largest = { name: checkout.name, path: checkout.path, growth_bytes: growth };
  }
  return largest;
}

export function readDiskHeadroom(options: DiskHeadroomOptions = {}): DiskHeadroom {
  const path = options.path ?? process.env.MANAGER_DISK_HEALTH_PATH ?? "/";
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_DISK_MIN_FREE_BYTES;
  const warnFreeBytes = options.warnFreeBytes ?? DEFAULT_DISK_WARN_FREE_BYTES;
  const nowMs = options.nowMs ?? Date.now();
  const definitions = options.protectedCheckouts ?? DEFAULT_PROTECTED_CHECKOUTS;
  const readBytes = options.readCheckoutBytes ?? checkoutBytes;
  const protectedCheckouts = definitions.map((checkout) => {
    const size = readBytes(checkout.path);
    // A size probe may time out on a large checkout; presence is a separate,
    // cheap signal and must not become a false critical in that case.
    const present = options.readCheckoutBytes ? size != null : existsSync(checkout.path);
    return { ...checkout, present, size_bytes: size };
  });
  const currentCheckoutBytes = Object.fromEntries(
    protectedCheckouts.flatMap((checkout) => checkout.size_bytes == null ? [] : [[checkout.name, checkout.size_bytes]]),
  );
  const history = options.history ?? processHistory;

  try {
    const stats = statfsSync(path);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const availableBytes = stats.bavail * stats.bsize;
    const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : null;
    const slope1h = rate(history, nowMs, availableBytes, 1);
    const slope6h = rate(history, nowMs, availableBytes, 6);
    const missing = protectedCheckouts.filter((checkout) => !checkout.present);
    const projectedSixHourFree = slope6h != null && slope6h > 0 ? availableBytes - slope6h * 6 : availableBytes;
    const state: DiskHeadroomState = missing.length > 0 || availableBytes < minFreeBytes
      ? "critical"
      : availableBytes < warnFreeBytes || projectedSixHourFree < warnFreeBytes
        ? "warn"
        : "ok";
    const reason = missing.length > 0
      ? `protected checkout missing: ${missing.map((checkout) => checkout.name).join(", ")}`
      : state === "ok"
        ? null
        : projectedSixHourFree < warnFreeBytes && availableBytes >= warnFreeBytes
          ? "6h consumption slope projects disk headroom below the warning floor"
          : `available disk headroom is below ${roundGib(state === "critical" ? minFreeBytes : warnFreeBytes)} GiB`;

    if (!options.history) {
      processHistory.push({ at_ms: nowMs, available_bytes: availableBytes, checkout_bytes: currentCheckoutBytes });
      while (processHistory.length > 1 && processHistory[0].at_ms < nowMs - 7 * HOUR_MS) processHistory.shift();
    }

    return {
      schema_version: "disk-headroom.v1", state, path,
      free_bytes: freeBytes, available_bytes: availableBytes, total_bytes: totalBytes,
      free_gib: roundGib(freeBytes), available_gib: roundGib(availableBytes), total_gib: roundGib(totalBytes),
      used_percent: usedPercent, min_free_bytes: minFreeBytes, warn_free_bytes: warnFreeBytes,
      consumption_bytes_per_hour_1h: slope1h, consumption_bytes_per_hour_6h: slope6h,
      largest_recent_checkout_growth: largestGrowth(history, nowMs, currentCheckoutBytes, protectedCheckouts),
      protected_checkouts: protectedCheckouts, reason,
    };
  } catch (err) {
    return {
      schema_version: "disk-headroom.v1", state: "unknown", path,
      free_bytes: null, available_bytes: null, total_bytes: null,
      free_gib: null, available_gib: null, total_gib: null, used_percent: null,
      min_free_bytes: minFreeBytes, warn_free_bytes: warnFreeBytes,
      consumption_bytes_per_hour_1h: null, consumption_bytes_per_hour_6h: null,
      largest_recent_checkout_growth: null, protected_checkouts: protectedCheckouts,
      reason: err instanceof Error ? err.message : "disk headroom probe failed",
    };
  }
}
