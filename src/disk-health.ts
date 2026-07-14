import { statfsSync } from "node:fs";

const GIB = 1024 ** 3;

export type DiskHeadroomState = "ok" | "warn" | "critical" | "unknown";

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
  reason: string | null;
}

export interface DiskHeadroomOptions {
  path?: string;
  minFreeBytes?: number;
  warnFreeBytes?: number;
  statfs?: (path: string) => ReturnType<typeof statfsSync>;
}

export const DEFAULT_DISK_MIN_FREE_BYTES = 5 * GIB;
export const DEFAULT_DISK_WARN_FREE_BYTES = 10 * GIB;

function roundGib(bytes: number | null): number | null {
  return bytes == null ? null : Math.round((bytes / GIB) * 10) / 10;
}

function statfsNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function classifyDiskHeadroom(availableBytes: number, minFreeBytes: number, warnFreeBytes: number): DiskHeadroomState {
  if (availableBytes < minFreeBytes) return "critical";
  if (availableBytes < warnFreeBytes) return "warn";
  return "ok";
}

export function readDiskHeadroom(options: DiskHeadroomOptions = {}): DiskHeadroom {
  const path = options.path ?? process.env.MANAGER_DISK_HEALTH_PATH ?? process.cwd();
  const minFreeBytes = options.minFreeBytes ?? DEFAULT_DISK_MIN_FREE_BYTES;
  const warnFreeBytes = options.warnFreeBytes ?? DEFAULT_DISK_WARN_FREE_BYTES;

  try {
    const stats = (options.statfs ?? statfsSync)(path);
    const blockSize = statfsNumber(stats.bsize);
    const totalBytes = statfsNumber(stats.blocks) * blockSize;
    const freeBytes = statfsNumber(stats.bfree) * blockSize;
    const availableBytes = statfsNumber(stats.bavail) * blockSize;
    const usedPercent = totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : null;
    const state = classifyDiskHeadroom(availableBytes, minFreeBytes, warnFreeBytes);

    return {
      schema_version: "disk-headroom.v1",
      state,
      path,
      free_bytes: freeBytes,
      available_bytes: availableBytes,
      total_bytes: totalBytes,
      free_gib: roundGib(freeBytes),
      available_gib: roundGib(availableBytes),
      total_gib: roundGib(totalBytes),
      used_percent: usedPercent,
      min_free_bytes: minFreeBytes,
      warn_free_bytes: warnFreeBytes,
      reason: state === "ok" ? null : `available disk headroom is below ${roundGib(state === "critical" ? minFreeBytes : warnFreeBytes)} GiB`,
    };
  } catch (err) {
    return {
      schema_version: "disk-headroom.v1",
      state: "unknown",
      path,
      free_bytes: null,
      available_bytes: null,
      total_bytes: null,
      free_gib: null,
      available_gib: null,
      total_gib: null,
      used_percent: null,
      min_free_bytes: minFreeBytes,
      warn_free_bytes: warnFreeBytes,
      reason: err instanceof Error ? err.message : "disk headroom probe failed",
    };
  }
}
