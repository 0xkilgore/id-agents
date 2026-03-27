// SPDX-License-Identifier: MIT
/**
 * YAML Config Parser for ID Agent Deployments
 *
 * Handles parsing and validation of agent deployment configuration files.
 * Supports parameterized configs with ${param} substitution.
 */

import yaml from 'js-yaml';
import fs from 'fs';
import path from 'path';
import { HarnessType, isValidHarnessType, getAvailableHarnesses } from './harness/index.js';

export interface PluginConfig {
  name: string;
  path: string;
}

export interface ResourceConfig {
  memory?: string;
  cpus?: number;
  env?: Record<string, string>;
  volumes?: Array<{
    host: string;
    target: string;
    readonly?: boolean;
  }>;
}

export interface AgentSpec {
  name: string;
  type?: 'claude' | 'automator';      // Agent type: 'claude' (default) or 'automator' (manager's brain, hidden)
  runtime?: HarnessType;              // 'claude-agent-sdk' or 'claude-code-cli', defaults to 'claude-agent-sdk'
  description?: string;
  model?: string;
  systemPrompt?: string;              // Custom system prompt for the agent
  claudeMd?: string;                  // Content to prepend to agent's .claude/CLAUDE.md file
  claudeMdFile?: string;              // Path to file containing claudeMd content (relative to config)
  plugins?: PluginConfig[];           // Skill plugins
  skills?: string[];                  // Skills to deploy (names match skills/<name>/SKILL.md)
  allowedTools?: string[];
  resources?: ResourceConfig;
  register?: boolean;                 // Auto-register onchain after deploy
  local?: boolean;                    // Run locally using user's Claude Code auth
  port?: number;                      // Port for local agents (auto-allocated if not specified)
  workingDirectory?: string;          // Working directory for local agents
  verbose?: boolean | string;         // Enable detailed logging (show tool calls, progress)
  talkTimeout?: number;               // Default timeout for /talk-to in ms (default: 120000, max: 600000)
  heartbeatFile?: string;             // Path to heartbeat yaml config (relative to config file)
  heartbeat?: HeartbeatConfig;        // Resolved heartbeat config (set by processConfig)
  domain?: string;                    // ENS domain name (e.g., "x.agent-15.sep.xid.eth")
  tokenId?: string;                   // Namehash of the ENS domain (bytes32)
  address?: string;                   // Ethereum address (links to .env.<name>.<address> file)
}

export interface OnchainConfig {
  registryAddress?: string;           // ERC-6551 registry address
  registrarAddress?: string;          // Registrar contract for minting
  chainId?: number;                   // Chain ID (default: 11155111 for Sepolia)
  register?: boolean;                 // Auto-register all agents by default
}

/**
 * Parameter definition for config templates
 */
export interface ConfigParameter {
  name: string;
  default?: string;
  description?: string;
}

export interface OrgNode {
  lead?: string;
  members?: string[];
  description?: string;
  subgroups?: Record<string, OrgNode>;
}

export interface OrgConfig {
  groups: Record<string, OrgNode>;
  tags?: Record<string, string[]>;
}

export interface DeployConfig {
  version: string;
  team?: string;
  parameters?: ConfigParameter[];
  onchain?: OnchainConfig;              // Onchain registration settings
  org?: OrgConfig;                      // Organization chart
  defaults?: {
    runtime?: HarnessType;              // Default harness for all agents
    model?: string;
    claudeMd?: string;                  // Default CLAUDE.md content for all agents
    claudeMdFile?: string;              // Path to default claudeMd file (relative to config)
    plugins?: PluginConfig[];           // Skill plugins
    skills?: string[];                  // Default skills for all agents
    allowedTools?: string[];
    resources?: ResourceConfig;
    local?: boolean;                    // Run all agents locally by default
    talkTimeout?: number;               // Default /talk-to timeout in ms
    heartbeatFile?: string;             // Default heartbeat config file for all agents
  };
  agents: AgentSpec[];
}

/**
 * Parse command line args into parameter values.
 * Supports: key=value pairs or positional args matching parameter order.
 * Example: "designer1 sonnet" or "name=designer1 model=sonnet"
 */
export function parseDeployArgs(args: string[], parameters: ConfigParameter[] = []): Record<string, string> {
  const values: Record<string, string> = {};

  // Start with defaults
  for (const param of parameters) {
    if (param.default !== undefined) {
      values[param.name] = param.default;
    }
  }

  // Parse args - support both key=value and positional
  let positionalIndex = 0;
  for (const arg of args) {
    if (arg.includes('=')) {
      // key=value format
      const eqIndex = arg.indexOf('=');
      const key = arg.substring(0, eqIndex);
      const value = arg.substring(eqIndex + 1);
      values[key] = value;
    } else {
      // Positional - map to parameter by order
      if (positionalIndex < parameters.length) {
        values[parameters[positionalIndex].name] = arg;
        positionalIndex++;
      }
    }
  }

  return values;
}

/**
 * Substitute ${param} placeholders in a string.
 * Supports:
 *   - ${param} - config parameters
 *   - ${env:VAR_NAME} - environment variables
 */
export function substituteParams(content: string, params: Record<string, string>): string {
  return content.replace(/\$\{([^}]+)\}/g, (match, paramName) => {
    // Handle environment variables: ${env:VAR_NAME}
    if (paramName.startsWith('env:')) {
      const envVar = paramName.slice(4); // Remove 'env:' prefix
      const value = process.env[envVar];
      if (value !== undefined) {
        return value;
      }
      // Leave unresolved env vars as-is (will be caught in validation)
      return match;
    }

    if (paramName in params) {
      return params[paramName];
    }
    // Leave unresolved params as-is (will be caught in validation)
    return match;
  });
}

/**
 * Check for unresolved parameters in content.
 * Returns unresolved ${param} and ${env:VAR} placeholders.
 */
export function findUnresolvedParams(content: string): string[] {
  const matches = content.match(/\$\{([^}]+)\}/g) || [];
  return matches.map(m => m.slice(2, -1)); // Remove ${ and }
}

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Parse a YAML config file with optional parameter substitution.
 * First pass: parse to get parameters, then substitute and re-parse.
 */
export function parseConfig(filePath: string, args: string[] = []): DeployConfig {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  let content = fs.readFileSync(absolutePath, 'utf-8');

  // First pass: parse to extract parameters (before substitution)
  const initialConfig = yaml.load(content) as DeployConfig;
  if (!initialConfig) {
    throw new Error(`Failed to parse config file: ${absolutePath}`);
  }

  // If there are parameters defined, substitute them
  if (initialConfig.parameters && initialConfig.parameters.length > 0) {
    const paramValues = parseDeployArgs(args, initialConfig.parameters);
    content = substituteParams(content, paramValues);

    // Check for unresolved parameters
    const unresolved = findUnresolvedParams(content);
    if (unresolved.length > 0) {
      throw new Error(`Unresolved parameters: ${unresolved.join(', ')}. Provide values via: /deploy config.yaml ${unresolved.map(p => `${p}=value`).join(' ')}`);
    }
  }

  // Final parse with substituted values
  const config = yaml.load(content) as DeployConfig;
  if (!config) {
    throw new Error(`Failed to parse config file after substitution: ${absolutePath}`);
  }

  return config;
}

/**
 * Get parameters from a config file without full parsing
 */
export function getConfigParameters(filePath: string): ConfigParameter[] {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    return [];
  }

  const content = fs.readFileSync(absolutePath, 'utf-8');
  const config = yaml.load(content) as DeployConfig;

  return config?.parameters || [];
}

/**
 * Validate a deploy config
 */
export function validateConfig(config: DeployConfig): ValidationResult {
  const errors: ValidationError[] = [];

  // Check version
  if (!config.version) {
    errors.push({ path: 'version', message: 'version is required' });
  }

  // Check agents array
  if (!config.agents || !Array.isArray(config.agents)) {
    errors.push({ path: 'agents', message: 'agents array is required' });
    return { valid: false, errors };
  }

  if (config.agents.length === 0) {
    errors.push({ path: 'agents', message: 'agents array must have at least one agent' });
  }

  // Validate each agent
  config.agents.forEach((agent, index) => {
    const agentPath = `agents[${index}]`;

    if (!agent.name) {
      errors.push({ path: `${agentPath}.name`, message: 'agent name is required' });
    }

    if (agent.name && !/^[a-zA-Z0-9_-]+$/.test(agent.name)) {
      errors.push({
        path: `${agentPath}.name`,
        message: 'agent name must contain only alphanumeric characters, hyphens, and underscores'
      });
    }

    // Validate runtime
    if (agent.runtime && !isValidHarnessType(agent.runtime)) {
      errors.push({
        path: `${agentPath}.runtime`,
        message: `runtime must be one of: ${getAvailableHarnesses().join(', ')}`
      });
    }

    // Validate plugins
    if (agent.plugins) {
      agent.plugins.forEach((plugin, pIndex) => {
        const pluginPath = `${agentPath}.plugins[${pIndex}]`;
        if (!plugin.name) {
          errors.push({ path: `${pluginPath}.name`, message: 'plugin name is required' });
        }
        if (!plugin.path) {
          errors.push({ path: `${pluginPath}.path`, message: 'plugin path is required' });
        }
      });
    }

    // Validate resource config
    if (agent.resources) {
      if (agent.resources.memory && !/^\d+[gmkGMK]?$/.test(agent.resources.memory)) {
        errors.push({
          path: `${agentPath}.resources.memory`,
          message: 'invalid memory format (use e.g., "2g", "512m")'
        });
      }
      if (agent.resources.cpus && (typeof agent.resources.cpus !== 'number' || agent.resources.cpus <= 0)) {
        errors.push({
          path: `${agentPath}.resources.cpus`,
          message: 'cpus must be a positive number'
        });
      }
    }
  });

  // Validate defaults
  if (config.defaults) {
    // Validate defaults runtime
    if (config.defaults.runtime && !isValidHarnessType(config.defaults.runtime)) {
      errors.push({
        path: 'defaults.runtime',
        message: `runtime must be one of: ${getAvailableHarnesses().join(', ')}`
      });
    }

    if (config.defaults.plugins) {
      config.defaults.plugins.forEach((plugin, pIndex) => {
        const pluginPath = `defaults.plugins[${pIndex}]`;
        if (!plugin.name) {
          errors.push({ path: `${pluginPath}.name`, message: 'plugin name is required' });
        }
        if (!plugin.path) {
          errors.push({ path: `${pluginPath}.path`, message: 'plugin path is required' });
        }
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Resolve plugin paths relative to a base path
 */
export function resolvePluginPaths(config: DeployConfig, basePath: string): DeployConfig {
  const resolvedConfig = { ...config };

  // Resolve defaults plugins
  if (resolvedConfig.defaults?.plugins) {
    resolvedConfig.defaults = {
      ...resolvedConfig.defaults,
      plugins: resolvedConfig.defaults.plugins.map(plugin => ({
        ...plugin,
        path: path.resolve(basePath, plugin.path)
      }))
    };
  }

  // Resolve agent plugins
  resolvedConfig.agents = resolvedConfig.agents.map(agent => {
    if (!agent.plugins) return agent;
    return {
      ...agent,
      plugins: agent.plugins.map(plugin => ({
        ...plugin,
        path: path.resolve(basePath, plugin.path)
      }))
    };
  });

  return resolvedConfig;
}

/**
 * Load team context from TEAM.md file
 */
export function loadTeamContext(teamName: string, workspacePath: string = '/workspace'): string | null {
  const teamFilePath = path.join(workspacePath, 'teams', teamName, 'TEAM.md');

  if (!fs.existsSync(teamFilePath)) {
    return null;
  }

  return fs.readFileSync(teamFilePath, 'utf-8');
}

/**
 * Check if a plugin exists at the given path
 */
export function pluginExists(pluginPath: string): boolean {
  // Check for plugin.json or SKILL.md
  const pluginJsonPath = path.join(pluginPath, 'plugin.json');
  const skillMdPath = path.join(pluginPath, 'SKILL.md');

  return fs.existsSync(pluginJsonPath) || fs.existsSync(skillMdPath);
}

/**
 * Verify all plugins in a config exist
 */
export function verifyPlugins(config: DeployConfig, basePath: string): ValidationResult {
  const errors: ValidationError[] = [];

  const checkPlugins = (plugins: PluginConfig[] | undefined, pathPrefix: string) => {
    if (!plugins) return;
    plugins.forEach((plugin, index) => {
      const resolvedPath = path.resolve(basePath, plugin.path);
      if (!pluginExists(resolvedPath)) {
        errors.push({
          path: `${pathPrefix}[${index}]`,
          message: `Plugin not found at: ${resolvedPath}`
        });
      }
    });
  };

  // Check defaults plugins
  checkPlugins(config.defaults?.plugins, 'defaults.plugins');

  // Check agent plugins
  config.agents.forEach((agent, index) => {
    checkPlugins(agent.plugins, `agents[${index}].plugins`);
  });

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Resolve claudeMdFile to claudeMd content
 * If both claudeMdFile and claudeMd are set, file content comes first
 */
export function resolveClaudeMdFile(spec: { claudeMd?: string; claudeMdFile?: string }, basePath: string): string | undefined {
  const parts: string[] = [];

  // Load file content first
  if (spec.claudeMdFile) {
    const filePath = path.resolve(basePath, spec.claudeMdFile);
    if (fs.existsSync(filePath)) {
      parts.push(fs.readFileSync(filePath, 'utf-8'));
    } else {
      throw new Error(`claudeMdFile not found: ${filePath}`);
    }
  }

  // Then inline content
  if (spec.claudeMd) {
    parts.push(spec.claudeMd);
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * Heartbeat configuration loaded from yaml file
 */
export interface HeartbeatConfig {
  interval: number;   // seconds
  message: string;    // message to send
  maxBeats?: number;  // max number of heartbeats before stopping (default: 20)
  expiresAfter?: number; // seconds after which heartbeat expires (default: 7200 = 2 hours)
}

/**
 * Resolve heartbeatFile to HeartbeatConfig
 * Returns undefined if no heartbeat file specified
 */
export function resolveHeartbeatFile(heartbeatFile: string | undefined, basePath: string): HeartbeatConfig | undefined {
  if (!heartbeatFile) {
    return undefined;
  }

  const filePath = path.resolve(basePath, heartbeatFile);
  if (!fs.existsSync(filePath)) {
    throw new Error(`heartbeatFile not found: ${filePath}`);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const config = yaml.load(content) as { interval?: number; message?: string };

  if (!config || typeof config.interval !== 'number' || typeof config.message !== 'string') {
    throw new Error(`Invalid heartbeat config: ${filePath} - must have 'interval' (number) and 'message' (string)`);
  }

  return {
    interval: config.interval,
    message: config.message.trim()
  };
}

/**
 * Merge defaults into an agent spec
 */
export function mergeDefaults(agent: AgentSpec, defaults: DeployConfig['defaults']): AgentSpec {
  if (!defaults) return agent;

  const merged: AgentSpec = { ...agent };

  // Runtime: agent overrides defaults, default to 'claude-agent-sdk'
  if (!merged.runtime && defaults.runtime) {
    merged.runtime = defaults.runtime;
  }

  // Model: agent overrides defaults
  if (!merged.model && defaults.model) {
    merged.model = defaults.model;
  }

  // Plugins: merge (agent plugins take precedence for same name)
  if (defaults.plugins && defaults.plugins.length > 0) {
    const agentPluginNames = new Set((merged.plugins || []).map(p => p.name));
    const defaultPluginsToAdd = defaults.plugins.filter(p => !agentPluginNames.has(p.name));
    merged.plugins = [...(merged.plugins || []), ...defaultPluginsToAdd];
  }

  // Skills: merge (agent skills added to defaults, deduped)
  if (defaults.skills && defaults.skills.length > 0) {
    const allSkills = new Set([...defaults.skills, ...(merged.skills || [])]);
    merged.skills = [...allSkills];
  }

  // AllowedTools: agent overrides defaults entirely
  if (!merged.allowedTools && defaults.allowedTools) {
    merged.allowedTools = [...defaults.allowedTools];
  }

  // Resources: deep merge
  if (defaults.resources) {
    merged.resources = {
      ...defaults.resources,
      ...merged.resources,
      env: {
        ...(defaults.resources.env || {}),
        ...(merged.resources?.env || {})
      },
      volumes: merged.resources?.volumes || defaults.resources.volumes
    };
  }

  // Local: agent overrides defaults
  if (merged.local === undefined && defaults.local !== undefined) {
    merged.local = defaults.local;
  }

  // talkTimeout: agent overrides defaults
  if (merged.talkTimeout === undefined && defaults.talkTimeout !== undefined) {
    merged.talkTimeout = defaults.talkTimeout;
  }

  // heartbeatFile: agent overrides defaults
  if (merged.heartbeatFile === undefined && defaults.heartbeatFile !== undefined) {
    merged.heartbeatFile = defaults.heartbeatFile;
  }

  // claudeMd: concatenate defaults + agent (both are appended to base CLAUDE.md)
  if (defaults.claudeMd || merged.claudeMd) {
    const parts: string[] = [];
    if (defaults.claudeMd) parts.push(defaults.claudeMd);
    if (merged.claudeMd) parts.push(merged.claudeMd);
    merged.claudeMd = parts.join('\n\n');
  }

  return merged;
}

/**
 * Process a config file and return fully resolved agent specs
 */
export function processConfig(
  filePath: string,
  workspacePath: string = '/workspace',
  args: string[] = []
): { agents: AgentSpec[]; teamContext: string | null; teamName: string | null; errors: ValidationError[]; parameters?: ConfigParameter[]; onchain?: OnchainConfig; org?: OrgConfig } {
  // Get parameters first (for error messages)
  const parameters = getConfigParameters(filePath);

  const config = parseConfig(filePath, args);
  const basePath = path.dirname(path.resolve(filePath));

  // Validate config structure
  const validation = validateConfig(config);
  if (!validation.valid) {
    return { agents: [], teamContext: null, teamName: null, errors: validation.errors, parameters };
  }

  // Verify plugins exist
  const pluginValidation = verifyPlugins(config, basePath);
  if (!pluginValidation.valid) {
    return { agents: [], teamContext: null, teamName: null, errors: pluginValidation.errors, parameters };
  }

  // Resolve plugin paths
  const resolvedConfig = resolvePluginPaths(config, basePath);

  // Resolve claudeMdFile for defaults
  if (resolvedConfig.defaults?.claudeMdFile || resolvedConfig.defaults?.claudeMd) {
    resolvedConfig.defaults = {
      ...resolvedConfig.defaults,
      claudeMd: resolveClaudeMdFile(resolvedConfig.defaults, basePath),
      claudeMdFile: undefined  // Clear after resolving
    };
  }

  // Resolve claudeMdFile for each agent
  resolvedConfig.agents = resolvedConfig.agents.map(agent => {
    if (agent.claudeMdFile || agent.claudeMd) {
      return {
        ...agent,
        claudeMd: resolveClaudeMdFile(agent, basePath),
        claudeMdFile: undefined  // Clear after resolving
      };
    }
    return agent;
  });

  // Resolve heartbeatFile for each agent
  resolvedConfig.agents = resolvedConfig.agents.map(agent => {
    if (agent.heartbeatFile) {
      const heartbeat = resolveHeartbeatFile(agent.heartbeatFile, basePath);
      return {
        ...agent,
        heartbeat,  // HeartbeatConfig {interval, message}
        heartbeatFile: undefined  // Clear after resolving
      };
    }
    return agent;
  });

  // Merge defaults into each agent
  const agents = resolvedConfig.agents.map(agent =>
    mergeDefaults(agent, resolvedConfig.defaults)
  );

  // Load team context if specified
  const teamContext = resolvedConfig.team
    ? loadTeamContext(resolvedConfig.team, workspacePath)
    : null;

  return { agents, teamContext, teamName: resolvedConfig.team || null, errors: [], parameters, onchain: resolvedConfig.onchain, org: resolvedConfig.org };
}
