// SPDX-License-Identifier: MIT
/**
 * Harness Abstraction Types
 *
 * Defines the interface for agent execution harnesses.
 * All harnesses produce the same message format for REST-AP compatibility.
 */

export type HarnessType = 'claude-agent-sdk' | 'claude-code-cli' | 'claude-code-local' | 'codex' | 'cursor-cli' | 'public-agent-remote';

export interface PluginConfig {
  name: string;
  path: string;
}

export interface HarnessOptions {
  model?: string;
  workingDirectory?: string;
  plugins?: PluginConfig[];
  allowedTools?: string[];
  resume?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Unified message format from all harnesses.
 * Maps to REST-AP response format.
 */
export interface HarnessMessage {
  type: 'system' | 'tool_use' | 'result' | 'error' | 'progress' | 'thinking';
  subtype?: string;
  content?: string;
  result?: string;
  session_id?: string;
  tool_name?: string;
  parent_tool_use_id?: string;
  [key: string]: any;
}

/**
 * Agent harness interface.
 * Implementations wrap different AI coding CLIs (Claude Code, Open Code, etc.)
 */
export interface AgentHarness {
  /** Harness identifier */
  readonly type: HarnessType;

  /**
   * Execute a prompt and yield messages as they arrive.
   * @param prompt The task/prompt to execute
   * @param options Harness configuration options
   * @yields HarnessMessage objects as execution progresses
   */
  run(prompt: string, options: HarnessOptions): AsyncGenerator<HarnessMessage>;

  /**
   * Cancel the currently running query.
   * Kills the underlying process if one is running.
   * @returns true if a process was cancelled, false if nothing was running
   */
  cancel?(): boolean;
}
