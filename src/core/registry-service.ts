// SPDX-License-Identifier: MIT
/**
 * Registry Service - Onchain registry operations
 *
 * Handles agent registry operations for on-chain identity.
 */

import type {
  OperationResult,
  RegistryConfig,
  RegisterOnchainResult
} from './types.js';

// ==================== Get/Set Registry ====================

/**
 * Get the default registry configuration
 */
export async function getRegistry(
  managerUrl: string,
  teamName?: string
): Promise<OperationResult<RegistryConfig>> {
  try {
    const headers: Record<string, string> = {};
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/registry`, { headers });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to get registry: ${error}` };
    }

    const data = await response.json();
    return { success: true, data: data as RegistryConfig };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Set the default registry configuration
 */
export async function setRegistry(
  managerUrl: string,
  config: RegistryConfig,
  teamName?: string
): Promise<OperationResult<void>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/registry`, {
      method: 'POST',
      headers,
      body: JSON.stringify(config)
    });

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to set registry: ${response.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Registry Push/Pull ====================

/**
 * Push agent metadata to the registry
 */
export async function registryPush(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<{ tokenId?: string }>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/registry/push`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentName })
    });

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to push to registry: ${response.statusText}`
      };
    }

    const data: any = await response.json();
    return { success: true, data: { tokenId: data.tokenId } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

/**
 * Pull agent metadata from the registry
 */
export async function registryPull(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<any>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/registry/pull`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentName })
    });

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to pull from registry: ${response.statusText}`
      };
    }

    const data = await response.json();
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Onchain Registration ====================

/**
 * Register an agent on-chain
 */
export async function registerOnchain(
  managerUrl: string,
  agentName: string,
  teamName?: string
): Promise<OperationResult<RegisterOnchainResult>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(
      `${managerUrl}/agents/by-name/${encodeURIComponent(agentName)}/register`,
      {
        method: 'POST',
        headers
      }
    );

    if (!response.ok) {
      const errorData: any = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorData.error || `Failed to register on-chain: ${response.statusText}`
      };
    }

    const data: any = await response.json();
    return {
      success: true,
      data: {
        txHash: data.txHash,
        tokenId: data.tokenId,
        domain: data.domain || data.agent?.registry?.domain
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

