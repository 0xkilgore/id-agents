// The "two-node-versions trap" guard (T-INFRA, recurring P0).
//
// better-sqlite3 is a NATIVE module: its compiled binding only loads under the
// Node ABI it was built for. On this machine there are two nodes:
//   - manager node  /opt/homebrew/bin/node  (v23.x, NODE_MODULE_VERSION 131)
//   - shell node    ~/.local/bin/node       (v22.x, NODE_MODULE_VERSION 127)
// `scripts/ensure-native-abi.mjs` rebuilds the binding for the MANAGER node, so
// the manager loads it fine. But if an AGENT process is spawned with bare
// `spawn('node', …)` it inherits the SHELL node off $PATH, the ABI doesn't
// match, and the agent silently degrades to "memory-only mode" (terminal
// agent_error). The fix: spawn every agent/manager process under the SAME node
// the native binding was built for.
//
// This module is the runtime twin of `scripts/native-node.mjs::managerNode()`.
// Keep the resolution order identical in both files.

import { existsSync } from "node:fs";

/** Canonical manager node on this machine (mirrors scripts/native-node.mjs). */
export const CANONICAL_MANAGER_NODE = "/opt/homebrew/bin/node";

/**
 * Resolve the Node binary every agent/manager child process MUST be spawned
 * under — the one the native better-sqlite3 binding is compiled for.
 *
 * Order (identical to scripts/native-node.mjs::managerNode):
 *   1. IDAGENTS_BUILD_NODE   — explicit override (also what ensure-native-abi builds for)
 *   2. /opt/homebrew/bin/node — the canonical manager node on this machine
 *   3. process.execPath       — last resort (the node running THIS process)
 *
 * When the caller IS the manager (running under /opt/homebrew/bin/node) every
 * branch resolves to that same node, so agents inherit the exact node whose
 * binding the manager already loaded successfully.
 */
export function resolveManagerNode(): string {
  const override = process.env.IDAGENTS_BUILD_NODE;
  if (override && existsSync(override)) return override;
  if (existsSync(CANONICAL_MANAGER_NODE)) return CANONICAL_MANAGER_NODE;
  return process.execPath;
}

/**
 * True when `err` is a native-module ABI mismatch (better-sqlite3 built for a
 * different Node ABI than the one currently running). These must FAIL LOUD —
 * never silently fall back to memory-only — because they signal the two-node
 * trap, a deployment error a silent fallback would mask.
 */
export function isAbiMismatchError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "ERR_DLOPEN_FAILED") return true;
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return (
    /NODE_MODULE_VERSION/i.test(msg) ||
    /was compiled against a different Node\.js version/i.test(msg) ||
    /ERR_DLOPEN_FAILED/i.test(msg) ||
    // better-sqlite3 surfaces the bindings probe failure this way too.
    (/better[_-]?sqlite3/i.test(msg) && /(recompil|reinstall|different Node)/i.test(msg))
  );
}

/** Human-readable diagnostic for an ABI mismatch — what node, what to run. */
export function abiMismatchDiagnostic(err: unknown): string {
  const expected = resolveManagerNode();
  return [
    `FATAL: better-sqlite3 native ABI mismatch — this process cannot open the shared DB.`,
    `  running node : ${process.execPath} (${process.version}, NODE_MODULE_VERSION ${process.versions.modules})`,
    `  binding built for the MANAGER node: ${expected}`,
    `  This is the two-node trap: the agent was spawned under the wrong node.`,
    `  Fix: spawn agents under the manager node (resolveManagerNode) and run \`npm rebuild better-sqlite3\``,
    `       under ${expected} (see scripts/ensure-native-abi.mjs).`,
    `  underlying error: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
  ].join("\n");
}
