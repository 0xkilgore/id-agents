// SPDX-License-Identifier: MIT
import express from 'express';
import { EventEmitter } from 'events';
import { NewsItem } from './claude-agent-server.js';
import type { Db } from './db/db-service.js';

export interface IncomingReply {
  type: string;
  from: string;
  in_reply_to: string;
  message: string;
  timestamp: number;
  sessionId?: string;
  to?: string;  // Intended recipient (for filtering inter-agent replies)
}

interface PendingQuery {
  query_id: string;
  message: string;
  timestamp: number;
  responded: boolean;
  from?: string;
  reply_endpoint?: string;
}

// Command handler function type - receives command and returns response
export type CommandHandler = (command: string, from?: string) => Promise<{ success: boolean; result?: string; error?: string }>;

// API key validator function type
export type ApiKeyValidator = (key: string | undefined) => boolean;

export class InteractiveAgentServer extends EventEmitter {
  private app: express.Application;
  private newsItems: NewsItem[] = [];
  private pendingQueries: Map<string, PendingQuery> = new Map();
  private maxNewsItems: number = 100;
  private newsCleanupInterval: NodeJS.Timeout;
  private db: Db | undefined;
  private dbTeamId: string | undefined;
  private dbAgentId: string | undefined;
  private commandHandler: CommandHandler | undefined;
  private apiKeyValidator: ApiKeyValidator | undefined;

  constructor(private name: string, private port: number = 4000) {
    super();
    this.app = express();
    // Configure JSON parser with error handling
    this.app.use(express.json({ 
      strict: true,
      limit: '10mb'
    }));
    
    // Error handling middleware for JSON parsing errors
    this.app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof SyntaxError && 'body' in err) {
        console.error(`[${this.name}] JSON parse error:`, err.message);
        return res.status(400).json({ 
          error: 'Invalid JSON', 
          details: err.message 
        });
      }
      next(err);
    });
    
    this.setupRoutes();
    
    // Periodically clean up old news items
    this.newsCleanupInterval = setInterval(() => {
      if (this.newsItems.length > this.maxNewsItems) {
        this.newsItems.sort((a, b) => b.timestamp - a.timestamp);
        this.newsItems = this.newsItems.slice(0, this.maxNewsItems);
      }
    }, 5 * 60 * 1000);
  }

  setDbConfig(cfg: { db: Db; teamId: string; agentId: string }) {
    this.db = cfg.db;
    this.dbTeamId = cfg.teamId;
    this.dbAgentId = cfg.agentId;
  }

  /**
   * Set a command handler for processing CLI commands received via /talk
   * Commands are messages starting with '/'
   */
  setCommandHandler(handler: CommandHandler) {
    this.commandHandler = handler;
  }

  /**
   * Set an API key validator for admin authentication
   * Required for command execution
   */
  setApiKeyValidator(validator: ApiKeyValidator) {
    this.apiKeyValidator = validator;
  }

  private async dbAddNews(item: NewsItem) {
    if (!this.db || !this.dbTeamId || !this.dbAgentId) return;
    const queryId = item.data?.query_id;
    await this.db.news.add(this.dbTeamId, this.dbAgentId, {
      timestamp: item.timestamp,
      type: item.type,
      message: item.message || undefined,
      data: item.data ?? undefined,
      query_id: queryId ?? undefined,
    });
  }

  private async dbUpsertQuery(params: {
    queryId: string;
    status: string;
    created: number;
    completed?: number;
    prompt?: string;
    result?: any;
    error?: string;
    sessionId?: string;
  }) {
    if (!this.db || !this.dbTeamId || !this.dbAgentId) return;
    await this.db.queries.upsert(this.dbTeamId, this.dbAgentId, {
      query_id: params.queryId,
      status: params.status,
      prompt: params.prompt ?? null,
      created: params.created,
      completed: params.completed ?? null,
      result: params.result ?? null,
      error: params.error ?? null,
      session_id: params.sessionId ?? null,
    });
  }
  
  private setupRoutes() {
    // REST-AP discovery
    this.app.get('/.well-known/restap.json', (req, res) => {
      res.json({
        restap_version: '1.0',
        agent: {
          name: this.name,
          description: `Agent ${this.name} - responses provided interactively`,
          contact: `${this.name}@localhost`
        },
        endpoints: [
          {
            path: '/talk',
            method: 'POST',
            description: `Send a message or question to agent ${this.name} (triggers processing)`
          },
          {
            path: '/news',
            method: 'GET',
            description: `Poll for responses from agent ${this.name}`
          },
          {
            path: '/news',
            method: 'POST',
            description: `Receive messages/replies from other agents (no processing, prevents loops)`
          },
          {
            path: '/remote',
            method: 'POST',
            description: `Execute CLI commands remotely (requires API key authentication)`,
            auth: 'api_key'
          }
        ]
      });
    });

    // Remote command endpoint - admin only, requires API key
    this.app.post('/remote', async (req, res) => {
      try {
        const { command, from } = req.body || {};

        if (!command || typeof command !== 'string') {
          return res.status(400).json({ error: 'Command is required' });
        }

        // Check if command handler is set
        if (!this.commandHandler) {
          return res.status(501).json({ error: 'Command handler not configured' });
        }

        console.log(`[${this.name}] Remote command from ${from || 'admin'}: ${command.slice(0, 100)}${command.length > 100 ? '...' : ''}`);

        // Execute the command
        const result = await this.commandHandler(command, from);

        // Log the result to news feed
        const ts = Date.now();
        const newsItem: NewsItem = {
          timestamp: ts,
          type: 'remote.command',
          message: `Remote command: ${command.slice(0, 50)}${command.length > 50 ? '...' : ''}`,
          data: {
            command,
            from: from || 'admin',
            success: result.success,
            result: result.result,
            error: result.error
          }
        };
        this.newsItems.push(newsItem);
        this.dbAddNews(newsItem).catch(() => {});

        if (result.success) {
          res.json({
            success: true,
            result: result.result,
            timestamp: ts
          });
        } else {
          res.status(400).json({
            success: false,
            error: result.error,
            timestamp: ts
          });
        }
      } catch (error) {
        console.error(`[${this.name}] Error in /remote:`, error);
        res.status(500).json({
          error: 'Internal server error',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // Talk endpoint - receive messages from agents
    this.app.post('/talk', (req, res) => {
      try {
        const { message, session_id, from, reply_endpoint } = req.body;

        if (!message) {
          return res.status(400).json({ error: 'Message is required' });
        }

        // Ensure message is a string (handle any type safely)
        const messageStr = typeof message === 'string' ? message : String(message);

        const query_id = `query_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        const ts = Date.now();

        // Store as pending query (include sender info and reply_endpoint if provided)
        this.pendingQueries.set(query_id, {
          query_id,
          message: messageStr,
          timestamp: ts,
          responded: false,
          from: typeof from === 'string' ? from : undefined,
          reply_endpoint: typeof reply_endpoint === 'string' ? reply_endpoint : undefined
        });
        
        // Return immediate acknowledgment
        res.status(202).json({
          status: 'pending',
          query_id,
          message: `Your message has been sent to agent ${this.name}. Please poll /news for the response.`
        });
        
        // Persist query + news (best-effort; don't block response)
        const fromStr = typeof from === 'string' ? from : undefined;
        const replyEndpointStr = typeof reply_endpoint === 'string' ? reply_endpoint : undefined;
        this.dbUpsertQuery({
          queryId: query_id,
          status: 'pending',
          created: ts,
          prompt: messageStr,
          sessionId: session_id || undefined,
          result: { from: fromStr, message: messageStr, session_id: session_id || undefined, reply_endpoint: replyEndpointStr }
        }).catch(() => {});

        const newsItem: NewsItem = {
          timestamp: ts,
          type: 'query.received',
          message: fromStr ? `Query ${query_id} received from ${fromStr}` : `Query ${query_id} received`,
          data: {
            query_id,
            message: messageStr,
            session_id: session_id || undefined,
            from: fromStr,
            status: 'awaiting_response'
          }
        };
        this.newsItems.push(newsItem);
        this.dbAddNews(newsItem).catch(() => {});
      } catch (error) {
        console.error(`[${this.name}] Error processing /talk request:`, error);
        return res.status(500).json({ 
          error: 'Internal server error',
          details: error instanceof Error ? error.message : String(error)
        });
      }
    });
    
    // News endpoint - poll for updates
    this.app.get('/news', (req, res) => {
      const since = parseInt(req.query.since as string) || 0;
      const limit = parseInt(req.query.limit as string) || undefined;
      const chars_start = parseInt(req.query.chars_start as string);
      const chars_end = parseInt(req.query.chars_end as string);
      const query_id = req.query.query_id as string | undefined;
      
      const run = async () => {
        let recentNews: NewsItem[] = [];

        if (this.db && this.dbTeamId && this.dbAgentId) {
          const rows = await this.db.news.poll(this.dbTeamId, this.dbAgentId, since, {
            limit: 1000,
            queryId: query_id,
          });
          recentNews = rows.map((r) => ({
            type: r.type,
            timestamp: Number(r.timestamp),
            message: r.message || undefined,
            data: r.data || undefined,
          }));
        } else {
          recentNews = this.newsItems.filter(item => item.timestamp > since);
          if (query_id) {
            recentNews = recentNews.filter(item => item.data?.query_id === query_id);
          }
          recentNews.sort((a, b) => b.timestamp - a.timestamp);
        }
      
      // Limit by character range if specified (backwards-looking: 0 = newest)
      if (!isNaN(chars_start) && !isNaN(chars_end) && chars_start >= 0 && chars_end > chars_start) {
        let cumulativeChars = 0;
        const rangedNews: NewsItem[] = [];
        
        for (const item of recentNews) {
          const itemChars = JSON.stringify(item).length;
          const itemStart = cumulativeChars;
          const itemEnd = cumulativeChars + itemChars;
          
          // Check if this item overlaps with the requested range
          // Range is [chars_start, chars_end), backwards from newest (position 0)
          if (itemEnd > chars_start && itemStart < chars_end) {
            rangedNews.push(item);
          }
          
          cumulativeChars = itemEnd;
          
          // Stop if we've passed the end of the requested range
          if (itemStart >= chars_end) {
            break;
          }
        }
        
        recentNews = rangedNews;
      } else if (limit && limit > 0) {
        // Fall back to item count limit if no character range
        recentNews = recentNews.slice(0, limit);
      }
      
        res.json({
          items: recentNews,
          timestamp: Date.now(),
          total: recentNews.length
        });
      };

      run().catch((e) => res.status(500).json({ error: e?.message || String(e) }));
    });

    // POST /news - receive messages/replies from other agents (no processing)
    this.app.post('/news', async (req, res) => {
      try {
        const { type, from, message, in_reply_to, data, to } = req.body;
        // 'to' can be at top level (if manager spreads ...data) or in data.to
        const intendedRecipient = to || data?.to;

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || (data?.message) || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Add to news feed
        const newsItem: NewsItem = {
          type: newsType,
          timestamp: ts,
          message: newsMessage,
          data: {
            from: from || undefined,
            in_reply_to: in_reply_to || undefined,
            message: message || undefined,
            ...data
          }
        };
        this.newsItems.push(newsItem);
        await this.dbAddNews(newsItem);

        // Activity logged silently — view via /logs command

        // Filter out status updates and self-messages before emitting events
        // This prevents both the console output AND pending question creation for filtered messages
        //
        // Filter out:
        // 1. Messages from self (own outgoing messages echoing back)
        // 2. Status update types that are just broadcasts, not actual questions:
        //    - query.* types are status updates about query processing
        //    - outbound.* types are notifications about sent messages
        //    - response.* types are saved response notifications
        // 3. Messages that look like status updates by content (e.g., "Query xxx completed")
        const isFromSelf = from === this.name || from === 'manager';
        const statusTypes = ['query.received', 'query.completed', 'query.thinking',
          'query.tool_use', 'query.progress', 'query.failed', 'query.cancelled',
          'outbound.message', 'outbound.reply', 'outbound.broadcast', 'response.saved'];
        const isStatusUpdate = statusTypes.includes(newsType);
        const looksLikeStatus = /^Query\s+\S+\s+(completed|received|failed|cancelled)$/i.test(newsMessage);
        const shouldFilter = isFromSelf || isStatusUpdate || looksLikeStatus;

        // Emit event for the CLI to handle
        // For replies, only emit actual 'reply' type messages, not status updates
        // that happen to have in_reply_to set (like query.completed, outbound.reply)
        if (in_reply_to && newsType === 'reply') {
          const reply: IncomingReply = {
            type: newsType,
            from: from || 'unknown',
            in_reply_to: in_reply_to,
            message: message || '',
            timestamp: ts,
            sessionId: data?.sessionId || undefined,
            to: intendedRecipient || undefined
          };
          this.emit('reply', reply);
        } else if (!shouldFilter && !in_reply_to) {
          // It's a new message, not a reply - emit as incoming message
          // Only emit if it's not a filtered status/self message
          this.emit('message', {
            type: newsType,
            from: from || 'unknown',
            message: message || '',
            timestamp: ts
          });
        }

        // For the manager (interactive agent), create a pending question for NEW messages
        // (not replies) so they can reply using /1, /2, etc.
        // Replies are already shown via the 'reply' event handler above.
        if (from && newsMessage && !in_reply_to && !shouldFilter) {
          const replyQueryId = `query_${ts}_${Math.random().toString(36).substring(7)}`;

          // Add as pending query so manager can respond
          this.pendingQueries.set(replyQueryId, {
            query_id: replyQueryId,
            message: newsMessage,
            timestamp: ts,
            responded: false,
            from: from
          });

          // Persist to database
          this.dbUpsertQuery({
            queryId: replyQueryId,
            status: 'pending',
            created: ts,
            prompt: newsMessage,
            result: {
              from,
              message: newsMessage,
              original_type: newsType,
              in_reply_to: in_reply_to || undefined
            }
          }).catch(() => {});

          // Emit as pending question for CLI to display
          this.emit('pending_question', {
            query_id: replyQueryId,
            from: from,
            message: newsMessage,
            timestamp: ts,
            is_reply: !!in_reply_to,
            in_reply_to: in_reply_to
          });
        }

        res.status(201).json({
          success: true,
          type: newsType,
          timestamp: ts
        });
      } catch (err: any) {
        console.error(`[${this.name}] Error in POST /news:`, err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });
  }
  
  // Get pending queries for the CLI
  async getPendingQueries(): Promise<PendingQuery[]> {
    if (this.db && this.dbTeamId && this.dbAgentId) {
      const rows = await this.db.queries.getPending(this.dbTeamId, this.dbAgentId);
      return rows.map((row) => ({
        query_id: row.query_id,
        message: row.prompt || (row.result as any)?.message || '',
        timestamp: Number(row.created),
        responded: false,
        from: (row.result as any)?.from,
        reply_endpoint: (row.result as any)?.reply_endpoint,
      }));
    }
    return Array.from(this.pendingQueries.values()).filter(q => !q.responded);
  }
  
  // Respond to a query
  async respond(query_id: string, response: string) {
    const query = this.pendingQueries.get(query_id);
    const ts = Date.now();
    if (!query && !(this.db && this.dbTeamId && this.dbAgentId)) {
      throw new Error(`Query ${query_id} not found`);
    }
    
    if (query) {
      query.responded = true;
    }
    
    // Post response to news feed
    const item: NewsItem = {
      timestamp: ts,
      type: 'query.completed',
      data: {
        query_id,
        result: { result: response }
      }
    };
    this.newsItems.push(item);
    await this.dbAddNews(item);
    await this.dbUpsertQuery({
      queryId: query_id,
      status: 'completed',
      created: query?.timestamp || ts,
      completed: ts,
      prompt: query?.message,
      result: { result: response },
      sessionId: undefined
    });
    
    return true;
  }

  // Record an outbound message in our own news feed for conversation history
  async recordOutboundMessage(params: {
    to: string;
    message: string;
    queryId?: string;
    type?: 'message' | 'broadcast';
  }) {
    const ts = Date.now();
    const newsType = params.type === 'broadcast' ? 'outbound.broadcast' : 'outbound.message';
    const item: NewsItem = {
      timestamp: ts,
      type: newsType,
      message: `Sent ${params.type || 'message'} to ${params.to}`,
      data: {
        to: params.to,
        message: params.message,
        query_id: params.queryId
      }
    };
    this.newsItems.push(item);
    await this.dbAddNews(item);
  }

  start() {
    return new Promise<void>((resolve) => {
      this.app.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  // Get recent news items (for CLI display)
  getNewsItems(limit: number = 20): NewsItem[] {
    const sorted = [...this.newsItems].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, limit);
  }
}
