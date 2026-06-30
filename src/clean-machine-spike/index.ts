// SPDX-License-Identifier: MIT
//
// Clean-machine spike eval — code-resolvable risk gates for the BYO-Claude
// bundled-fleet desktop bet. See ./boot-config.ts (R2) and ./graceful.ts (R5),
// and the spike report at cto/output/2026-06-29-clean-machine-spike-report.md.

export {
  CHRIS_PATH_MARKERS,
  resolveBundleBootConfig,
  scanForChrisPaths,
  isCleanMachineBootable,
  type BundleBootConfig,
  type ChrisPathFinding,
} from './boot-config.js';

export {
  NON_CLAUDE_PROVIDER_ISSUE_CODES,
  assessClaudeOnlyGraceful,
  type ClaudeOnlyGracefulResult,
} from './graceful.js';
