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
import { fileURLToPath } from 'url';
import { HarnessType, isValidHarnessType, getAvailableHarnesses } from './harness/index.js';
import {
  getDefaultRuntime,
  resolveRuntime,
  validateRuntimeModelCompatibility,
  getRuntimePaths,
  isSupportedRuntimeSpecifier,
} from './runtime/registry.js';
import { validateName } from './name-validation.js';
import { enumerateLibraryAgents } from './lib/agent-library.js';
import { resolveDefaultLibraryRoot } from './lib/library-inventory.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ScheduleDeliveryMode = 'talk' | 'internal';

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
  agent?: string;                     // Library agent overlay name (resolves to <library-root>/agents/<agent>/)
  type?: 'claude' | 'automator';      // Agent type: 'claude' (default) or 'automator' (manager's brain, hidden)
  runtime?: HarnessType | 'codex-cli'; // Runtime harness id, defaults to 'claude-agent-sdk'
  openMode?: boolean;                 // Allow XMTP messages from any sender when no allowlist is configured
  description?: string;
  model?: string;
  systemPrompt?: string;              // Custom system prompt for the agent
  roleBody?: string;                  // Agent role content from .claude/agents/<name>.md (set by processConfig)
  plugins?: PluginConfig[];           // Skill plugins
  skills?: string[];                  // Skills to deploy (names match skills/<name>/SKILL.md)
  allowedTools?: string[];
  resources?: ResourceConfig;
  register?: boolean;                 // Auto-register onchain after deploy
  local?: boolean;                    // Run locally using the selected runtime's local auth flow
  port?: number;                      // Port for local agents (auto-allocated if not specified)
  workingDirectory?: string;          // Working directory for local agents
  verbose?: boolean | string;         // Enable detailed logging (show tool calls, progress)
  dangerouslySkipPermissions?: boolean; // Skip CLI permission prompts (default: true; agents have no shell to approve)
  talkTimeout?: number;               // Default timeout for /talk-to in ms (default: 120000, max: 600000)
  heartbeatFile?: string;             // Path to heartbeat yaml config (relative to config file)
  heartbeat?: number | HeartbeatConfig;  // Number = new model (seconds, reads HEARTBEAT.md), object = legacy (interval+message)
  domain?: string;                    // ENS domain name (e.g., "x.agent-15.xid.eth")
  tokenId?: string;                   // Namehash of the ENS domain (bytes32)
  address?: string;                   // Ethereum address (links to .env.<name>.<address> file)
}

export interface CalendarSpec {
  title: string;
  time: string;                    // HH:MM or HH:MM:SS
  timezone?: string;               // IANA timezone, defaults to host timezone
  date?: string;                   // YYYY-MM-DD for one-off
  days?: string[];                 // ['mon','wed','fri'] for recurring
  agents: string[];                // target agent names/refs
  description?: string;
  message?: string;
  catchUpPolicy?: 'skip' | 'fire_once';
  delivery?: ScheduleDeliveryMode;
}

export interface OnchainConfig {
  registryAddress?: string;           // ERC-6551 registry address
  registrarAddress?: string;          // Registrar contract for minting
  chainId?: number;                   // Chain ID (default: 8453 for Base)
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

/** A group — the recursive building block of org structure. */
export interface Group {
  lead?: string;
  members?: string[];
  description?: string;
  groups?: Record<string, Group>;
}

/** Org config — groups and tags. */
export interface OrgConfig {
  groups: Record<string, Group>;
  tags?: Record<string, string[]>;
}

export interface DeployConfig {
  version: string;
  team?: string;
  parameters?: ConfigParameter[];
  onchain?: OnchainConfig;              // Onchain registration settings
  org?: OrgConfig;                      // Organization chart
  calendar?: CalendarSpec[];            // Team calendar schedules
  defaults?: {
    runtime?: HarnessType;              // Default harness for all agents
    model?: string;
    plugins?: PluginConfig[];           // Skill plugins
    skills?: string[];                  // Default skills for all agents
    allowedTools?: string[];
    resources?: ResourceConfig;
    register?: boolean;                 // Auto-register all agents onchain (default: undefined, use onchain.register)
    local?: boolean;                    // Run all agents locally by default
    dangerouslySkipPermissions?: boolean; // Default skip-permissions for all agents
    talkTimeout?: number;               // Default /talk-to timeout in ms
    heartbeatFile?: string;             // Default heartbeat config file for all agents
    heartbeat?: number | HeartbeatConfig;  // Default heartbeat for all agents
  };
  agents: AgentSpec[];
}

/**
 * Team-config shape used by local workspace sync.
 *
 * Unlike deploy configs, sync fixtures may omit `version` and use `name`
 * instead of `team`.
 */
export interface TeamConfig {
  name?: string;
  team?: string;
  parameters?: ConfigParameter[];
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
 * Parse a lightweight team config for local workspace sync.
 *
 * Accepts the same parameter substitution syntax as deploy configs, but does
 * not require deploy-only fields such as `version`.
 */
export function parseTeamConfig(filePath: string, args: string[] = []): TeamConfig {
  const absolutePath = path.resolve(filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${absolutePath}`);
  }

  let content = fs.readFileSync(absolutePath, 'utf-8');
  const initialConfig = yaml.load(content) as TeamConfig | undefined;
  if (!initialConfig) {
    throw new Error(`Failed to parse config file: ${absolutePath}`);
  }

  if (initialConfig.parameters && initialConfig.parameters.length > 0) {
    const paramValues = parseDeployArgs(args, initialConfig.parameters);
    content = substituteParams(content, paramValues);

    const unresolved = findUnresolvedParams(content);
    if (unresolved.length > 0) {
      throw new Error(`Unresolved parameters: ${unresolved.join(', ')}`);
    }
  }

  const config = yaml.load(content) as TeamConfig | undefined;
  if (!config) {
    throw new Error(`Failed to parse config file after substitution: ${absolutePath}`);
  }

  return config;
}

/**
 * Local workspace sync resolves its library root to the team config's parent
 * directory. Example:
 *   /repo/configs/foundry-demo.yaml -> /repo/configs
 */
export function resolveConfigLibraryRoot(filePath: string): string {
  return path.dirname(path.resolve(filePath));
}

/**
 * Resolve an `agent:` reference to the library entry folder.
 *
 * This is a direct lookup under `<library-root>/agents/<agent>/` with no
 * fallback or alternate search path.
 */
export function resolveLibraryAgentPath(filePath: string, agentName: string, libraryRoot?: string): string {
  const root = libraryRoot ? path.resolve(libraryRoot) : resolveConfigLibraryRoot(filePath);
  return path.join(root, 'agents', agentName);
}

/**
 * Validate a deploy config
 */
export function validateConfig(config: DeployConfig): ValidationResult {
  const validDays = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  const errors: ValidationError[] = [];
  const defaultRuntime = resolveRuntime(config.defaults?.runtime || getDefaultRuntime());

  // Check version
  if (!config.version) {
    errors.push({ path: 'version', message: 'version is required' });
  }

  // Check team name if specified
  if (config.team) {
    const teamResult = validateName(config.team, 'team');
    if (!teamResult.valid) {
      errors.push({ path: 'team', message: teamResult.error! });
    }
  }

  // Check agents array
  if (!config.agents || !Array.isArray(config.agents)) {
    errors.push({ path: 'agents', message: 'agents array is required' });
    return { valid: false, errors };
  }

  if (config.agents.length === 0) {
    errors.push({ path: 'agents', message: 'agents array must have at least one agent' });
  }

  if (config.calendar) {
    config.calendar.forEach((event, index) => {
      const eventPath = `calendar[${index}]`;
      if (!event.title) errors.push({ path: `${eventPath}.title`, message: 'calendar title is required' });
      if (!event.time || !/^\d{2}:\d{2}(:\d{2})?$/.test(event.time)) {
        errors.push({ path: `${eventPath}.time`, message: 'calendar time must be HH:MM or HH:MM:SS' });
      }
      if (!event.agents || !Array.isArray(event.agents) || event.agents.length === 0) {
        errors.push({ path: `${eventPath}.agents`, message: 'calendar agents must be a non-empty array' });
      }
      if (event.delivery && !['talk', 'internal'].includes(event.delivery)) {
        errors.push({ path: `${eventPath}.delivery`, message: 'calendar delivery must be \"talk\" or \"internal\"' });
      }
      if (!!event.date === !!(event.days && event.days.length > 0)) {
        errors.push({ path: eventPath, message: 'calendar entry must specify either date or days' });
      }
      if (event.days) {
        for (const day of event.days) {
          if (!validDays.has(day.toLowerCase())) {
            errors.push({ path: `${eventPath}.days`, message: `invalid day: ${day}` });
          }
        }
      }
    });
  }

  // Validate each agent
  config.agents.forEach((agent, index) => {
    const agentPath = `agents[${index}]`;

    if (!agent.name) {
      errors.push({ path: `${agentPath}.name`, message: 'agent name is required' });
    }

    if (agent.name) {
      const nameResult = validateName(agent.name, 'agent');
      if (!nameResult.valid) {
        errors.push({ path: `${agentPath}.name`, message: nameResult.error! });
      } else if (!/^[a-zA-Z0-9_-]+$/.test(agent.name)) {
        errors.push({
          path: `${agentPath}.name`,
          message: 'agent name must contain only alphanumeric characters, hyphens, and underscores'
        });
      }
    }

    if (agent.agent !== undefined && typeof agent.agent !== 'string') {
      errors.push({
        path: `${agentPath}.agent`,
        message: 'agent must be a string'
      });
    }

    // Validate runtime
    if (agent.runtime && !isSupportedRuntimeSpecifier(agent.runtime) && !isValidHarnessType(agent.runtime)) {
      errors.push({
        path: `${agentPath}.runtime`,
        message: `runtime must be one of: ${getAvailableHarnesses().join(', ')}, codex-cli`
      });
    }

    const effectiveRuntime = resolveRuntime(agent.runtime || defaultRuntime);
    const effectiveModel = agent.model || config.defaults?.model;
    for (const issue of validateRuntimeModelCompatibility(effectiveRuntime, effectiveModel)) {
      errors.push({
        path: agent.model ? `${agentPath}.model` : `${agentPath}.runtime`,
        message: issue.message
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

    for (const issue of validateRuntimeModelCompatibility(defaultRuntime, config.defaults.model)) {
      errors.push({
        path: config.defaults.model ? 'defaults.model' : 'defaults.runtime',
        message: issue.message
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
 * Result of loading a sub-agent template from .claude/agents/<name>.md
 */
export interface SubAgentTemplate {
  body: string;                       // Markdown body (after frontmatter)
  description?: string;               // Description from frontmatter
  frontmatter: Record<string, any>;   // All frontmatter fields
}

/**
 * Load a sub-agent template from the working directory.
 *
 * Lookup order (runtime-aware):
 *   Claude:  1. {workingDir}/.claude/agents/{name}/CLAUDE.md
 *            2. {workingDir}/.claude/agents/{name}.md
 *   Codex:   1. {workingDir}/.agents/{name}/AGENTS.md
 *            2. {workingDir}/.agents/{name}.md
 *   3. Neither exists → returns undefined (no-op)
 *
 * Parses YAML frontmatter (--- delimited) and returns body + metadata.
 */
export function loadSubAgentTemplate(workingDir: string, filename: string, runtime?: HarnessType | string): SubAgentTemplate | undefined {
  const rp = getRuntimePaths(runtime);
  const agentsDir = path.join(workingDir, rp.templateDir);

  // 1. Directory pattern: {name}/CLAUDE.md or {name}/AGENTS.md
  const dirPath = path.join(agentsDir, filename, rp.personalityFilename);
  if (fs.existsSync(dirPath)) {
    return parseSubAgentTemplate(fs.readFileSync(dirPath, 'utf-8'));
  }

  // 2. Single-file pattern: {name}.md
  const filePath = path.join(agentsDir, `${filename}.md`);
  if (fs.existsSync(filePath)) {
    return parseSubAgentTemplate(fs.readFileSync(filePath, 'utf-8'));
  }

  return undefined;
}

/**
 * Copy the contents of a directory-based agent template into the agent's config directory.
 *
 * Runtime-aware: Claude overlays to .claude/, Codex overlays to .agents/.
 *
 * Returns true if a copy was performed, false if no directory exists.
 */
export function copyAgentDirOverlay(workingDir: string, templateName: string, runtime?: HarnessType | string): boolean {
  const rp = getRuntimePaths(runtime);
  const srcDir = path.join(workingDir, rp.templateDir, templateName);

  if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    return false;
  }

  const destDir = path.join(workingDir, rp.overlayTarget);
  fs.cpSync(srcDir, destDir, { recursive: true, force: true });
  return true;
}

/**
 * Overlay a library-backed agent entry into the working directory using a
 * runtime-aware destination.
 *
 * Source directory: `<libraryRoot>/agents/<name>/`, resolved through the v3
 * library enumerator. Both native shapes are supported:
 *   - 'claude-native'     `<name>/CLAUDE.md` inside the directory
 *   - 'agents-md-native'  sibling pair (`<name>.md` file + `<name>/` directory)
 *
 * Destination is the runtime's overlay target under the working directory:
 *   - Claude runtimes  → `<workingDir>/.claude/`
 *   - Codex            → `<workingDir>/.agents/`
 *   - Cursor CLI       → `<workingDir>/.cursor/`
 *
 * Persona collision (Claude runtimes):
 *   The framework writes its own `.claude/CLAUDE.md` (PROTOCOL_DEFAULTS +
 *   roleBody) immediately after the library overlay. To avoid clobbering
 *   the library persona, the library's CLAUDE.md is routed to
 *   `.claude/rules/agent-<name>.md` instead — Claude auto-loads
 *   `.claude/rules/*.md` at session start, so both the framework defaults
 *   and the library persona are visible to the agent.
 *
 *   For `agents-md-native` entries the sibling `<name>.md` is similarly
 *   placed at `.claude/rules/agent-<name>.md` so the persona is preserved.
 *
 *   For non-Claude runtimes the framework's personality file is `AGENTS.md`
 *   at the workspace root, which doesn't collide with anything under the
 *   `.agents/` or `.cursor/` overlay target, so no rewrite is applied.
 *
 * Library-root resolution defaults to `resolveDefaultLibraryRoot()` —
 * `process.env.ID_LIBRARY_ROOT` if set, else `<cwd>/configs`, else null —
 * matching the slice-7 manager `/library/*` endpoints.
 *
 * Returns `false` (no-op) when:
 *   - the library directory does not exist
 *   - no entry with that name is found
 *   - the enumerator reports a discovery error for that name
 *     (mixed-shape or incomplete pair)
 *
 * @param workingDir   Absolute path to the agent workspace.
 * @param name         Library entry name to resolve.
 * @param runtime      Runtime id; selects the overlay destination.
 *                     Defaults to the Claude overlay target.
 * @param libraryRoot  Optional library root. Defaults to
 *                     `resolveDefaultLibraryRoot()`.
 */
export function copyLibraryAgentOverlay(
  workingDir: string,
  name: string,
  runtime?: HarnessType | string,
  libraryRoot?: string,
): boolean {
  const root = libraryRoot
    ? path.resolve(libraryRoot)
    : resolveDefaultLibraryRoot();
  if (!root) return false;

  const scan = enumerateLibraryAgents(path.join(root, 'agents'));
  if (scan.errors.some(err => err.name === name)) return false;

  const entry = scan.entries.find(e => e.name === name);
  if (!entry) return false;

  const rp = getRuntimePaths(runtime);
  const destDir = path.join(workingDir, rp.overlayTarget);
  fs.mkdirSync(destDir, { recursive: true });
  // dereference:true so a symlinked library entry copies its target's
  // contents — keeps symlink-anchored entries first-class with the
  // matching enumerator change.
  fs.cpSync(entry.dirPath, destDir, { recursive: true, force: true, dereference: true });

  // Sidecar rewrite — only matters for Claude runtimes whose framework
  // personality file lives at .claude/CLAUDE.md (see jsdoc).
  const isClaudeOverlay = rp.overlayTarget === '.claude';
  if (isClaudeOverlay) {
    const sidecarPath = path.join(destDir, 'rules', `agent-${name}.md`);
    const claudeMdAtDest = path.join(destDir, 'CLAUDE.md');
    if (entry.shape === 'claude-native' && fs.existsSync(claudeMdAtDest)) {
      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.renameSync(claudeMdAtDest, sidecarPath);
    } else if (entry.shape === 'agents-md-native') {
      // The recursive copy did not include the sibling <name>.md; place
      // it directly at the sidecar path so the persona is still applied.
      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.copyFileSync(entry.memoryFile, sidecarPath);
    }
  }

  return true;
}

/**
 * Copy HEARTBEAT.md from agent template directory to working directory root.
 * Runtime-aware: checks the runtime-specific template directory.
 * Destination is always {workingDir}/HEARTBEAT.md regardless of runtime.
 */
export function copyHeartbeatMd(workingDir: string, templateName: string, runtime?: HarnessType | string): boolean {
  const rp = getRuntimePaths(runtime);
  const src = path.join(workingDir, rp.templateDir, templateName, 'HEARTBEAT.md');
  if (!fs.existsSync(src)) {
    return false;
  }
  fs.copyFileSync(src, path.join(workingDir, 'HEARTBEAT.md'));
  return true;
}

/**
 * Parse a sub-agent template string into frontmatter and body.
 * Exported for testing.
 */
export function parseSubAgentTemplate(raw: string): SubAgentTemplate {
  const frontmatterMatch = raw.match(/^---\r?\n([\s\S]*?)(?:\r?\n)?---\r?\n([\s\S]*)$/);

  if (frontmatterMatch) {
    const frontmatter = (yaml.load(frontmatterMatch[1]) as Record<string, any>) || {};
    const body = frontmatterMatch[2].trim();
    return {
      body,
      description: typeof frontmatter.description === 'string' ? frontmatter.description : undefined,
      frontmatter,
    };
  }

  // No frontmatter — entire content is the body
  return {
    body: raw.trim(),
    frontmatter: {},
  };
}

/**
 * Heartbeat configuration loaded from yaml file
 */
export interface HeartbeatConfig {
  interval: number;   // seconds
  message: string;    // message to send
  maxBeats?: number;  // max number of heartbeats before stopping (default: 20)
  expiresAfter?: number; // seconds after which heartbeat expires (default: 7200 = 2 hours)
  delivery?: ScheduleDeliveryMode;
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
  const config = yaml.load(content) as HeartbeatConfig | undefined;

  if (!config || typeof config.interval !== 'number' || typeof config.message !== 'string') {
    throw new Error(`Invalid heartbeat config: ${filePath} - must have 'interval' (number) and 'message' (string)`);
  }
  if (config.delivery && !['talk', 'internal'].includes(config.delivery)) {
    throw new Error(`heartbeat file has invalid delivery: ${config.delivery}`);
  }

  return {
    interval: config.interval,
    message: config.message.trim(),
    maxBeats: config.maxBeats,
    expiresAfter: config.expiresAfter,
    delivery: config.delivery,
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

  // dangerouslySkipPermissions: agent overrides defaults; consumer (spawn site)
  // defaults to true when both are undefined.
  if (merged.dangerouslySkipPermissions === undefined && defaults.dangerouslySkipPermissions !== undefined) {
    merged.dangerouslySkipPermissions = defaults.dangerouslySkipPermissions;
  }

  // talkTimeout: agent overrides defaults
  if (merged.talkTimeout === undefined && defaults.talkTimeout !== undefined) {
    merged.talkTimeout = defaults.talkTimeout;
  }

  // heartbeat: agent overrides defaults (number or object)
  if (merged.heartbeat === undefined && merged.heartbeatFile === undefined) {
    if (defaults.heartbeat !== undefined) {
      merged.heartbeat = defaults.heartbeat;
    } else if (defaults.heartbeatFile !== undefined) {
      merged.heartbeatFile = defaults.heartbeatFile;
    }
  }

  // register: agent overrides defaults
  if (merged.register === undefined && defaults.register !== undefined) {
    merged.register = defaults.register;
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
): { agents: AgentSpec[]; calendar: CalendarSpec[]; teamContext: string | null; teamName: string | null; errors: ValidationError[]; parameters?: ConfigParameter[]; onchain?: OnchainConfig; org?: OrgConfig } {
  // Get parameters first (for error messages)
  const parameters = getConfigParameters(filePath);

  const config = parseConfig(filePath, args);
  const basePath = path.dirname(path.resolve(filePath));

  // Validate config structure
  const validation = validateConfig(config);
  if (!validation.valid) {
    return { agents: [], calendar: [], teamContext: null, teamName: null, errors: validation.errors, parameters };
  }

  // Verify plugins exist
  const pluginValidation = verifyPlugins(config, basePath);
  if (!pluginValidation.valid) {
    return { agents: [], calendar: [], teamContext: null, teamName: null, errors: pluginValidation.errors, parameters };
  }

  // Resolve plugin paths
  const resolvedConfig = resolvePluginPaths(config, basePath);

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
  let agents = resolvedConfig.agents.map(agent =>
    mergeDefaults(agent, resolvedConfig.defaults)
  );

  // Load sub-agent templates (runtime-aware: .claude/agents/ for Claude, .agents/ for Codex)
  agents = agents.map(agent => {
    if (!agent.workingDirectory) return agent;
    const template = loadSubAgentTemplate(agent.workingDirectory, agent.name, agent.runtime);
    if (!template) return agent;

    const updated = { ...agent };

    // Template body becomes the agent's role content
    if (template.body) {
      updated.roleBody = template.body;
    }

    // Use template description as default if agent config lacks one
    if (!updated.description && template.description) {
      updated.description = template.description;
    }

    return updated;
  });

  // Load team context if specified
  const teamContext = resolvedConfig.team
    ? loadTeamContext(resolvedConfig.team, workspacePath)
    : null;

  return { agents, calendar: resolvedConfig.calendar || [], teamContext, teamName: resolvedConfig.team || null, errors: [], parameters, onchain: resolvedConfig.onchain, org: resolvedConfig.org };
}
