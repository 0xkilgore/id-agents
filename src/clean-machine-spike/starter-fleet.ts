// SPDX-License-Identifier: MIT
//
// Clean-machine spike — synthetic stranger starter-fleet smoke.
//
// This is the executable acceptance bridge for R2 + R5: resolve the same
// app-local boot inputs a packaged desktop sidecar supplies, materialize the
// minimal starter fleet, and prove that only Claude auth is required.

import path from 'node:path';
import type { DeployConfig } from '../config-parser.js';
import { resolveRuntime } from '../runtime/registry.js';
import {
  resolveBundleBootConfig,
  scanForChrisPaths,
  type BundleBootConfig,
  type ChrisPathFinding,
} from './boot-config.js';
import { probeByoClaudeCredential, type ByoClaudeProbeResult } from './byo-claude.js';
import { assessClaudeOnlyGraceful, type ClaudeOnlyGracefulResult } from './graceful.js';

export interface StarterFleetSmokeResult {
  ok: boolean;
  boot: BundleBootConfig;
  cockpit: {
    ready: boolean;
    state: 'ready-empty' | 'blocked';
    managerUrl: string;
    opsUrl: string;
  };
  fleet: DeployConfig;
  agents: Array<{ name: string; runtime: string; model: string }>;
  credential: ByoClaudeProbeResult;
  graceful: ClaudeOnlyGracefulResult;
  chrisPathFindings: ChrisPathFinding[];
  providerAssumptions: string[];
}

export function syntheticStrangerClaudeOnlyEnv(
  profileHome: string,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const appSupport = path.join(profileHome, 'Library', 'Application Support', 'Kapelle');
  return {
    HOME: profileHome,
    ID_AGENTS_HOME: path.join(appSupport, 'id-agents-home'),
    AGENT_MANAGER_WORKDIR: path.join(appSupport, 'workspace'),
    SQLITE_PATH: path.join(appSupport, 'id-agents.db'),
    IDAGENTS_REPO_REGISTRY: path.join(appSupport, 'repo-registry.json'),
    AGENT_MANAGER_PORT: '0',
    ANTHROPIC_API_KEY: 'synthetic-claude-only-key',
    OPENAI_API_KEY: '',
    CURSOR_API_KEY: '',
    OPENROUTER_API_KEY: '',
    ...overrides,
  };
}

export function buildClaudeOnlyStarterFleetConfig(): DeployConfig {
  return {
    version: '1',
    team: 'default',
    defaults: {
      local: true,
      runtime: 'claude-code-cli',
      model: 'claude-sonnet-4-6',
      skills: ['identity', 'inter-agent', 'catalog'],
    },
    agents: [
      {
        name: 'coder',
        description: 'Writes and reviews code',
      },
      {
        name: 'researcher',
        description: 'Research, analysis, and documentation',
        model: 'claude-sonnet-4-6',
      },
    ],
  };
}

export function evaluateSyntheticStrangerStarterFleet(
  env: NodeJS.ProcessEnv,
): StarterFleetSmokeResult {
  const boot = resolveBundleBootConfig(env);
  const fleet = buildClaudeOnlyStarterFleetConfig();
  const chrisPathFindings = scanForChrisPaths(boot, env);
  const credential = probeByoClaudeCredential(env);
  const graceful = assessClaudeOnlyGraceful('claude-agent-sdk');
  const providerAssumptions = findNonClaudeProviderAssumptions(fleet);
  const managerUrl = boot.managerPort === 0
    ? 'http://127.0.0.1:<dynamic>'
    : `http://127.0.0.1:${boot.managerPort}`;

  const agents = fleet.agents.map((agent) => {
    const runtime = resolveRuntime(agent.runtime ?? fleet.defaults?.runtime);
    return {
      name: agent.name,
      runtime,
      model: agent.model ?? fleet.defaults?.model ?? '',
    };
  });

  const ok =
    chrisPathFindings.length === 0
    && credential.ok
    && graceful.graceful
    && providerAssumptions.length === 0;

  return {
    ok,
    boot,
    cockpit: {
      ready: ok,
      state: ok ? 'ready-empty' : 'blocked',
      managerUrl,
      opsUrl: `${managerUrl}/ops`,
    },
    fleet,
    agents,
    credential,
    graceful,
    chrisPathFindings,
    providerAssumptions,
  };
}

function findNonClaudeProviderAssumptions(config: DeployConfig): string[] {
  const findings: string[] = [];
  const defaultRuntime = resolveRuntime(config.defaults?.runtime);
  if (!defaultRuntime.startsWith('claude-')) {
    findings.push(`defaults.runtime=${defaultRuntime}`);
  }
  for (const agent of config.agents) {
    const runtime = resolveRuntime(agent.runtime ?? config.defaults?.runtime);
    if (!runtime.startsWith('claude-')) {
      findings.push(`agents.${agent.name}.runtime=${runtime}`);
    }
    const model = agent.model ?? config.defaults?.model ?? '';
    if (/\b(?:gpt|codex|cursor|openrouter)\b/i.test(model)) {
      findings.push(`agents.${agent.name}.model=${model}`);
    }
  }
  return findings;
}
