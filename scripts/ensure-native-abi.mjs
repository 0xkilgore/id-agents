#!/usr/bin/env node
// pretest harness guard: ensure better-sqlite3's native module matches the
// running Node ABI before the test suite runs.
//
// The prebuilt better_sqlite3.node flips between Node versions across installs
// (e.g. a Node 23 build vs a Node 22 runner = NODE_MODULE_VERSION 131 vs 127).
// A mismatch makes EVERY DB-backed test fail at setup: `new SqliteAdapter()`
// throws in beforeEach, so `adapter` is undefined and afterEach's
// `adapter.close()` reports the misleading `Cannot read properties of undefined
// (reading 'close')` — ~half the suite, which then fails the promote-to-main
// smoke gate. This guard rebuilds better-sqlite3 for the current Node on any
// load failure, so `npm test` self-heals under whatever Node runs it.
//
// Fast no-op (one child spawn) when the module already matches.

import { execFileSync } from "node:child_process";

function loadsCleanly() {
  // Probe in a FRESH process so a freshly-rebuilt .node is picked up (native
  // modules can't be reliably reloaded in-process after a failed dlopen).
  try {
    execFileSync(
      process.execPath,
      ["-e", "const D = require('better-sqlite3'); new D(':memory:').close();"],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

if (loadsCleanly()) {
  process.exit(0);
}

console.warn(
  `[ensure-native-abi] better-sqlite3 not loadable under Node ${process.version} — rebuilding native module…`,
);
try {
  execFileSync("npm", ["rebuild", "better-sqlite3"], { stdio: "inherit" });
} catch (err) {
  console.error(`[ensure-native-abi] npm rebuild better-sqlite3 failed: ${err?.message ?? err}`);
  process.exit(1);
}
if (!loadsCleanly()) {
  console.error("[ensure-native-abi] better-sqlite3 still not loadable after rebuild");
  process.exit(1);
}
console.warn(`[ensure-native-abi] better-sqlite3 rebuilt OK for Node ${process.version}`);
