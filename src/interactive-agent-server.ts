// SPDX-License-Identifier: MIT
import express from 'express';
import { EventEmitter } from 'events';
import { NewsItem } from './agent-rest-server.js';
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

export class InteractiveAgentServer extends EventEmitter {
  private app: express.Application;
  private newsItems: NewsItem[] = [];
  private pendingQueries: Map<string, PendingQuery> = new Map();
  private maxNewsItems: number = 100;
  private newsCleanupInterval: NodeJS.Timeout;
  private db: Db | undefined;
  private dbTeamId: string | undefined;
  private dbAgentId: string | undefined;

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
            path: '/schedule',
            method: 'POST',
            description: `Enqueue internal scheduled work for agent ${this.name}`
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
          }
        ]
      });
    });

    // Talk endpoint - moved to daemon (:4100/talk). The CLI is a read-only
    // view of the manager inbox; callers must post to the daemon so messages
    // persist even when the CLI REPL isn't running.
    this.app.post('/talk', (req, res) => {
      res.setHeader('Location', 'http://127.0.0.1:4100/talk');
      res.status(410).json({
        error: 'gone',
        message: 'POST /talk moved to the manager daemon. Use http://127.0.0.1:4100/talk instead.',
      });
    });

    // Schedule endpoint - moved to daemon (:4100/schedule).
    this.app.post('/schedule', (req, res) => {
      res.setHeader('Location', 'http://127.0.0.1:4100/schedule');
      res.status(410).json({
        error: 'gone',
        message: 'POST /schedule moved to the manager daemon. Use http://127.0.0.1:4100/schedule instead.',
      });
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
          const rows = await this.db.news.poll(this.dbAgentId, since, {
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

    // POST /news - moved to daemon. Agents post replies/messages to
    // :4100/news which writes to the shared DB under the manager's
    // interactive-agent id; the REPL surfaces them via the existing
    // daemon-backed /news poll and the DB-backed pending-question poll.
    this.app.post('/news', (req, res) => {
      res.setHeader('Location', 'http://127.0.0.1:4100/news');
      res.status(410).json({
        error: 'gone',
        message: 'POST /news moved to the manager daemon. Use http://127.0.0.1:4100/news instead.',
      });
    });
  }
  
  // Get pending queries for the CLI
  async getPendingQueries(): Promise<PendingQuery[]> {
    if (this.db && this.dbTeamId && this.dbAgentId) {
      const rows = await this.db.queries.getPending(this.dbAgentId);
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
      this.app.listen(this.port, '127.0.0.1', () => {
        resolve();
      });
    });
  }

  // Get recent news items (for CLI display). Reads from the daemon-owned
  // DB when configured so the REPL surfaces messages even if the CLI
  // wasn't running when they arrived; falls back to in-memory otherwise.
  async getNewsItems(limit: number = 20): Promise<NewsItem[]> {
    if (this.db && this.dbTeamId && this.dbAgentId) {
      const rows = await this.db.news.poll(this.dbAgentId, 0, { limit: Math.max(limit * 4, 100) });
      const items: NewsItem[] = rows.map((r) => ({
        type: r.type,
        timestamp: Number(r.timestamp),
        message: r.message || undefined,
        data: r.data || undefined,
      }));
      items.sort((a, b) => b.timestamp - a.timestamp);
      return items.slice(0, limit);
    }
    const sorted = [...this.newsItems].sort((a, b) => b.timestamp - a.timestamp);
    return sorted.slice(0, limit);
  }
}
