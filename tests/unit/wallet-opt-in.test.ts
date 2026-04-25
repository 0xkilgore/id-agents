// SPDX-License-Identifier: MIT
/**
 * wallet-opt-in: regression tests for the per-agent OWS wallet flag.
 *
 * Behavioural contract:
 *   - `wallet` is opt-in (default off).
 *   - `defaults.wallet` propagates to agents that don't set it.
 *   - Agent-level `wallet` overrides defaults in either direction.
 *   - `mergeDefaults` leaves the field undefined when neither side sets it,
 *     so the deploy/sync code can distinguish "explicitly off" from "never
 *     touched" (the onchain registration path uses this distinction).
 */

import { describe, expect, it } from 'vitest';

import type { AgentSpec, DeployConfig } from '../../src/config-parser.js';
import { mergeDefaults } from '../../src/config-parser.js';

describe('mergeDefaults — wallet opt-in propagation', () => {
  it('propagates defaults.wallet: false to agents that omit it', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { wallet: false };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.wallet).toBe(false);
  });

  it('propagates defaults.wallet: true to agents that omit it', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { wallet: true };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.wallet).toBe(true);
  });

  it('agent-level wallet: true overrides defaults.wallet: false', () => {
    const agent: AgentSpec = { name: 'coder', wallet: true };
    const defaults: DeployConfig['defaults'] = { wallet: false };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.wallet).toBe(true);
  });

  it('agent-level wallet: false overrides defaults.wallet: true', () => {
    const agent: AgentSpec = { name: 'coder', wallet: false };
    const defaults: DeployConfig['defaults'] = { wallet: true };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.wallet).toBe(false);
  });

  it('leaves wallet undefined when neither agent nor defaults set it', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { model: 'claude-sonnet-4-20250514' };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.wallet).toBeUndefined();
  });

  it('handles undefined defaults gracefully', () => {
    const agent: AgentSpec = { name: 'coder', wallet: false };

    const merged = mergeDefaults(agent, undefined);

    expect(merged.wallet).toBe(false);
  });
});
