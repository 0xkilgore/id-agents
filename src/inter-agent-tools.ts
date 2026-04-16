// SPDX-License-Identifier: MIT
/**
 * Inter-Agent Communication Tool
 * 
 * Allows agents to discover and communicate with other agents
 * in the same team via REST-AP
 */

import fetch from 'node-fetch';

function getManagerBaseUrl(): string {
  // MANAGER_URL should be set for worker agents to communicate with the manager.
  if (process.env.MANAGER_URL && process.env.MANAGER_URL.trim()) return process.env.MANAGER_URL.trim();
  if (process.env.AGENT_ROLE === 'worker') return 'http://localhost:4100';
  return 'http://localhost:3100';
}

export interface AgentInfo {
  id: string;
  name: string;
  model: string;
  port: number;
  url: string;
  internalUrl?: string;
  internal_url?: string;
  status: string;
}

export interface TalkToAgentParams {
  agent_name_or_id: string;
  message: string;
  session_id?: string;
  from?: string;
}

export interface ListAgentsParams {
  // No params needed
}

export interface BroadcastToAgentsParams {
  message: string;
  from?: string;
  exclude_self?: boolean; // Optional: exclude yourself from the broadcast
}

/**
 * Tool: list_agents
 * 
 * Lists all available agents in the team
 */
export async function listAgents(params: ListAgentsParams): Promise<string> {
  try {
    const response = await fetch(`${getManagerBaseUrl()}/agents`);
    
    if (!response.ok) {
      return `Error: Failed to list agents (${response.status})`;
    }
    
    const data = await response.json() as { agents: AgentInfo[] };
    
    if (data.agents.length === 0) {
      return 'No other agents are currently running.';
    }
    
    const agentList = data.agents.map(a => 
      `- ${a.name} (${a.id}): ${a.model} on port ${a.port} - ${a.status}`
    ).join('\n');
    
    return `Available agents:\n${agentList}`;
  } catch (error) {
    return `Error listing agents: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Tool: talk_to_agent
 * 
 * Send a message to another agent and get a response
 */
export async function talkToAgent(params: TalkToAgentParams): Promise<string> {
  try {
    if (typeof params.agent_name_or_id === 'string' && params.agent_name_or_id.toLowerCase() === 'manager') {
      return 'Error: manager is not an agent. Use /talk to message the interactive CLI user.';
    }

    // First, find the agent
    const listResponse = await fetch(`${getManagerBaseUrl()}/agents`);
    if (!listResponse.ok) {
      return `Error: Failed to find agent (${listResponse.status})`;
    }
    
    const { agents } = await listResponse.json() as { agents: AgentInfo[] };
    
    const targetAgent = agents.find(
      a => a.name === params.agent_name_or_id || a.id === params.agent_name_or_id
    );
    
    if (!targetAgent) {
      return `Error: Agent "${params.agent_name_or_id}" not found. Available agents: ${agents.map(a => a.name).join(', ')}`;
    }
    
    // Use internalUrl when available for direct agent-to-agent communication.
    const useInternalUrl = process.env.AGENT_ROLE === 'worker';
    const baseUrl =
      (useInternalUrl && (targetAgent.internalUrl || (targetAgent as any).internal_url)) ? (targetAgent.internalUrl || (targetAgent as any).internal_url) : targetAgent.url;

    // Send message to the agent (include sender name if provided, or get from environment)
    const senderName = params.from || process.env.AGENT_NAME;
    const talkResponse = await fetch(`${baseUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: params.message,
        session_id: params.session_id,
        from: senderName
      })
    });
    
    if (!talkResponse.ok) {
      return `Error: Failed to send message to ${targetAgent.name} (${talkResponse.status})`;
    }
    
    const talkData = await talkResponse.json() as { query_id: string; status: string };
    
    // Poll for response with adaptive intervals (max 1 hour)
    const startTime = Date.now();
    const MAX_POLL_TIME = 60 * 60 * 1000; // 1 hour
    
    function getPollInterval(elapsedMs: number): number {
      const elapsedSeconds = elapsedMs / 1000;
      const elapsedMinutes = elapsedSeconds / 60;
      
      if (elapsedSeconds < 30) return 2000;        // 0-30s: 2 seconds
      if (elapsedMinutes < 1) return 5000;         // 30s-1min: 5 seconds
      if (elapsedMinutes < 2) return 10000;        // 1-2min: 10 seconds
      if (elapsedMinutes < 3) return 20000;        // 2-3min: 20 seconds
      if (elapsedMinutes < 4) return 30000;       // 3-4min: 30 seconds
      if (elapsedMinutes < 5) return 60000;        // 4-5min: 1 minute
      if (elapsedMinutes < 10) return 120000;      // 5-10min: 2 minutes
      if (elapsedMinutes < 60) return 300000;     // 10-60min: 5 minutes
      return -1; // Stop polling after 1 hour
    }
    
    while (Date.now() - startTime < MAX_POLL_TIME) {
      const elapsed = Date.now() - startTime;
      const pollInterval = getPollInterval(elapsed);
      
      if (pollInterval === -1) {
        return `Timeout: ${targetAgent.name} did not respond within 1 hour. Query ID: ${talkData.query_id}`;
      }
      
      await new Promise(resolve => setTimeout(resolve, pollInterval));
      
      // Use query_id parameter for efficient server-side filtering
      const newsResponse = await fetch(`${baseUrl}/news?since=0&query_id=${talkData.query_id}`);
      if (!newsResponse.ok) {
        continue;
      }
      
      const newsData = await newsResponse.json() as { items: any[] };
      
      // Since we're filtering by query_id on the server, items should already be filtered
      const completion = newsData.items.find((item: any) => item.type === 'query.completed');
      if (completion) {
        const result = completion.data.result?.result || 'No response';
        const sessionId = completion.data.result?.sessionId;
        // Include session_id in response so agent can use it for future messages
        if (sessionId) {
          return `Response from ${targetAgent.name} (session_id: ${sessionId} - use this for future messages to maintain context):\n${result}`;
        }
        return `Response from ${targetAgent.name}:\n${result}`;
      }
      
      const failure = newsData.items.find((item: any) => item.type === 'query.failed');
      if (failure) {
        return `Error: ${targetAgent.name} failed to process the message: ${failure.data.error}`;
      }
    }
    
    return `Timeout: ${targetAgent.name} did not respond within 30 seconds. Query ID: ${talkData.query_id}`;
    
  } catch (error) {
    return `Error talking to agent: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Tool: broadcast_to_agents
 * 
 * Send a message to all agents in the team without waiting for responses
 */
export async function broadcastToAgents(params: BroadcastToAgentsParams): Promise<string> {
  try {
    // Get list of all agents
    const listResponse = await fetch(`${getManagerBaseUrl()}/agents`);
    if (!listResponse.ok) {
      return `Error: Failed to list agents (${listResponse.status})`;
    }
    
    const { agents } = await listResponse.json() as { agents: AgentInfo[] };
    
    if (agents.length === 0) {
      return 'No agents found in the team to broadcast to.';
    }
    
    // Get sender name
    const senderName = params.from || process.env.AGENT_NAME;
    const excludeSelf = params.exclude_self !== false; // Default to true
    
    // Filter out self if exclude_self is true
    const targetAgents = excludeSelf && senderName
      ? agents.filter(a => a.name !== senderName)
      : agents;
    
    if (targetAgents.length === 0) {
      return 'No other agents found to broadcast to (excluding yourself).';
    }
    
    // Send message to all agents in parallel (fire and forget)
    const broadcastPromises = targetAgents.map(async (agent) => {
      try {
        const talkResponse = await fetch(`${agent.url}/talk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: params.message,
            from: senderName
          })
        });
        
        if (talkResponse.ok) {
          const talkData = await talkResponse.json() as { query_id: string };
          return { agent: agent.name, success: true, query_id: talkData.query_id };
        } else {
          return { agent: agent.name, success: false, error: `HTTP ${talkResponse.status}` };
        }
      } catch (error) {
        return { 
          agent: agent.name, 
          success: false, 
          error: error instanceof Error ? error.message : String(error) 
        };
      }
    });
    
    // Wait for all broadcasts to be sent (but don't wait for responses)
    const results = await Promise.allSettled(broadcastPromises);
    
    const successful: string[] = [];
    const failed: Array<{ agent: string; error: string }> = [];
    
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const data = result.value;
        if (data.success) {
          successful.push(data.agent);
        } else {
          failed.push({ agent: data.agent, error: data.error || 'Unknown error' });
        }
      } else {
        failed.push({ agent: targetAgents[index].name, error: result.reason?.message || 'Unknown error' });
      }
    });
    
    // Build summary message
    let summary = `Broadcast sent to ${successful.length} agent(s):\n`;
    successful.forEach(name => {
      summary += `  ✓ ${name}\n`;
    });
    
    if (failed.length > 0) {
      summary += `\nFailed to send to ${failed.length} agent(s):\n`;
      failed.forEach(({ agent, error }) => {
        summary += `  ✗ ${agent}: ${error}\n`;
      });
    }
    
    summary += `\nNote: This is a fire-and-forget broadcast. Agents will process the message asynchronously. Check their news feeds or wait for responses if needed.`;
    
    return summary;
    
  } catch (error) {
    return `Error broadcasting to agents: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Tool definitions for Claude Agent SDK
 */
export const INTER_AGENT_TOOLS = [
  {
    name: 'list_agents',
    description: 'List all available agents in the team that you can communicate with. Use this to discover other agents before sending messages.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'talk_to_agent',
    description: 'Send a message to another agent and wait for their response. Use this to delegate tasks, ask questions, or coordinate work with other agents. You can optionally include a "from" parameter to identify yourself to the receiving agent.',
    input_schema: {
      type: 'object',
      properties: {
        agent_name_or_id: {
          type: 'string',
          description: 'The name or ID of the agent to talk to (e.g., "coding-agent" or "agent_1234_abc"). Use list_agents to see available agents.'
        },
        message: {
          type: 'string',
          description: 'The message to send to the agent'
        },
        session_id: {
          type: 'string',
          description: 'Optional session ID to continue a previous conversation with this agent'
        },
        from: {
          type: 'string',
          description: 'Optional sender name to identify yourself to the receiving agent'
        }
      },
      required: ['agent_name_or_id', 'message']
    }
  }
];

/**
 * Tool executor for Claude Agent SDK
 */
export async function executeInterAgentTool(
  toolName: string,
  params: any
): Promise<string> {
  switch (toolName) {
    case 'list_agents':
      return await listAgents(params);
    case 'talk_to_agent':
      return await talkToAgent(params);
    default:
      return `Error: Unknown tool "${toolName}"`;
  }
}
