// SPDX-License-Identifier: MIT
/**
 * Messaging Service - Agent communication operations
 *
 * Implements REST-AP protocol for agent-to-agent and user-to-agent messaging.
 * - /talk: Send message (async, returns query_id)
 * - /news: Poll for responses (free, no LLM cost)
 */

import type {
  OperationResult,
  NewsItem,
  SendMessageOptions,
  SendMessageResult,
  PollNewsOptions
} from './types.js';

// ==================== News Trigger Default ====================

/**
 * Decide whether an inbound /news item should wake the receiver's LLM.
 *
 * Replies (those carrying `in_reply_to`) default to trigger=true so the
 * receiver auto-wakes when its /talk-to wait has already timed out and it
 * is no longer actively polling. Callers can opt out by passing
 * `trigger: false` explicitly.
 */
export function resolveNewsTrigger(input: {
  in_reply_to?: string | null;
  trigger?: boolean | null;
}): boolean {
  if (typeof input.trigger === 'boolean') return input.trigger;
  return !!input.in_reply_to;
}

// ==================== Send Message ====================

/**
 * Send a message to an agent via /talk endpoint
 * Returns a query_id that can be used to poll for responses
 */
export async function sendMessage(
  agentUrl: string,
  options: SendMessageOptions
): Promise<OperationResult<SendMessageResult>> {
  try {
    const response = await fetch(`${agentUrl}/talk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: options.message,
        session_id: options.sessionId,
        from: options.from || 'manager'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to send message: ${error}` };
    }

    const data: any = await response.json();
    return {
      success: true,
      data: {
        queryId: data.query_id || data.queryId,
        status: data.status || 'pending'
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Poll News ====================

/**
 * Poll for responses from an agent via /news endpoint
 * This is free and doesn't incur LLM costs
 */
export async function pollNews(
  agentUrl: string,
  options: PollNewsOptions = {}
): Promise<OperationResult<NewsItem[]>> {
  try {
    const params = new URLSearchParams();
    if (options.since !== undefined) {
      params.set('since', String(options.since));
    }
    if (options.limit !== undefined) {
      params.set('limit', String(options.limit));
    }
    if (options.queryId) {
      params.set('query_id', options.queryId);
    }

    const url = `${agentUrl}/news${params.toString() ? `?${params}` : ''}`;
    const response = await fetch(url);

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to poll news: ${error}` };
    }

    const data: any = await response.json();
    return { success: true, data: data.items || data.news || [] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Wait for Response ====================

/**
 * Wait for a specific query to complete by polling /news
 * Returns the response items when the query is done
 */
export async function waitForResponse(
  agentUrl: string,
  queryId: string,
  maxAttempts: number = 60,
  intervalMs: number = 1000
): Promise<OperationResult<NewsItem[]>> {
  try {
    for (let i = 0; i < maxAttempts; i++) {
      const result = await pollNews(agentUrl, { queryId });

      if (!result.success) {
        return result;
      }

      // Check if we have any response items for this query
      const items = result.data || [];
      const responseItems = items.filter(
        item => item.type === 'response' || item.type === 'error'
      );

      if (responseItems.length > 0) {
        return { success: true, data: responseItems };
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    return { success: false, error: 'Timeout waiting for response' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Broadcast ====================

/**
 * Broadcast a message to all agents via the manager
 */
export async function broadcastMessage(
  managerUrl: string,
  message: string,
  teamName?: string
): Promise<OperationResult<{ sent: number; failed: number }>> {
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (teamName) {
      headers['X-Id-Team'] = teamName;
    }

    const response = await fetch(`${managerUrl}/broadcast`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message })
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to broadcast: ${error}` };
    }

    const data: any = await response.json();
    return {
      success: true,
      data: {
        sent: data.sent || 0,
        failed: data.failed || 0
      }
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Reply to Query ====================

/**
 * Send a reply to a specific query (agent-to-agent communication)
 */
export async function replyToQuery(
  agentUrl: string,
  queryId: string,
  message: string,
  from?: string
): Promise<OperationResult<void>> {
  try {
    const response = await fetch(`${agentUrl}/news`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query_id: queryId,
        message,
        from: from || 'unknown',
        type: 'response'
      })
    });

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error: `Failed to reply: ${error}` };
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ==================== Send and Wait ====================

/**
 * Convenience function: send a message and wait for the response
 */
export async function sendAndWait(
  agentUrl: string,
  message: string,
  options: {
    sessionId?: string;
    from?: string;
    maxWaitMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<OperationResult<NewsItem[]>> {
  // Send the message
  const sendResult = await sendMessage(agentUrl, {
    message,
    sessionId: options.sessionId,
    from: options.from
  });

  if (!sendResult.success) {
    return { success: false, error: sendResult.error };
  }

  const queryId = sendResult.data!.queryId;
  const maxAttempts = Math.ceil((options.maxWaitMs || 60000) / (options.pollIntervalMs || 1000));

  // Wait for response
  return waitForResponse(agentUrl, queryId, maxAttempts, options.pollIntervalMs || 1000);
}
