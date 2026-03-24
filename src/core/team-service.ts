// SPDX-License-Identifier: MIT
/**
 * Team Service - Team management operations (local mode)
 *
 * Teams are managed via the local manager process.
 * All agents run as local processes.
 */

import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import type {
  TeamInfo,
  TeamConfig,
  OperationResult,
  CreateTeamResult
} from './types.js';
import {
  readTeamConfig,
  writeTeamConfig,
  getNextTeamPort,
} from './config-utils.js';

// ==================== List Teams ====================

/**
 * List all teams with their status
 */
export async function listTeams(projectRoot: string): Promise<OperationResult<TeamInfo[]>> {
  try {
    const config = readTeamConfig(projectRoot);
    const teams: TeamInfo[] = [];

    for (const [name, conf] of Object.entries(config)) {
      let status: TeamInfo['status'] = 'unknown';
      try {
        const response = await fetch(`http://localhost:${conf.port}/health`, {
          signal: AbortSignal.timeout(2000)
        });
        status = response.ok ? 'running' : 'stopped';
      } catch {
        status = 'stopped';
      }

      teams.push({
        name,
        port: conf.port,
        managerId: conf.managerId,
        managerUrl: `http://localhost:${conf.port}`,
        status,
        createdAt: conf.createdAt
      });
    }

    return { success: true, data: teams };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Get Team Info ====================

/**
 * Get information about a specific team
 */
export async function getTeamInfo(
  projectRoot: string,
  teamName: string
): Promise<OperationResult<TeamInfo>> {
  try {
    const config = readTeamConfig(projectRoot);
    const conf = config[teamName];

    if (!conf) {
      return { success: false, error: `Team "${teamName}" not found` };
    }

    let status: TeamInfo['status'] = 'unknown';
    try {
      const response = await fetch(`http://localhost:${conf.port}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      status = response.ok ? 'running' : 'stopped';
    } catch {
      status = 'stopped';
    }

    return {
      success: true,
      data: {
        name: teamName,
        port: conf.port,
        managerId: conf.managerId,
        managerUrl: `http://localhost:${conf.port}`,
        status,
        createdAt: conf.createdAt
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Create Team ====================

/**
 * Create a new team (local mode - just allocates config and directory)
 */
export async function createTeam(
  projectRoot: string,
  teamName: string
): Promise<OperationResult<CreateTeamResult>> {
  try {
    const config = readTeamConfig(projectRoot);
    let isNew = false;
    let port: number;

    if (config[teamName]) {
      port = config[teamName].port;
    } else {
      isNew = true;
      port = getNextTeamPort(projectRoot);

      config[teamName] = {
        port,
        managerId: `id-agent-manager-${teamName}`,
        createdAt: new Date().toISOString()
      };
      writeTeamConfig(projectRoot, config);

      // Create team directory
      const teamDir = path.join(projectRoot, 'workspace', 'teams', teamName);
      mkdirSync(teamDir, { recursive: true });
    }

    return {
      success: true,
      data: {
        team: {
          name: teamName,
          port,
          managerId: config[teamName].managerId,
          managerUrl: `http://localhost:${port}`,
          status: 'stopped',
          createdAt: config[teamName].createdAt
        },
        isNew
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Delete Team ====================

/**
 * Delete a team
 */
export async function deleteTeam(
  projectRoot: string,
  teamName: string,
  deleteFiles: boolean = false
): Promise<OperationResult<void>> {
  try {
    const config = readTeamConfig(projectRoot);
    if (!config[teamName]) {
      return { success: false, error: `Team "${teamName}" not found` };
    }

    // Remove from config
    delete config[teamName];
    writeTeamConfig(projectRoot, config);

    // Optionally delete files
    if (deleteFiles) {
      const teamDir = path.join(projectRoot, 'workspace', 'teams', teamName);
      if (existsSync(teamDir)) {
        rmSync(teamDir, { recursive: true, force: true });
      }
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Team Exists ====================

/**
 * Check if a team exists
 */
export function teamExists(projectRoot: string, teamName: string): boolean {
  const config = readTeamConfig(projectRoot);
  return !!config[teamName];
}
