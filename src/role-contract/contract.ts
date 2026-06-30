// SPDX-License-Identifier: MIT
//
// CoS role-contract seed + registry + validation + instantiation.
//
// The greenfield Chief-of-Staff contract is the keystone-role source of truth
// the manager reads. It composes Cane (intake) + Maestra (planning) atop the
// manager engine and exposes the three starter-fleet capabilities: a morning
// brief, inbox triage (→ tasks/dispatches), and a fleet preview. It is
// greenfield (fresh account) and Claude-only-graceful (R5).
//
// Pattern: typed seed + pure resolver/validator + a small registry class, after
// build-pools/registry.ts and track-registry/registry.ts.

import {
  ROLE_CONTRACT_SCHEMA_VERSION,
  type RoleContract,
  type RoleContractValidationError,
  type RoleContractValidationResult,
} from './types.js';

/**
 * Greenfield Chief-of-Staff role contract (template — `team_id: null`).
 * Instantiate per fresh account with instantiateRoleContract().
 */
export const CHIEF_OF_STAFF_CONTRACT: RoleContract = {
  schema_version: ROLE_CONTRACT_SCHEMA_VERSION,
  role_id: 'chief-of-staff',
  title: 'Chief of Staff',
  summary:
    'The keystone starter-fleet role: gives a morning brief, triages inbox into ' +
    'tasks/dispatches, and previews what the fleet is doing — Cane intake + ' +
    'Maestra planning atop the manager engine.',
  keystone: true,
  account_scope: 'greenfield',
  composes: [
    { agent: 'manager', behavior: 'orchestration', slot: 'engine' },
    { agent: 'cane', behavior: 'intake', slot: 'intake' },
    { agent: 'maestra', behavior: 'planning', slot: 'planning' },
  ],
  capabilities: [
    {
      id: 'morning-brief',
      title: 'Morning brief',
      kind: 'read_model',
      description:
        "A start-of-day rundown of the fleet's state and what needs the user — " +
        'derived over the manager, on the new account’s own data.',
    },
    {
      id: 'inbox-triage',
      title: 'Inbox triage',
      kind: 'action',
      description:
        'Classify inbox items and route them into tasks or agent dispatches, ' +
        'with an audit trail — Cane intake behavior.',
    },
    {
      id: 'fleet-preview',
      title: 'Fleet preview',
      kind: 'surface',
      description:
        'A glanceable "what your fleet is doing" surface over fleet-activity, ' +
        'scoped to the user’s own team.',
    },
  ],
  requirements: {
    runtimes: ['claude-code-cli', 'claude-agent-sdk'],
    claude_only_graceful: true,
    min_providers: 1,
  },
  team_id: null,
};

/** All seeded role contracts. */
export const DEFAULT_ROLE_CONTRACTS: readonly RoleContract[] = [CHIEF_OF_STAFF_CONTRACT];

// Filesystem/account markers that must never appear in a GREENFIELD contract —
// it ships on a stranger's box. (The word "Chris" in prose is fine; these are
// the non-portable, account-leaking tokens.) Mirrors the clean-machine spike
// scanner posture: relocatable data only.
const GREENFIELD_FORBIDDEN_MARKERS = ['kilgore', 'Dropbox', 'com.kilgore'] as const;

function collectStrings(contract: RoleContract): string[] {
  const out: string[] = [contract.role_id, contract.title, contract.summary];
  for (const c of contract.composes) out.push(c.agent, c.behavior, c.slot);
  for (const cap of contract.capabilities) out.push(cap.id, cap.title, cap.kind, cap.description);
  out.push(...contract.requirements.runtimes);
  if (contract.team_id) out.push(contract.team_id);
  return out;
}

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validate a role contract. Pure; returns all errors rather than throwing so a
 * caller can surface them at once (catalog-edit validation posture).
 */
export function validateRoleContract(contract: RoleContract): RoleContractValidationResult {
  const errors: RoleContractValidationError[] = [];
  const err = (field: string, message: string) => errors.push({ field, message });

  if (contract.schema_version !== ROLE_CONTRACT_SCHEMA_VERSION) {
    err('schema_version', `expected ${ROLE_CONTRACT_SCHEMA_VERSION}, got ${contract.schema_version}`);
  }
  if (!contract.role_id || !KEBAB.test(contract.role_id)) {
    err('role_id', 'must be a non-empty kebab-case id');
  }
  if (!contract.title.trim()) err('title', 'required');
  if (!contract.summary.trim()) err('summary', 'required');

  // Composition must wire the manager engine plus intake + planning.
  const slots = new Set(contract.composes.map((c) => c.slot));
  for (const required of ['engine', 'intake', 'planning'] as const) {
    if (!slots.has(required)) err('composes', `missing required composition slot: ${required}`);
  }

  // Capabilities: at least one, unique kebab ids.
  if (contract.capabilities.length === 0) {
    err('capabilities', 'at least one capability is required');
  }
  const seen = new Set<string>();
  for (const cap of contract.capabilities) {
    if (!KEBAB.test(cap.id)) err('capabilities', `capability id "${cap.id}" must be kebab-case`);
    if (seen.has(cap.id)) err('capabilities', `duplicate capability id: ${cap.id}`);
    seen.add(cap.id);
  }

  // Requirements: a fleet can always run with at least one provider.
  if (contract.requirements.min_providers < 1) {
    err('requirements.min_providers', 'must be >= 1');
  }
  if (contract.requirements.runtimes.length === 0) {
    err('requirements.runtimes', 'at least one runtime is required');
  }

  // Greenfield contracts must carry no account-leaking markers.
  if (contract.account_scope === 'greenfield') {
    const haystack = collectStrings(contract).join('\n');
    for (const marker of GREENFIELD_FORBIDDEN_MARKERS) {
      if (haystack.includes(marker)) {
        err('account_scope', `greenfield contract leaks a non-portable marker: "${marker}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export type ResolveRoleContractResult =
  | { ok: true; contract: RoleContract }
  | { ok: false; reason: string };

/** Resolve a contract by role_id from a registry (defaults to the seed). */
export function resolveRoleContract(
  roleId: string,
  contracts: readonly RoleContract[] = DEFAULT_ROLE_CONTRACTS,
): ResolveRoleContractResult {
  const contract = contracts.find((c) => c.role_id === roleId);
  if (!contract) return { ok: false, reason: `no role contract for role_id "${roleId}"` };
  return { ok: true, contract };
}

export type InstantiateRoleContractResult =
  | { ok: true; contract: RoleContract }
  | { ok: false; errors: RoleContractValidationError[] };

/**
 * Bind a greenfield template to a fresh account's team. Validates the template
 * first (a malformed or account-leaking template must not reach a real team),
 * then returns a team-scoped clone. Does not mutate the template.
 */
export function instantiateRoleContract(
  template: RoleContract,
  teamId: string,
): InstantiateRoleContractResult {
  const result = validateRoleContract(template);
  if (!result.valid) return { ok: false, errors: result.errors };
  if (!teamId.trim()) {
    return { ok: false, errors: [{ field: 'team_id', message: 'a non-empty team id is required' }] };
  }
  return {
    ok: true,
    contract: {
      ...template,
      composes: template.composes.map((c) => ({ ...c })),
      capabilities: template.capabilities.map((c) => ({ ...c })),
      requirements: { ...template.requirements, runtimes: [...template.requirements.runtimes] },
      team_id: teamId,
    },
  };
}

/** Small registry over the seeded contracts (build-pools/registry.ts shape). */
export class RoleContractRegistry {
  private readonly byRole: Map<string, RoleContract>;

  constructor(contracts: readonly RoleContract[] = DEFAULT_ROLE_CONTRACTS) {
    this.byRole = new Map(contracts.map((c) => [c.role_id, c]));
  }

  static load(): RoleContractRegistry {
    return new RoleContractRegistry();
  }

  list(): RoleContract[] {
    return [...this.byRole.values()];
  }

  byId(roleId: string): RoleContract | null {
    return this.byRole.get(roleId) ?? null;
  }

  /** The keystone role, if one is registered. */
  keystone(): RoleContract | null {
    return this.list().find((c) => c.keystone) ?? null;
  }
}
