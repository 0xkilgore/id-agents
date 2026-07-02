// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';

import {
  classifyCommandError,
  classifyModelFamily,
  getDefaultModelForRuntime,
  getDefaultRuntime,
  getRuntimeDisplayName,
  getRuntimeProfile,
  getRuntimeProviderName,
  resolveRuntime,
  supportsSessionResume,
  usesCliLogin,
  validateRuntimeModelCompatibility,
} from '../../src/runtime/registry.js';

describe('runtime registry', () => {
  it('returns the shared default runtime', () => {
    expect(getDefaultRuntime()).toBe('claude-agent-sdk');
  });

  it('resolves unknown runtimes to the shared default', () => {
    expect(resolveRuntime(undefined)).toBe('claude-agent-sdk');
    expect(resolveRuntime('not-a-runtime')).toBe('claude-agent-sdk');
  });

  it('maps codex-cli to the codex runtime profile', () => {
    expect(resolveRuntime('codex-cli')).toBe('codex');
    expect(getRuntimeProfile('codex-cli').canonicalId).toBe('codex');
    expect(getRuntimeDisplayName('codex-cli')).toBe('Codex');
  });

  it('maps claude-code-local to the Claude Code profile while preserving id', () => {
    const profile = getRuntimeProfile('claude-code-local');
    expect(profile.id).toBe('claude-code-local');
    expect(profile.canonicalId).toBe('claude-code-cli');
    expect(profile.displayName).toBe('Claude Code');
  });

  it('returns runtime display and provider labels', () => {
    expect(getRuntimeDisplayName('codex')).toBe('Codex');
    expect(getRuntimeProviderName('codex')).toBe('Codex CLI');
    expect(getRuntimeDisplayName('claude-agent-sdk')).toBe('Claude');
  });

  it('returns runtime-specific default models', () => {
    expect(getDefaultModelForRuntime('codex')).toBe('gpt-5.4');
    expect(getDefaultModelForRuntime('claude-agent-sdk')).toBe('claude-haiku-4-5-20251001');
  });

  it('honors explicit configured defaults when provided', () => {
    expect(getDefaultModelForRuntime('codex', 'gpt-5.5-preview')).toBe('gpt-5.5-preview');
  });

  it('tracks auth and session behavior by runtime', () => {
    expect(usesCliLogin('codex')).toBe(true);
    expect(usesCliLogin('claude-code-cli')).toBe(true);
    expect(usesCliLogin('claude-agent-sdk')).toBe(false);

    expect(supportsSessionResume('codex')).toBe(false);
    expect(supportsSessionResume('claude-code-cli')).toBe(true);
  });

  it('flags incompatible runtime/model combinations', () => {
    expect(validateRuntimeModelCompatibility('codex', 'claude-haiku-4-5-20251001')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "codex" is incompatible with Claude model "claude-haiku-4-5-20251001"',
      },
    ]);

    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'gpt-5.4')).toEqual([
      {
        code: 'runtime_model_mismatch',
        message: 'runtime "claude-agent-sdk" is incompatible with OpenAI model "gpt-5.4"',
      },
    ]);
  });

  it('accepts models from the matching provider family', () => {
    expect(validateRuntimeModelCompatibility('codex', 'gpt-5.4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-sonnet-4-20250514')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-agent-sdk', 'haiku')).toEqual([]);
  });

  it('exposes the cursor-cli runtime profile', () => {
    const profile = getRuntimeProfile('cursor-cli');
    expect(profile.id).toBe('cursor-cli');
    expect(profile.canonicalId).toBe('cursor-cli');
    expect(profile.displayName).toBe('Cursor');
    expect(profile.auth.mode).toBe('cli-login');
    expect(profile.capabilities.supportsResume).toBe(true);
    expect(getDefaultModelForRuntime('cursor-cli')).toBe('sonnet-4');
  });

  it('accepts both OpenAI and Claude model families for cursor-cli', () => {
    expect(validateRuntimeModelCompatibility('cursor-cli', 'gpt-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'sonnet-4')).toEqual([]);
    expect(validateRuntimeModelCompatibility('cursor-cli', 'claude-opus-4-20250514')).toEqual([]);
  });
});

describe('classifyModelFamily (new Anthropic models)', () => {
  it('classifies claude-fable-5 and claude-sonnet-5 as the claude family', () => {
    expect(classifyModelFamily('claude-fable-5')).toBe('claude');
    expect(classifyModelFamily('claude-sonnet-5')).toBe('claude');
  });
  it('still classifies existing families correctly', () => {
    expect(classifyModelFamily('claude-opus-4-8')).toBe('claude');
    expect(classifyModelFamily('gpt-5.5')).toBe('openai');
    expect(classifyModelFamily(undefined)).toBe('unknown');
  });
});

describe('claude-code-cli accepts the new Anthropic models (runtime compatibility)', () => {
  it('raises no compatibility issue for claude-fable-5 / claude-sonnet-5 on the Claude CLI', () => {
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-fable-5')).toEqual([]);
    expect(validateRuntimeModelCompatibility('claude-code-cli', 'claude-sonnet-5')).toEqual([]);
  });
});

describe('classifyCommandError (C4 — binary_missing vs unavailable)', () => {
  it('labels ENOENT as runtime_binary_missing (genuinely not installed)', () => {
    const issue = classifyCommandError('codex', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    expect(issue.code).toBe('runtime_binary_missing');
  });

  it('labels a revoked-cert kill (SIGKILL/137) as runtime_unavailable, NOT missing', () => {
    const issue = classifyCommandError('codex', Object.assign(new Error('killed'), { signal: 'SIGKILL', status: 137 }));
    expect(issue.code).toBe('runtime_unavailable');
    expect(issue.message).toMatch(/installed but failed to run/);
  });

  it('labels a timeout as runtime_unavailable (present but hangs)', () => {
    const issue = classifyCommandError('codex', Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    expect(issue.code).toBe('runtime_unavailable');
  });

  it('labels a non-zero exit as runtime_unavailable (present but won\'t run)', () => {
    const issue = classifyCommandError('codex', Object.assign(new Error('exit 1'), { status: 1 }));
    expect(issue.code).toBe('runtime_unavailable');
  });
});
