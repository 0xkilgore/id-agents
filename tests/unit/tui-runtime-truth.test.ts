import { describe, expect, it } from 'vitest';

import type { Agent } from '../../src/tui/api/types.js';
import { agentRuntimeTruth } from '../../src/tui/util/runtime-truth.js';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent_1',
    name: 'gideon',
    port: 4277,
    status: 'running',
    health: 'online',
    model: 'claude-sonnet-5',
    runtime: 'claude-code-cli',
    createdAt: 1,
    metadata: {},
    ...overrides,
  };
}

describe('agentRuntimeTruth', () => {
  it('prefers live runtimeUsageTruth over durable/display fields', () => {
    const view = agentRuntimeTruth(agent({
      runtime: 'claude-code-cli',
      model: 'claude-sonnet-5',
      metadata: {
        runtime: 'claude-code-cli',
        runtimeUsageTruth: {
          actualRuntime: 'codex',
          actualModel: 'gpt-5.5',
          catalogDesiredModel: 'claude-sonnet-5',
          catalogModelStale: true,
          usageTelemetry: {
            provider: 'openai',
            source: 'codex_cli',
            authoritativeFields: ['runtime', 'model'],
          },
        },
      },
    }));

    expect(view).toMatchObject({
      runtime: 'codex',
      model: 'gpt-5.5',
      providerLane: 'openai',
      source: 'codex_cli',
      staleDesiredModel: 'claude-sonnet-5',
    });
    expect(view.why).toContain('fallback/different desired model: claude-sonnet-5');
  });

  it('surfaces exhaustion state as the reason for the current lane', () => {
    const view = agentRuntimeTruth(agent({
      status: 'exhausted',
      metadata: {
        exhausted_reason: 'usage_limit',
        runtimeUsageTruth: {
          actualRuntime: 'claude-code-cli',
          actualModel: 'claude-sonnet-5',
          catalogModelStale: false,
          usageTelemetry: {
            provider: 'anthropic',
            source: 'claude_cli_external',
            authoritativeFields: ['runtime', 'model'],
          },
        },
      },
    }));

    expect(view.providerLane).toBe('anthropic');
    expect(view.why).toBe('exhausted: usage_limit');
  });
});
