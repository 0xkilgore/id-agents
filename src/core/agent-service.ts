// SPDX-License-Identifier: MIT
/**
 * Agent Service - Agent lifecycle operations
 *
 * All agent operations go through the team manager's API.
 */

import type {
  OperationResult,
  AgentInfo,
  SpawnAgentOptions
} from './types.js';

// ==================== Helper Functions ====================

/**
 * Build headers for manager API requests
 */
function buildHeaders(teamName?: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Add team header if specified
  if (teamName) {
    headers['X-Id-Team'] = teamName;
  }

  // Add content type if specified
  if (contentType) {
    headers['Content-Type'] = contentType;
  }

  return headers;
}

// ==================== List Agents ====================

/**
 * List all agents in a team via the manager API
 */
export async function listAgents(
  managerUrl: string,
  teamName?: string
): Promise<OperationResult<AgentInfo[]>> {
  try {
    const headers = buildHeaders(teamName);
    const response = await fetch(`${managerUrl}/agents`, { headers });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to list agents: ${error}` };
    }

    const data: any = await response.json();
    return { success: true, data: data.agents || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Get Agent Info ====================

/**
 * Get information about a specific agent
 */
export async function getAgentInfo(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<AgentInfo>> {
  try {
    const headers = buildHeaders(teamName);
    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: `Agent "${agentName}" not found` };
      }
      const error = await response.text();
      return { success: false, error: `Failed to get agent info: ${error}` };
    }

    const data = await response.json();
    return { success: true, data: data as AgentInfo };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Spawn Agent ====================

/**
 * Spawn a new agent via the manager API
 */
export async function spawnAgent(
  managerUrl: string,
  options: SpawnAgentOptions,
  teamName?: string
): Promise<OperationResult<AgentInfo>> {
  try {
    const headers = buildHeaders(teamName, 'application/json');

    const payload: any = {
      name: options.name,
      model: options.model || 'claude-haiku-4-5-20251001',
      runtime: options.runtime || 'claude-agent-sdk'
    };

    if (options.systemPrompt) {
      payload.systemPrompt = options.systemPrompt;
    }

    if (options.config) {
      payload.config = options.config;
    }

    const response = await fetch(`${managerUrl}/agents/spawn`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to spawn agent: ${response.statusText}`
      };
    }

    const data = await response.json();
    return { success: true, data: data as AgentInfo };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Delete Agent ====================

/**
 * Delete an agent via the manager API
 */
export async function deleteAgent(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers = buildHeaders(teamName);
    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}`,
      {
        method: 'DELETE',
        headers
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: `Agent "${agentName}" not found` };
      }
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to delete agent: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Start/Stop Agent ====================

/**
 * Start an agent via the manager API
 */
export async function startAgent(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers = buildHeaders(teamName, 'application/json');
    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/start`,
      {
        method: 'POST',
        headers
      }
    );

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to start agent: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Stop an agent via the manager API
 */
export async function stopAgent(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers = buildHeaders(teamName, 'application/json');
    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/stop`,
      {
        method: 'POST',
        headers
      }
    );

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to stop agent: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Agent Health ====================

/**
 * Check if an agent is healthy
 */
export async function checkAgentHealth(
  agentUrl: string,
  timeoutMs: number = 2000
): Promise<OperationResult<{ healthy: boolean; responseTime?: number }>> {
  try {
    const start = Date.now();
    const response = await fetch(`${agentUrl}/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs)
    });
    const responseTime = Date.now() - start;

    return {
      success: true,
      data: {
        healthy: response.ok,
        responseTime
      }
    };
  } catch (err: any) {
    return {
      success: true,
      data: {
        healthy: false
      }
    };
  }
}

// ==================== Agent Logs ====================

/**
 * Get agent logs from the manager API
 */
export async function getAgentLogs(
  managerUrl: string,
  agentName: string,
  lines: number = 50,
  teamName?: string
): Promise<OperationResult<string>> {
  try {
    const headers = buildHeaders(teamName);
    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/logs?lines=${lines}`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: `Agent "${agentName}" not found` };
      }
      return { success: false, error: `Failed to get logs: ${response.statusText}` };
    }

    const data: any = await response.json();
    return { success: true, data: data.logs || '' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
