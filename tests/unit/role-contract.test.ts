// SPDX-License-Identifier: MIT
/**
 * CoS role-contract tests (T-COS first task — substrate-api lane).
 *
 * Covers the greenfield Chief-of-Staff seed, validation (including the
 * greenfield no-account-leak rule), resolution, team-scoped instantiation, and
 * the registry. Behaviors (morning brief / inbox triage / fleet preview) are NOT
 * exercised here — they are later tasks; this proves the contract is well-formed.
 */

import { describe, it, expect } from 'vitest';
import {
  CHIEF_OF_STAFF_CONTRACT,
  DEFAULT_ROLE_CONTRACTS,
  validateRoleContract,
  resolveRoleContract,
  instantiateRoleContract,
  RoleContractRegistry,
  ROLE_CONTRACT_SCHEMA_VERSION,
  type RoleContract,
} from '../../src/role-contract/index.js';

function clone(c: RoleContract): RoleContract {
  return JSON.parse(JSON.stringify(c));
}

describe('Chief-of-Staff greenfield seed', () => {
  it('is a valid, greenfield, keystone, Claude-only-graceful template', () => {
    const c = CHIEF_OF_STAFF_CONTRACT;
    expect(c.role_id).toBe('chief-of-staff');
    expect(c.keystone).toBe(true);
    expect(c.account_scope).toBe('greenfield');
    expect(c.team_id).toBeNull(); // template, not yet bound to an account
    expect(c.schema_version).toBe(ROLE_CONTRACT_SCHEMA_VERSION);
    expect(c.requirements.claude_only_graceful).toBe(true);
    expect(c.requirements.min_providers).toBe(1); // works with Claude alone (R5)
    expect(validateRoleContract(c)).toEqual({ valid: true, errors: [] });
  });

  it('composes the manager engine + Cane intake + Maestra planning', () => {
    const bySlot = Object.fromEntries(CHIEF_OF_STAFF_CONTRACT.composes.map((x) => [x.slot, x]));
    expect(bySlot.engine.agent).toBe('manager');
    expect(bySlot.intake.agent).toBe('cane');
    expect(bySlot.planning.agent).toBe('maestra');
  });

  it('exposes the three starter-fleet capabilities', () => {
    const ids = CHIEF_OF_STAFF_CONTRACT.capabilities.map((c) => c.id).sort();
    expect(ids).toEqual(['fleet-preview', 'inbox-triage', 'morning-brief']);
  });
});

describe('validateRoleContract', () => {
  it('rejects a wrong schema version', () => {
    const c = clone(CHIEF_OF_STAFF_CONTRACT);
    c.schema_version = 99;
    const r = validateRoleContract(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'schema_version')).toBe(true);
  });

  it('requires the engine, intake, and planning composition slots', () => {
    const c = clone(CHIEF_OF_STAFF_CONTRACT);
    c.composes = c.composes.filter((x) => x.slot !== 'planning');
    const r = validateRoleContract(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'composes' && /planning/.test(e.message))).toBe(true);
  });

  it('rejects duplicate or non-kebab capability ids', () => {
    const dup = clone(CHIEF_OF_STAFF_CONTRACT);
    dup.capabilities.push({ ...dup.capabilities[0] });
    expect(validateRoleContract(dup).errors.some((e) => /duplicate/.test(e.message))).toBe(true);

    const bad = clone(CHIEF_OF_STAFF_CONTRACT);
    bad.capabilities[0].id = 'Not_Kebab';
    expect(validateRoleContract(bad).errors.some((e) => /kebab/.test(e.message))).toBe(true);
  });

  it('rejects min_providers < 1 and empty runtimes', () => {
    const c = clone(CHIEF_OF_STAFF_CONTRACT);
    c.requirements.min_providers = 0;
    c.requirements.runtimes = [];
    const r = validateRoleContract(c);
    expect(r.errors.some((e) => e.field === 'requirements.min_providers')).toBe(true);
    expect(r.errors.some((e) => e.field === 'requirements.runtimes')).toBe(true);
  });

  it('flags a greenfield contract that leaks a non-portable account marker', () => {
    const c = clone(CHIEF_OF_STAFF_CONTRACT);
    c.summary = c.summary + ' — see /Users/kilgore/Dropbox/Code for defaults';
    const r = validateRoleContract(c);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'account_scope')).toBe(true);
  });

  it('does NOT apply the account-leak rule to a chris-migration contract', () => {
    const c = clone(CHIEF_OF_STAFF_CONTRACT);
    c.account_scope = 'chris-migration';
    c.summary = c.summary + ' migrating com.kilgore launchd CoS';
    // Still valid: the leak rule is greenfield-only.
    expect(validateRoleContract(c).errors.some((e) => e.field === 'account_scope')).toBe(false);
  });
});

describe('resolveRoleContract', () => {
  it('resolves the seeded keystone role', () => {
    const r = resolveRoleContract('chief-of-staff');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.contract.role_id).toBe('chief-of-staff');
  });

  it('returns a typed miss for an unknown role', () => {
    const r = resolveRoleContract('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/nope/);
  });
});

describe('instantiateRoleContract (greenfield → fresh account)', () => {
  it('stamps team_id without mutating the template', () => {
    const r = instantiateRoleContract(CHIEF_OF_STAFF_CONTRACT, 'team-fresh-001');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.contract.team_id).toBe('team-fresh-001');
      expect(r.contract.role_id).toBe('chief-of-staff');
    }
    // template untouched
    expect(CHIEF_OF_STAFF_CONTRACT.team_id).toBeNull();
  });

  it('deep-clones nested arrays (instance edits do not leak to the template)', () => {
    const r = instantiateRoleContract(CHIEF_OF_STAFF_CONTRACT, 'team-x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.contract.capabilities[0].title = 'mutated';
      r.contract.requirements.runtimes.push('rogue-runtime');
      expect(CHIEF_OF_STAFF_CONTRACT.capabilities[0].title).not.toBe('mutated');
      expect(CHIEF_OF_STAFF_CONTRACT.requirements.runtimes).not.toContain('rogue-runtime');
    }
  });

  it('refuses an empty team id', () => {
    const r = instantiateRoleContract(CHIEF_OF_STAFF_CONTRACT, '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === 'team_id')).toBe(true);
  });

  it('refuses to bind an invalid template to a real team', () => {
    const broken = clone(CHIEF_OF_STAFF_CONTRACT);
    broken.role_id = '';
    const r = instantiateRoleContract(broken, 'team-y');
    expect(r.ok).toBe(false);
  });
});

describe('RoleContractRegistry', () => {
  it('lists, looks up by id, and finds the keystone', () => {
    const reg = RoleContractRegistry.load();
    expect(reg.list().length).toBe(DEFAULT_ROLE_CONTRACTS.length);
    expect(reg.byId('chief-of-staff')?.role_id).toBe('chief-of-staff');
    expect(reg.byId('missing')).toBeNull();
    expect(reg.keystone()?.role_id).toBe('chief-of-staff');
  });
});
