// SPDX-License-Identifier: MIT
/**
 * Harness Module
 *
 * Factory for creating agent execution harnesses.
 * - claude-code: Uses Claude Agent SDK
 * - claude-code-cli: Uses Claude Code CLI (for local agents with user auth)
 */

import { HarnessType, AgentHarness } from './types.js';
import { ClaudeAgentSdkHarness } from './claude-agent-sdk.js';
import { ClaudeCodeCliHarness } from './claude-code-cli.js';
import { CodexHarness } from './codex.js';

// Export all types
export * from './types.js';
export { ClaudeAgentSdkHarness } from './claude-agent-sdk.js';
export { ClaudeCodeCliHarness } from './claude-code-cli.js';
export { CodexHarness } from './codex.js';

/**
 * Create a harness instance by type.
 *
 * @param type The harness type
 * @returns An AgentHarness instance
 * @throws Error if the harness type is unknown
 */
export function createHarness(type: HarnessType = 'claude-agent-sdk'): AgentHarness {
  switch (type) {
    case 'claude-agent-sdk':
      return new ClaudeAgentSdkHarness();
    case 'claude-code-cli':
    case 'claude-code-local':  // Local agents use the CLI harness
      return new ClaudeCodeCliHarness();
    case 'codex':
      return new CodexHarness();
    default:
      throw new Error(`Unknown harness type: ${type}. Valid types: claude-agent-sdk, claude-code-cli, codex`);
  }
}

/**
 * Get all available harness types.
 */
export function getAvailableHarnesses(): HarnessType[] {
  return ['claude-agent-sdk', 'claude-code-cli', 'claude-code-local', 'codex'];
}

/**
 * Check if a harness type is valid.
 */
export function isValidHarnessType(type: string): type is HarnessType {
  return getAvailableHarnesses().includes(type as HarnessType);
}
