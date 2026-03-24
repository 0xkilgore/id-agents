// SPDX-License-Identifier: MIT
/**
 * Configuration utilities shared between CLI and Control API
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { TeamConfig } from './types.js';

// ==================== Project Root ====================

/**
 * Find the project root by walking up from a starting directory
 */
export function findProjectRoot(startDir: string, maxHops: number = 6): string {
  let dir = startDir;
  for (let i = 0; i < maxHops; i++) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) return dir;
    dir = path.resolve(dir, '..');
  }
  return process.cwd();
}

// ==================== Environment Variables ====================

/**
 * Read and parse a .env file
 * Handles: VAR=value, export VAR=value, quoted values
 */
export function readDotEnvFile(envPath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(envPath)) return vars;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      // Handle "export VAR=value" syntax
      let key = trimmed.slice(0, eqIdx).trim();
      key = key.replace(/^export\s+/, '');

      let value = trimmed.slice(eqIdx + 1).trim();

      // Remove quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
  }
  return vars;
}

/**
 * Get environment variables from .env file in project root
 */
export function getEnvVars(projectRoot: string): Record<string, string> {
  return readDotEnvFile(path.join(projectRoot, '.env'));
}

// ==================== Team Config ====================

/**
 * Get the path to the team config file
 */
export function getTeamConfigPath(projectRoot: string): string {
  return path.join(projectRoot, 'workspace', 'team-config.json');
}

/**
 * Read the team configuration
 */
export function readTeamConfig(projectRoot: string): TeamConfig {
  const configPath = getTeamConfigPath(projectRoot);
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write the team configuration
 */
export function writeTeamConfig(projectRoot: string, config: TeamConfig): void {
  const configPath = getTeamConfigPath(projectRoot);
  const dir = path.dirname(configPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

/**
 * Port spacing between teams (1 manager + 100 agent ports)
 */
const TEAM_PORT_SPACING = 101;

/**
 * Get the next available team port.
 * Teams are allocated port ranges: manager at port N, agents at N+1 to N+100.
 * Each team gets 101 ports to avoid overlap.
 */
export function getNextTeamPort(projectRoot: string): number {
  const config = readTeamConfig(projectRoot);
  const usedPorts = Object.values(config).map(t => t.port);
  let port = 3100;
  // Find next available port that doesn't conflict with any team's range
  while (usedPorts.some(usedPort => {
    // Check if port overlaps with any existing team's range [usedPort, usedPort+100]
    // or if any existing team's range would overlap with [port, port+100]
    return (port >= usedPort && port <= usedPort + 100) ||
           (usedPort >= port && usedPort <= port + 100);
  })) {
    port += TEAM_PORT_SPACING;
  }
  return port;
}

/**
 * Get manager URL for a team
 */
export function getTeamManagerUrl(projectRoot: string, teamName: string): string {
  const config = readTeamConfig(projectRoot);
  if (config[teamName]) {
    return `http://localhost:${config[teamName].port}`;
  }
  return 'http://localhost:3100'; // fallback
}

// ==================== Agent Name Validation ====================

/**
 * Sanitize an agent name by removing trailing invalid characters
 */
export function sanitizeAgentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+$/, '');
}

/**
 * Validate an agent name
 */
export function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
}

// ==================== File Path Utilities ====================

/**
 * Create a safe filename from a string
 */
export function safeFilenamePart(input: string, maxLength: number = 50): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLength);
}

/**
 * Get the workspace directory for a team
 */
export function getTeamWorkspaceDir(projectRoot: string, teamName: string): string {
  return path.join(projectRoot, 'workspace', 'teams', teamName);
}

/**
 * Get the shared directory for a team
 */
export function getTeamSharedDir(projectRoot: string, teamName: string): string {
  return path.join(getTeamWorkspaceDir(projectRoot, teamName), 'shared');
}

