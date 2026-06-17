#!/usr/bin/env node
// Ensure better-sqlite3's native module is compiled for the MANAGER's Node ABI
// — NOT the shell node. Runs as both `pretest` and `postbuild`.
//
// Why the manager node specifically: the promote smoke gate + this script may be
// invoked by the interactive shell node (v22, ABI 127), but the manager runs
// /opt/homebrew/bin/node (v23, ABI 131). A rebuild done for the shell node makes
// the manager crash-loop on restart (ERR_DLOPEN_FAILED). So we ALWAYS build for
// the manager node, regardless of which node runs this script.
//
// Fast no-op (one probe) when already matching.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { managerNode } from "./native-node.mjs";

const node = managerNode();

function nodeVersion(n) {
  try {
    return execFileSync(n, ["-v"], { encoding: "utf8" }).trim();
  } catch {
    return "?";
  }
}

// Probe by actually instantiating in a FRESH process under the manager node —
// `require` alone can be lazy, and a freshly-rebuilt .node needs a clean process.
function loadsUnderManager() {
  try {
    execFileSync(
      node,
      ["-e", "const D = require('better-sqlite3'); new D(':memory:').close();"],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

if (loadsUnderManager()) {
  console.log(`[ensure-native-abi] better-sqlite3 OK for manager node ${node} (${nodeVersion(node)})`);
  process.exit(0);
}

console.warn(
  `[ensure-native-abi] better-sqlite3 not loadable under manager node ${node} (${nodeVersion(node)}) — rebuilding for its ABI…`,
);
try {
  // Prepend the manager node's dir so `npm` + node-gyp resolve to it and compile
  // for ITS ABI, even though this script itself may run under the shell node.
  execFileSync("npm", ["rebuild", "better-sqlite3"], {
    stdio: "inherit",
    env: { ...process.env, PATH: `${dirname(node)}:${process.env.PATH}` },
  });
} catch (err) {
  console.error(`[ensure-native-abi] npm rebuild better-sqlite3 failed: ${err?.message ?? err}`);
  process.exit(1);
}
if (!loadsUnderManager()) {
  console.error(
    `[ensure-native-abi] better-sqlite3 STILL not loadable under manager node ${node} after rebuild`,
  );
  process.exit(1);
}
console.warn(`[ensure-native-abi] better-sqlite3 rebuilt for manager node ${node} (${nodeVersion(node)})`);
