// SPDX-License-Identifier: MIT
//
// Clean-machine spike — boot-config eval (R2 de-Chris boot-from-bundle).
//
// Per cto/output/2026-06-29-clean-machine-spike-spec.md, the make-or-break
// packaging question is whether the manager + one agent + console can boot
// from a notarizable Tauri bundle on a *stranger's* clean Mac with ONLY
// app-local dirs — i.e. with zero `/Users/kilgore`, Dropbox, or `com.kilgore`
// references baked into the resolved runtime config.
//
// The R1 (entitlements/signing) and R6 (WKWebView render parity) risks require
// an actual macOS Tauri build+sign+screenshot session and are NOT encoded here.
// This module encodes the two risks that are fully resolvable in code today:
//
//   R2 — de-Chris boot-from-bundle:   resolveBundleBootConfig() + scanForChrisPaths()
//   R5 — Claude-only graceful:        see ./graceful.ts
//
// Following the §F "research-as-build → eval-as-code" precedent (artifact-store-eval,
// gateway-eval, observability-eval), the spike's PASS/FAIL signal for R2 is a
// reproducible, CI-gated assertion rather than a one-off manual grep.

import os from 'node:os';
import path from 'node:path';
import { resolveDefaultWorkspaceDir, resolveIdAgentsHome } from '../lib/data-root.js';

// What counts as a "Chris-path leak" must be correct on BOTH Chris's dev machine
// and a stranger's clean Mac. A naive `/Users/kilgore` substring check is wrong:
// on Chris's own machine every legitimately app-local path (e.g. under
// `~/Library/Application Support/Kapelle`) expands to `/Users/kilgore/...` because
// that IS his home. The real, non-relocatable signals are:
//   - `Dropbox`     — his sync tree; no clean Mac mounts it.
//   - `com.kilgore` — his launchd label namespace.
//   - a hardcoded `/Users/<someone>/...` home that is NOT the running user's home
//     (a baked-in absolute home that would not relocate on another account).
// Paths rooted at the *current* user's home are portable and therefore clean.

/** Fixed substrings that are always a non-relocatable Chris-machine dependency. */
export const CHRIS_PATH_MARKERS = [
  'Dropbox',
  'com.kilgore',
] as const;

/** The fully-resolved set of filesystem/port inputs the bundled manager + agent
 *  boot from. Every value here must be derivable from app-local env alone. */
export interface BundleBootConfig {
  /** Per-user data root (ID_AGENTS_HOME / XDG / ~/.id-agents). */
  idAgentsHome: string;
  /** Manager + agent working directory. */
  workdir: string;
  /** SQLite database path. */
  sqlitePath: string;
  /** Protected-repo registry overlay file, or null when defaults would apply. */
  repoRegistryFile: string | null;
  /** Manager management port. `0` requests a dynamic free port (Tauri picks it). */
  managerPort: number;
}

/**
 * Resolve the complete clean-machine boot config from an env bag, honoring the
 * exact override seams the Tauri sidecar sets (see spec §"The dirs to relocate").
 *
 * This intentionally mirrors the precedence already implemented in
 * start-agent-manager.ts / db/index.ts / lib/data-root.ts so the eval proves the
 * *shipping* resolution path is clean, not a parallel re-implementation.
 */
export function resolveBundleBootConfig(env: NodeJS.ProcessEnv = process.env): BundleBootConfig {
  const idAgentsHome = resolveIdAgentsHome(env);
  const workdir = env.AGENT_MANAGER_WORKDIR?.trim() || resolveDefaultWorkspaceDir(env);
  const sqlitePath = env.SQLITE_PATH?.trim() || path.join(workdir, 'data', 'id-agents.db');
  const repoRegistryFile = env.IDAGENTS_REPO_REGISTRY?.trim() || null;

  // Port precedence matches start-agent-manager.ts (AGENT_MANAGER_PORT), but the
  // bundle requests a dynamic free port via `0` so it never collides on a shared
  // machine. A hard-coded 4100 default is only used when nothing is set.
  const rawPort = env.AGENT_MANAGER_PORT?.trim();
  const managerPort = rawPort === undefined || rawPort === '' ? 4100 : Number.parseInt(rawPort, 10);

  return { idAgentsHome, workdir, sqlitePath, repoRegistryFile, managerPort };
}

export interface ChrisPathFinding {
  field: keyof BundleBootConfig;
  value: string;
  marker: string;
}

/** The running user's home directory (the relocation target on a clean Mac). */
function currentHome(env: NodeJS.ProcessEnv): string {
  return env.HOME?.trim() || os.homedir();
}

/** If `value` hardcodes a `/Users/<name>` home that is NOT the running user's,
 *  return that foreign-home marker; otherwise null. Paths under the current
 *  user's home are relocatable and therefore clean. */
function foreignHomeMarker(value: string, home: string): string | null {
  const m = /^(\/Users\/[^/]+)(?:\/|$)/.exec(value);
  if (!m) return null;
  const homePrefix = `/Users/${path.basename(home)}`;
  return m[1] === homePrefix ? null : m[1];
}

/**
 * Scan a resolved boot config for any non-relocatable Chris-machine path leak.
 * An empty array is the R2 PASS signal: the bundle boots from app-local dirs only.
 *
 * `repoRegistryFile` is exempt from the scan ONLY when null (defaults apply); a
 * non-null overlay path is scanned because the bundle ships its own app-local
 * overlay and must not point back at a Chris path.
 */
export function scanForChrisPaths(
  config: BundleBootConfig,
  env: NodeJS.ProcessEnv = process.env,
): ChrisPathFinding[] {
  const findings: ChrisPathFinding[] = [];
  const home = currentHome(env);
  const fields: (keyof BundleBootConfig)[] = [
    'idAgentsHome',
    'workdir',
    'sqlitePath',
    'repoRegistryFile',
  ];
  for (const field of fields) {
    const value = config[field];
    if (typeof value !== 'string') continue;
    for (const marker of CHRIS_PATH_MARKERS) {
      if (value.includes(marker)) findings.push({ field, value, marker });
    }
    const foreign = foreignHomeMarker(value, home);
    if (foreign) findings.push({ field, value, marker: foreign });
  }
  return findings;
}

/** True when the resolved boot config has zero Chris-path leaks (R2 PASS). */
export function isCleanMachineBootable(env: NodeJS.ProcessEnv = process.env): boolean {
  return scanForChrisPaths(resolveBundleBootConfig(env), env).length === 0;
}
