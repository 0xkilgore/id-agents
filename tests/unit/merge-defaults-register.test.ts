// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import type { AgentSpec, DeployConfig } from '../../src/config-parser.js';
import { mergeDefaults } from '../../src/config-parser.js';

describe('mergeDefaults register propagation', () => {
  it('propagates defaults.register: false when agent has no register key', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { register: false };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.register).toBe(false);
  });

  it('agent-level register: true overrides defaults.register: false', () => {
    const agent: AgentSpec = { name: 'coder', register: true };
    const defaults: DeployConfig['defaults'] = { register: false };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.register).toBe(true);
  });

  it('agent-level register: false overrides defaults.register: true', () => {
    const agent: AgentSpec = { name: 'coder', register: false };
    const defaults: DeployConfig['defaults'] = { register: true };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.register).toBe(false);
  });

  it('leaves register undefined when neither agent nor defaults set it', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { model: 'claude-sonnet-4-20250514' };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.register).toBeUndefined();
  });

  it('propagates defaults.register: true when agent has no register key', () => {
    const agent: AgentSpec = { name: 'coder' };
    const defaults: DeployConfig['defaults'] = { register: true };

    const merged = mergeDefaults(agent, defaults);

    expect(merged.register).toBe(true);
  });

  it('handles undefined defaults gracefully', () => {
    const agent: AgentSpec = { name: 'coder', register: false };

    const merged = mergeDefaults(agent, undefined);

    expect(merged.register).toBe(false);
  });
});
