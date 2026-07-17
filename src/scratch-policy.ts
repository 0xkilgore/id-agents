import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCRATCH_CAP_BYTES = 30 * 1024 ** 3;
export const SCRATCH_TTL_MS = 6 * 60 * 60 * 1000;

export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.ID_AGENTS_SCRATCH_ROOT || path.join(os.homedir(), "scratch"));
}

export function scratchArea(area: "promotions" | "rewrites" | "builds" | "worktrees", env: NodeJS.ProcessEnv = process.env): string {
  const root = scratchRoot(env);
  const dir = path.join(root, area);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function scratchPath(area: "promotions" | "rewrites" | "builds" | "worktrees", prefix: string, env: NodeJS.ProcessEnv = process.env): string {
  const safe = prefix.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "job";
  return path.join(scratchArea(area, env), `${safe}-${Date.now()}-${process.pid}`);
}
