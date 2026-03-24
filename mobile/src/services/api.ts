import { ServerEntry, RemoteResponse, AgentInfo } from '../types';

/**
 * Execute a CLI command on the manager via POST /remote
 */
export async function executeCommand(
  server: ServerEntry,
  command: string
): Promise<RemoteResponse> {
  const response = await fetch(`${server.url}/remote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': server.apiKey,
      'X-Id-Team': server.team,
    },
    body: JSON.stringify({ command }),
  });

  if (!response.ok) {
    const text = await response.text();
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON
    }
    return {
      ok: false,
      error: parsed?.error || `Server returned ${response.status}`,
    };
  }

  return await response.json();
}

/**
 * Test connectivity to a server
 */
export async function testConnection(
  url: string,
  apiKey: string,
  team?: string
): Promise<{ success: boolean; error?: string; latency?: number }> {
  const start = Date.now();
  try {
    const headers: Record<string, string> = {
      'X-Api-Key': apiKey,
    };
    if (team) {
      headers['X-Id-Team'] = team;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${url}/agents`, {
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latency = Date.now() - start;

    if (response.ok) {
      return { success: true, latency };
    } else if (response.status === 401) {
      return { success: false, error: 'Invalid API key' };
    } else {
      return { success: false, error: `Server returned ${response.status}` };
    }
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return { success: false, error: 'Connection timed out (5s)' };
    }
    return { success: false, error: err.message || 'Connection failed' };
  }
}

/**
 * Fetch agents list from the server
 */
export async function fetchAgents(
  server: ServerEntry
): Promise<AgentInfo[]> {
  const response = await fetch(`${server.url}/agents`, {
    headers: {
      'X-Api-Key': server.apiKey,
      'X-Id-Team': server.team,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch agents: ${response.status}`);
  }

  const data = await response.json();
  return data.agents || data || [];
}
