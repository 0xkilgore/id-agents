// SPDX-License-Identifier: MIT
//
// Clean-machine spike eval — code-resolvable risk gates for the BYO-Claude
// bundled-fleet desktop bet. See ./byo-claude.ts (R1), ./boot-config.ts (R2) and
// ./graceful.ts (R5), and the spike report at
// cto/output/2026-06-29-clean-machine-spike-report.md.

export {
  PRIVATE_MACHINE_PATH_MARKERS,
  resolveBundleBootConfig,
  scanForPrivateMachinePaths,
  isCleanMachineBootable,
  privateMachinePathMarkersFor,
  currentHome,
  type BundleBootConfig,
  type PrivateMachinePathFinding,
} from './boot-config.js';

export {
  BYO_CLAUDE_REQUIRED_HANDOFF,
  resolveClaudeConfigDir,
  resolveClaudeCredentialSources,
  probeByoClaudeCredential,
  isByoClaudeCredentialReady,
  type ClaudeCredentialKind,
  type ClaudeCredentialSource,
  type ByoClaudeProbeResult,
} from './byo-claude.js';

export {
  NON_CLAUDE_PROVIDER_ISSUE_CODES,
  assessClaudeOnlyGraceful,
  type ClaudeOnlyGracefulResult,
} from './graceful.js';

export {
  syntheticStrangerClaudeOnlyEnv,
  buildClaudeOnlyStarterFleetConfig,
  evaluateSyntheticStrangerStarterFleet,
  type StarterFleetSmokeResult,
} from './starter-fleet.js';
