// Run vitest under the MANAGER's Node, not the shell node. Native modules
// (better-sqlite3) are built for the manager ABI (see ensure-native-abi.mjs), so
// the test suite must run under that same node or every DB-backed test fails to
// load the module. Pinning both to the manager node closes the two-node trap.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { managerNode } from "./native-node.mjs";

const require = createRequire(import.meta.url);

// vitest's `exports` blocks require.resolve of the CLI subpath, so resolve the
// package dir via its package.json and join the `bin` entry file directly.
const pkgJsonPath = require.resolve("vitest/package.json");
const pkgDir = dirname(pkgJsonPath);
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const binRel = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.vitest ?? "./vitest.mjs");
const vitestEntry = resolve(pkgDir, binRel);

const node = managerNode();
const args = process.argv.slice(2);
const passthrough = args.length > 0 ? args : ["run"];

try {
  execFileSync(node, [vitestEntry, ...passthrough], { stdio: "inherit" });
} catch (err) {
  // Propagate the real exit code so the smoke gate sees pass/fail correctly.
  process.exit(typeof err?.status === "number" ? err.status : 1);
}
