// SPDX-License-Identifier: MIT
/**
 * ID Agents - Multi-Agent Framework
 *
 * A framework for running multiple Claude agents locally
 * with REST-AP interfaces for communication.
 *
 * @version 0.1.8-beta
 * @license MIT
 */

// Main classes for programmatic use
export { IdAgentsCLI } from './id-agents-cli.js';
export { ClaudeAgentServer } from './claude-agent-server.js';
export { runClaudeAgent, CLAUDE_MODELS } from './claude-agent.js';

// Core types and interfaces
export type {
  OperationResult,
  TeamConfig,
  TeamInfo,
  CreateTeamOptions,
  CreateTeamResult,
  AgentType,
  AgentStatus,
  AgentRegistry,
  AgentMetadata,
  AgentInfo,
  SpawnAgentOptions,
  AgentStatusReport,
  NewsItem,
  SendMessageOptions,
  SendMessageResult,
  PollNewsOptions,
  RegistryConfig,
  RegisterOnchainResult,
  FileInfo,
  DeployConfig,
  DeployResult,
  ServiceContext,
} from './core/types.js';

// Inter-agent communication skill
export {
  INTER_AGENT_SKILL,
  INTER_AGENT_SKILL_LIGHT,
  withInterAgentSkill,
  AGENT_COMM_SCRIPTS,
  generateAgentHelperScript,
} from './inter-agent-skill.js';

// Config parser for YAML configurations
export {
  parseConfig,
  validateConfig,
  processConfig,
  type DeployConfig as YAMLDeployConfig,
  type AgentSpec,
  type PluginConfig,
} from './config-parser.js';
