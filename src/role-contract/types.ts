// SPDX-License-Identifier: MIT
//
// CoS role-contract types (T-COS first task — substrate-api lane).
//
// A *role contract* is the declarative definition of a fleet ROLE that runs
// "over the manager" engine: what the role IS, which agent behaviors compose it,
// what capabilities/surfaces it exposes, and what it requires to run. It is
// greenfield-first — instantiable for a fresh account/team, NOT a rewrite of the
// running system and NOT tied to Chris's data. Chris's own migration is a
// separate, shadowed, per-function scope (see RoleAccountScope).
//
// This is the contract only. The behaviors it names (morning brief, inbox
// triage, fleet preview) are implemented by later T-COS tasks in the
// cane/maestra/frontend lanes; here they are declared so the manager has a
// typed source of truth for what the Chief-of-Staff role provides.
//
// Conventions follow the existing typed registries (build-pools, track-registry)
// and read-models (tasks-readmodel/entry.ts: schema_version + team scoping).

export const ROLE_CONTRACT_SCHEMA_VERSION = 1 as const;

/** What a single capability surfaces. */
export type RoleCapabilityKind =
  | 'read_model' // a derived view the role exposes (e.g. morning brief)
  | 'action' // a behavior the role performs (e.g. inbox → tasks/dispatches)
  | 'surface'; // an operator-facing surface the role renders (e.g. fleet preview)

export interface RoleCapability {
  /** Stable kebab id, unique within a contract. */
  id: string;
  title: string;
  kind: RoleCapabilityKind;
  description: string;
}

/** How a composed agent behavior plugs into the role. */
export type RoleCompositionRole = 'intake' | 'planning' | 'engine';

export interface RoleComposition {
  /** Agent name providing the behavior, e.g. 'cane', 'maestra', or the manager. */
  agent: string;
  /** The behavior contributed, e.g. 'intake', 'planning', 'orchestration'. */
  behavior: string;
  /** The structural slot this composition fills in the role. */
  slot: RoleCompositionRole;
}

/**
 * Which account a contract instance targets. Greenfield contracts must carry NO
 * Chris-specific data and are validated for that (R5/T-DECHRIS posture). The
 * `chris-migration` scope is intentionally separate, shadowed, and per-function —
 * it does not gate greenfield delivery and is NOT exercised by this task.
 */
export type RoleAccountScope = 'greenfield' | 'chris-migration';

/**
 * What the role needs to run. Defaults encode the Claude-only-graceful posture
 * (R5): the keystone role must run on a stranger's box with ONLY a Claude
 * subscription — no Codex/Cursor/other provider required.
 */
export interface RoleRequirements {
  /** Runtimes the role can run on (Claude-first for the starter fleet). */
  runtimes: string[];
  /** True when the role degrades gracefully to a Claude-only fleet. */
  claude_only_graceful: boolean;
  /** Minimum distinct providers needed; 1 = works with Claude alone. */
  min_providers: number;
}

export interface RoleContract {
  schema_version: number;
  /** Stable kebab role id, e.g. 'chief-of-staff'. */
  role_id: string;
  title: string;
  summary: string;
  /** True for the role the fleet is organized around (CoS is the keystone). */
  keystone: boolean;
  account_scope: RoleAccountScope;
  /** Agent behaviors composed atop the manager engine (intake + planning + engine). */
  composes: RoleComposition[];
  capabilities: RoleCapability[];
  requirements: RoleRequirements;
  /**
   * Team this instance is bound to. `null` in a template seed; stamped by
   * instantiateRoleContract() when a fresh account adopts the role.
   */
  team_id: string | null;
}

export interface RoleContractValidationError {
  field: string;
  message: string;
}

export interface RoleContractValidationResult {
  valid: boolean;
  errors: RoleContractValidationError[];
}
