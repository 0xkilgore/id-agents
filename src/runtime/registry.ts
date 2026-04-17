// SPDX-License-Identifier: MIT
/**
 * Runtime registry.
 *
 * Central source of truth for runtime defaults, labels, auth mode, and
 * capabilities. Existing harness identifiers remain intact so this layer can
 * be adopted incrementally without changing external config.
 */

import type { HarnessType } from '../harness/types.js';
import type { RuntimeProfile, RuntimeId, RuntimeValidationIssue } from './types.js';
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const DEFAULT_RUNTIME: RuntimeId = 'claude-agent-sdk';

const PROFILES: Record<RuntimeId, RuntimeProfile> = {
  'claude-agent-sdk': {
    id: 'claude-agent-sdk',
    canonicalId: 'claude-agent-sdk',
    displayName: 'Claude',
    providerName: 'Claude Agent SDK',
    defaultModel: 'claude-haiku-4-5-20251001',
    sessionPolicy: 'persistent',
    auth: {
      mode: 'api-key',
      provider: 'Anthropic',
      requiredEnv: ['ANTHROPIC_API_KEY'],
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-cli': {
    id: 'claude-code-cli',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  'claude-code-local': {
    id: 'claude-code-local',
    canonicalId: 'claude-code-cli',
    displayName: 'Claude Code',
    providerName: 'Claude Code CLI',
    defaultModel: 'claude-opus-4-20250514',
    sessionPolicy: 'persistent',
    auth: {
      mode: 'cli-login',
      provider: 'Anthropic',
    },
    capabilities: {
      supportsResume: true,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
  codex: {
    id: 'codex',
    canonicalId: 'codex',
    displayName: 'Codex',
    providerName: 'Codex CLI',
    defaultModel: 'gpt-5.4',
    sessionPolicy: 'fresh-per-query',
    auth: {
      mode: 'cli-login',
      provider: 'OpenAI',
    },
    capabilities: {
      supportsResume: false,
      supportsPlugins: true,
      supportsAllowedTools: true,
    },
  },
};

export function getDefaultRuntime(): RuntimeId {
  return DEFAULT_RUNTIME;
}

export function getRuntimeProfile(runtime: HarnessType | string | undefined): RuntimeProfile {
  const id = isRuntimeId(runtime) ? runtime : DEFAULT_RUNTIME;
  return PROFILES[id];
}

export function resolveRuntime(runtime: HarnessType | string | undefined): RuntimeId {
  return getRuntimeProfile(runtime).id;
}

export function getRuntimeDisplayName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).displayName;
}

export function getRuntimeProviderName(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).providerName;
}

export function getRuntimeAuthProvider(runtime: HarnessType | string | undefined): string {
  return getRuntimeProfile(runtime).auth.provider;
}

export function getDefaultModelForRuntime(
  runtime: HarnessType | string | undefined,
  configuredDefault?: string
): string {
  return configuredDefault || getRuntimeProfile(runtime).defaultModel;
}

export function usesCliLogin(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).auth.mode === 'cli-login';
}

export function supportsSessionResume(runtime: HarnessType | string | undefined): boolean {
  return getRuntimeProfile(runtime).capabilities.supportsResume;
}

/**
 * Runtime-specific filesystem paths for agent templates, skills, and personality files.
 *
 * Claude runtimes use .claude/ conventions (CLAUDE.md, .claude/skills/, .claude/agents/).
 * Codex uses .agents/ conventions (AGENTS.md at project root, .agents/skills/, .agents/{name}/).
 */
export interface RuntimePaths {
  /** Directory containing agent templates, relative to workingDir (e.g. '.claude/agents' or '.agents') */
  templateDir: string;
  /** Where overlay contents are copied to, relative to workingDir (e.g. '.claude' or '.agents') */
  overlayTarget: string;
  /** Directory for deployed skills, relative to workingDir (e.g. '.claude/skills' or '.agents/skills') */
  skillsDir: string;
  /** Personality/instructions file path, relative to workingDir (e.g. '.claude/CLAUDE.md' or 'AGENTS.md') */
  personalityFile: string;
  /** Filename for the personality file inside a template directory (e.g. 'CLAUDE.md' or 'AGENTS.md') */
  personalityFilename: string;
}

export function getRuntimePaths(runtime: HarnessType | string | undefined): RuntimePaths {
  const resolved = resolveRuntime(runtime);
  if (resolved === 'codex') {
    return {
      templateDir: '.agents',
      overlayTarget: '.agents',
      skillsDir: '.agents/skills',
      personalityFile: 'AGENTS.md',
      personalityFilename: 'AGENTS.md',
    };
  }
  // All Claude runtimes: claude-agent-sdk, claude-code-cli, claude-code-local
  return {
    templateDir: '.claude/agents',
    overlayTarget: '.claude',
    skillsDir: '.claude/skills',
    personalityFile: '.claude/CLAUDE.md',
    personalityFilename: 'CLAUDE.md',
  };
}

export function getAvailableRuntimes(): RuntimeId[] {
  return Object.keys(PROFILES) as RuntimeId[];
}

export function isRuntimeId(runtime: string | undefined): runtime is RuntimeId {
  return !!runtime && runtime in PROFILES;
}

function commandOnPath(bin: string): boolean {
  try {
    const r = spawnSync('command', ['-v', bin], { shell: '/bin/sh', stdio: 'ignore' });
    return r.status === 0;
  } catch {
    return false;
  }
}

function claudeCodeAuthExists(): boolean {
  if (process.env.ANTHROPIC_API_KEY) return true;
  if (process.platform === 'darwin') {
    try {
      const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials'], { stdio: 'ignore' });
      if (r.status === 0) return true;
    } catch {}
  }
  const home = process.env.HOME;
  if (home && fs.existsSync(path.join(home, '.claude', '.credentials.json'))) return true;
  return false;
}

function codexAuthExists(): boolean {
  if (process.env.OPENAI_API_KEY) return true;
  const home = process.env.HOME;
  if (home && fs.existsSync(path.join(home, '.codex', 'auth.json'))) return true;
  return false;
}

/**
 * Returns true when the runtime's CLI is on PATH AND credentials are present.
 *
 * Used by the deploy path to strip agents whose runtime the current machine
 * can't spawn. Runtimes without a PATH+auth contract (e.g. the SDK, which
 * uses an env var only) fall back to checking the env var alone.
 *
 * Undeclared runtimes default to ready so we don't silently drop agents.
 */
export function isRuntimeReady(runtime: HarnessType | string | undefined): boolean {
  const id = resolveRuntime(runtime);
  switch (id) {
    case 'claude-code-cli':
    case 'claude-code-local':
      return commandOnPath('claude') && claudeCodeAuthExists();
    case 'codex':
      return commandOnPath('codex') && codexAuthExists();
    case 'claude-agent-sdk':
      return !!process.env.ANTHROPIC_API_KEY;
    default:
      return true;
  }
}

function classifyModelFamily(model: string | undefined): 'claude' | 'openai' | 'unknown' {
  if (!model) return 'unknown';
  const normalized = model.trim().toLowerCase();

  if (['haiku', 'sonnet', 'opus'].includes(normalized) || normalized.startsWith('claude')) {
    return 'claude';
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('o1') ||
    normalized.startsWith('o3') ||
    normalized.startsWith('o4')
  ) {
    return 'openai';
  }

  return 'unknown';
}

export function validateRuntimeModelCompatibility(
  runtime: HarnessType | string | undefined,
  model: string | undefined
): RuntimeValidationIssue[] {
  if (!model) return [];

  const resolvedRuntime = resolveRuntime(runtime);
  const family = classifyModelFamily(model);
  const issues: RuntimeValidationIssue[] = [];

  if (resolvedRuntime === 'codex' && family === 'claude') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with Claude model "${model}"`,
    });
  }

  if (resolvedRuntime !== 'codex' && family === 'openai') {
    issues.push({
      code: 'runtime_model_mismatch',
      message: `runtime "${resolvedRuntime}" is incompatible with OpenAI model "${model}"`,
    });
  }

  return issues;
}

function checkCommandAvailable(command: string): RuntimeValidationIssue[] {
  try {
    execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return [];
  } catch {
    return [{
      code: 'runtime_binary_missing',
      message: `required runtime command "${command}" is not installed or not on PATH`,
    }];
  }
}

/**
 * Map a preflight issue code to a one-line setup hint shown at spawn time.
 * Returns null for codes without a curated hint; callers should fall back to issue.message.
 */
export function runtimeIssueHint(code: string): string | null {
  switch (code) {
    case 'anthropic_api_key_missing':
      return 'Missing ANTHROPIC_API_KEY. Add `export ANTHROPIC_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env. Get a key: https://console.anthropic.com/settings/keys';
    case 'codex_auth_missing':
      return 'Missing OPENAI_API_KEY. Add `export OPENAI_API_KEY=sk-...` to ~/.zshrc (or ~/.bashrc) or to a project .env, or run `codex login`. Docs: https://github.com/openai/codex';
    default:
      return null;
  }
}

export function validateRuntimePreflight(
  runtime: HarnessType | string | undefined,
  model?: string
): RuntimeValidationIssue[] {
  const resolvedRuntime = resolveRuntime(runtime);
  const issues: RuntimeValidationIssue[] = [
    ...validateRuntimeModelCompatibility(resolvedRuntime, model),
  ];

  if (resolvedRuntime === 'claude-agent-sdk') {
    if (!process.env.ANTHROPIC_API_KEY) {
      issues.push({
        code: 'anthropic_api_key_missing',
        message: 'runtime "claude-agent-sdk" requires ANTHROPIC_API_KEY',
      });
    }
    return issues;
  }

  if (resolvedRuntime === 'claude-code-cli' || resolvedRuntime === 'claude-code-local') {
    return [...issues, ...checkCommandAvailable('claude')];
  }

  if (resolvedRuntime === 'codex') {
    issues.push(...checkCommandAvailable('codex'));
    if (!process.env.OPENAI_API_KEY) {
      try {
        const result = spawnSync('codex', ['login', 'status'], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        });
        const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        if (result.status !== 0 && !/logged in/i.test(combinedOutput)) {
          issues.push({
            code: 'codex_auth_missing',
            message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
          });
        }
      } catch {
        issues.push({
          code: 'codex_auth_missing',
          message: 'runtime "codex" requires OPENAI_API_KEY or an active `codex login` session',
        });
      }
    }
  }

  return issues;
}
