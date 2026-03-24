// SPDX-License-Identifier: MIT
/**
 * File Service - Agent file operations
 *
 * Handles file listing, fetching, and uploading for agents.
 */

import type { OperationResult, FileInfo } from './types.js';

// ==================== List Files ====================

/**
 * List files in an agent's workspace
 */
export async function listAgentFiles(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<FileInfo[]>> {
  try {
    const headers: Record<string, string> = {};
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/files`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: `Agent "${agentName}" not found` };
      }
      const error = await response.text();
      return { success: false, error: `Failed to list files: ${error}` };
    }

    const data: any = await response.json();
    return { success: true, data: data.files || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Fetch File ====================

/**
 * Fetch a file from an agent's workspace
 */
export async function fetchAgentFile(
  managerUrl: string,
  agentName: string,
  filename: string,
  teamName?: string
): Promise<OperationResult<string>> {
  try {
    const headers: Record<string, string> = {};
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/files/${encodeURIComponent(filename)}`,
      { headers }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return { success: false, error: `File "${filename}" not found` };
      }
      const error = await response.text();
      return { success: false, error: `Failed to fetch file: ${error}` };
    }

    const content = await response.text();
    return { success: true, data: content };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Upload File ====================

/**
 * Upload a file to an agent's workspace
 */
export async function uploadAgentFile(
  managerUrl: string,
  agentName: string,
  filename: string,
  content: string,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/files`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ filename, content })
      }
    );

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to upload file: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Shared Files ====================

/**
 * List files in the team's shared directory
 */
export async function listSharedFiles(
  managerUrl: string,
  teamName?: string
): Promise<OperationResult<FileInfo[]>> {
  try {
    const headers: Record<string, string> = {};
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/shared/files`, { headers });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to list shared files: ${error}` };
    }

    const data: any = await response.json();
    return { success: true, data: data.files || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Upload a file to the team's shared directory
 */
export async function uploadSharedFile(
  managerUrl: string,
  filename: string,
  content: string,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/shared/files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ filename, content })
    });

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to upload shared file: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}
