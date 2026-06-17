// The Node the MANAGER process runs under. Native modules (better-sqlite3) MUST
// be compiled for THIS ABI — if they aren't, the manager crash-loops on restart
// with ERR_DLOPEN_FAILED (the "M4 two-node-versions trap": the interactive shell
// node and the manager node differ, so a rebuild done with the shell node
// silently breaks the manager).
//
// On this machine: shell node ~ v22.x (ABI 127), manager node
// /opt/homebrew/bin/node ~ v23.x (ABI 131). Override with IDAGENTS_BUILD_NODE.

import { existsSync } from "node:fs";

export function managerNode() {
  const env = process.env.IDAGENTS_BUILD_NODE;
  if (env && existsSync(env)) return env;
  if (existsSync("/opt/homebrew/bin/node")) return "/opt/homebrew/bin/node";
  // Last resort: the node running this script. Logged by callers so a wrong
  // fallback is visible rather than silently breaking the manager.
  return process.execPath;
}
