#!/usr/bin/env node
// T11.1 build-stamp: capture the COMPILE-TIME commit + timestamp into
// dist/build-info.json so the running manager can report exactly which commit
// it was built from (vs origin/main). Run as the final step of `npm run build`.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "dist");

function git(args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

const build_sha = git(["rev-parse", "HEAD"]);
const build_time = new Date().toISOString();
const build_branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);

try {
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    join(distDir, "build-info.json"),
    JSON.stringify({ build_sha, build_time, build_branch }, null, 2) + "\n",
    "utf8",
  );
  console.log(`[build-info] dist/build-info.json written: ${build_sha ?? "unknown"} @ ${build_time}`);
} catch (err) {
  // Never fail the build over the stamp — the runtime falls back to git HEAD.
  console.warn(`[build-info] failed to write build-info.json: ${err?.message ?? err}`);
}
