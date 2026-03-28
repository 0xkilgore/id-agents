// SPDX-License-Identifier: MIT
/**
 * Claude Agent REST-AP Server
 * 
 * Runs a Claude Agent as a REST-AP provider that other agents can call.
 * The Claude agent has full machine access and exposes /talk, /news, and /.well-known/restap.json
 */

import express from 'express';
import fetch from 'node-fetch';
import { createHarness, HarnessType, AgentHarness } from './harness/index.js';
import { CLAUDE_MODELS } from './harness/claude-agent-sdk.js';
import { withInterAgentSkill } from './inter-agent-skill.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import type http from 'http';
import type { Db } from './db/db-service.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get timestamp for logging (HH:MM:SS.mmm format)
 */
function logTime(): string {
  const now = new Date();
  return `[${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}]`;
}

/**
 * Detect API-related errors and return a helpful message
 */
function getApiErrorHelp(errorMessage: string, harnessType: HarnessType = 'claude-agent-sdk'): { isApiError: boolean; helpMessage: string } {
  const msg = errorMessage.toLowerCase();

  // Credit/billing issues
  if (msg.includes('credit balance') || msg.includes('insufficient') || msg.includes('billing')) {
    return {
      isApiError: true,
      helpMessage: '💳 API Credit Issue: Your Anthropic API credit balance is too low.\n' +
        '   → Visit https://console.anthropic.com to add credits.\n' +
        '   → Agents will resume working once credits are added.'
    };
  }

  // Invalid API key
  if (msg.includes('invalid api key') || msg.includes('authentication') || msg.includes('unauthorized') || msg.includes('401')) {
    return {
      isApiError: true,
      helpMessage: '🔑 API Key Issue: Your Anthropic API key is invalid or expired.\n' +
        '   → Check your ANTHROPIC_API_KEY environment variable.\n' +
        '   → Generate a new key at https://console.anthropic.com/settings/keys'
    };
  }

  // Rate limiting
  if (msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('429')) {
    return {
      isApiError: true,
      helpMessage: '⏱️  Rate Limited: Too many API requests.\n' +
        '   → Wait a few moments and try again.\n' +
        '   → Consider using a model with higher rate limits.'
    };
  }

  // Overloaded
  if (msg.includes('overloaded') || msg.includes('503') || msg.includes('service unavailable')) {
    return {
      isApiError: true,
      helpMessage: '🔄 API Overloaded: The Anthropic API is temporarily overloaded.\n' +
        '   → Wait a few moments and try again.\n' +
        '   → Check https://status.anthropic.com for service status.'
    };
  }

  // Agent process exit
  if (msg.includes('exited with code 1') || msg.includes('process exited')) {
    return {
      isApiError: true,
      helpMessage: `⚠️  Claude Code Error: The agent process exited unexpectedly.\n` +
        '   → This often indicates an API issue (credits, key, or rate limits).\n' +
        '   → Check your API status at https://console.anthropic.com'
    };
  }

  // Content filtering - session should be cleared
  if (msg.includes('content filter') || msg.includes('blocked') || msg.includes('filtering policy')) {
    return {
      isApiError: true,
      helpMessage: '🚫 Content Filter: Output was blocked by content filtering policy.\n' +
        '   → The session context may have triggered the filter.\n' +
        '   → Session has been cleared - next request will start fresh.'
    };
  }

  return { isApiError: false, helpMessage: '' };
}

/**
 * Check if an error is a content filter error that requires session clearing
 */
function isContentFilterError(errorMessage: string): boolean {
  const msg = errorMessage.toLowerCase();
  return msg.includes('content filter') ||
         msg.includes('blocked') ||
         msg.includes('filtering policy') ||
         msg.includes('output blocked');
}

export interface NewsItem {
  type: string;
  timestamp: number;
  message?: string;
  data?: any;
}

interface ActiveQuery {
  id: string;
  prompt: string;
  status: 'processing' | 'completed' | 'failed';
  result?: any;
  error?: string;
  created: number;
  completed?: number;
}

// Waiter for replies to outbound messages (used by /talk-to endpoint)
// Waiters persist until reply arrives - timeout only affects HTTP response
interface ReplyWaiter {
  queryId: string;
  resolve: (reply: { from: string; message: string; timestamp: number }) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout | null;
}

export class ClaudeAgentServer {
  private app: express.Application;
  private newsItems: NewsItem[] = [];
  private activeQueries: Map<string, ActiveQuery> = new Map();
  private lastSessionId?: string;  // Persisted session ID for conversation continuity
  private pendingReplyWaiters: Map<string, ReplyWaiter> = new Map(); // queryId -> waiter
  private model: string;

  // Agent catalog - dynamic fields agents can update themselves
  // These are exposed in /.well-known/restap.json
  private catalog: {
    description?: string;      // What this agent does
    role?: string;             // Assigned role (developer, researcher, pm, etc.)
    expertise?: string[];      // Skills/capabilities (typescript, react, etc.)
    status?: string;           // Current status (available, busy, offline)
    currentTask?: string;      // What they're currently working on
    [key: string]: any;        // Allow custom fields
  } = {};
  private workingDirectory: string;
  private sharedDirectory: string;
  private allowedTools: string[];
  private agentName: string | undefined;
  private agentIdentity: { name?: string; team?: string; metadata?: any; tokenId?: string; domain?: string } | undefined;
  private maxNewsItems: number = 100; // Keep last 100 news items
  private newsCleanupInterval: NodeJS.Timeout;
  private httpServer: http.Server | undefined;

  // Query queue - serializes query processing to prevent concurrent harness execution
  private queryQueue: Array<{
    queryId: string;
    prompt: string;
    resume?: string;
    from?: string;
    options?: { noAutoReply?: boolean };
  }> = [];
  private isProcessingQuery: boolean = false;
  private db: Db | undefined;
  private dbTeamId: string | undefined;
  private dbAgentId: string | undefined;
  private harness: AgentHarness;
  private harnessType: HarnessType;

  constructor(options: {
    model?: string;
    workingDirectory?: string;
    sharedDirectory?: string;
    allowedTools?: string[];
    port?: number;
    agentName?: string;
    agentIdentity?: { name?: string; team?: string; network?: string; metadata?: any; tokenId?: string; domain?: string };
    db?: { db: Db; teamId: string; agentId: string };
  } = {}) {
    this.model = options.model || process.env.CLAUDE_MODEL || CLAUDE_MODELS.HAIKU;
    this.workingDirectory = options.workingDirectory || process.cwd();
    // Shared dir is team-scoped by the manager (e.g. /workspace/teams/<team>).
    // All agents in the same team share this directory.
    this.sharedDirectory = options.sharedDirectory || '/workspace/teams';
    this.allowedTools = options.allowedTools || ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
    this.agentName = options.agentName;
    this.agentIdentity = options.agentIdentity || (this.agentName ? { name: this.agentName } : undefined);
    this.db = options.db?.db;
    this.dbTeamId = options.db?.teamId;
    this.dbAgentId = options.db?.agentId;

    // Load catalog from agent metadata if available
    if (this.agentIdentity?.metadata?.catalog) {
      this.catalog = { ...this.agentIdentity.metadata.catalog };
    }

    // Initialize harness based on ID_HARNESS env var (defaults to 'claude-agent-sdk')
    this.harnessType = (process.env.ID_HARNESS || 'claude-agent-sdk') as HarnessType;
    this.harness = createHarness(this.harnessType);

    // Note: do NOT set process.env.AGENT_NAME here (shared process; multiple agents).

    this.app = express();
    this.app.use(express.json());

    // JSON parse error handler - log details for debugging
    this.app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof SyntaxError && 'body' in err) {
        console.error(`${logTime()} [Agent] JSON parse error on ${req.method} ${req.path}:`);
        console.error(`${logTime()} [Agent]   Error: ${err.message}`);
        // Log raw body if available (truncated for safety)
        const rawBody = (err as any).body;
        if (rawBody) {
          const preview = typeof rawBody === 'string' ? rawBody.slice(0, 200) : JSON.stringify(rawBody).slice(0, 200);
          console.error(`${logTime()} [Agent]   Body preview: ${preview}${preview.length >= 200 ? '...' : ''}`);
        }
        return res.status(400).json({ error: 'Invalid JSON', details: err.message });
      }
      next(err);
    });

    this.setupRoutes();
    
    // Periodically clean up old news items (every 5 minutes)
    this.newsCleanupInterval = setInterval(() => {
      if (this.newsItems.length > this.maxNewsItems) {
        // Sort by timestamp descending and keep only the newest items
        this.newsItems.sort((a, b) => b.timestamp - a.timestamp);
        this.newsItems = this.newsItems.slice(0, this.maxNewsItems);
      }
    }, 5 * 60 * 1000);
  }

  private async dbAddNews(type: string, message: string, data?: any) {
    if (!this.db || !this.dbTeamId || !this.dbAgentId) return;
    const queryId = data?.query_id;
    await this.db.news.add(this.dbTeamId, this.dbAgentId, {
      timestamp: Date.now(),
      type,
      message: message || undefined,
      data: data ?? undefined,
      query_id: queryId ?? undefined,
    });
  }

  private async dbUpsertQuery(query: ActiveQuery & { sessionId?: string }) {
    if (!this.db || !this.dbTeamId || !this.dbAgentId) return;
    await this.db.queries.upsert(this.dbTeamId, this.dbAgentId, {
      query_id: query.id,
      status: query.status,
      prompt: query.prompt,
      created: query.created,
      completed: query.completed ?? null,
      result: query.result ?? null,
      error: query.error ?? null,
      session_id: query.sessionId ?? null,
    });
  }

  private setupRoutes() {
    // Health check endpoint (no auth required)
    this.app.get('/health', (req, res) => {
      res.json({ status: 'ok', timestamp: Date.now(), agent: this.agentName });
    });

    // List files endpoint - JSON listing (use /files/list to avoid /files → /files/ redirects)
    this.app.get('/files/list', (req, res) => {
      const files: Array<{ name: string; path: string; size: number; modified: number }> = [];

      const addFilesFromDir = (dir: string, basePath: string = '') => {
        try {
          if (!fs.existsSync(dir)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });

          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

            try {
              const stats = fs.statSync(fullPath);
              if (stats.isFile()) {
                files.push({
                  name: entry.name,
                  path: relativePath,
                  size: stats.size,
                  modified: stats.mtimeMs
                });
              } else if (stats.isDirectory()) {
                addFilesFromDir(fullPath, relativePath);
              }
            } catch {
              // Skip files we can't access
            }
          }
        } catch {
          // Skip directories we can't read
        }
      };

      addFilesFromDir('/tmp', '');
      addFilesFromDir(this.workingDirectory, '');
      // Add files from shared directory (accessible to all agents)
      if (fs.existsSync(this.sharedDirectory)) {
        addFilesFromDir(this.sharedDirectory, 'shared');
      }

      const uniqueFiles = Array.from(new Map(files.map(f => [f.path, f])).values()).sort(
        (a, b) => b.modified - a.modified
      );

      res.setHeader('Content-Type', 'application/json');
      res.json({ files: uniqueFiles, count: uniqueFiles.length });
    });

    // List files endpoint - returns all available files (must be before static middleware)
    // Match requests to /files with Accept: application/json or no Accept header
    this.app.get('/files', (req, res, next) => {
      // Check if this is a listing request (exact /files path, not a file)
      const urlPath = req.url?.split('?')[0] || req.path;
      const acceptHeader = req.headers.accept || '';
      
      // Only handle if it's exactly /files and either no Accept header or Accept includes json
      // This distinguishes listing requests from file requests
      if (urlPath === '/files' && (!acceptHeader || acceptHeader.includes('application/json') || acceptHeader.includes('*/*'))) {
        // This is a listing request
      
      const files: Array<{ name: string; path: string; size: number; modified: number }> = [];
      
      // Helper to add files from a directory
      const addFilesFromDir = (dir: string, basePath: string = '') => {
        try {
          if (!fs.existsSync(dir)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
            
            try {
              const stats = fs.statSync(fullPath);
              if (stats.isFile()) {
                files.push({
                  name: entry.name,
                  path: relativePath,
                  size: stats.size,
                  modified: stats.mtimeMs
                });
              } else if (stats.isDirectory()) {
                // Recursively add files from subdirectories
                addFilesFromDir(fullPath, relativePath);
              }
            } catch (err) {
              // Skip files we can't access
            }
          }
        } catch (err) {
          // Skip directories we can't read
        }
      };
      
      // Add files from /tmp and working directory
      addFilesFromDir('/tmp', '');
      addFilesFromDir(this.workingDirectory, '');
      // Add files from shared directory (accessible to all agents)
      if (fs.existsSync(this.sharedDirectory)) {
        addFilesFromDir(this.sharedDirectory, 'shared');
      }
      
      // Remove duplicates (same name and size) and sort by modified time (newest first)
      const uniqueFiles = Array.from(
        new Map(files.map(f => [f.path, f])).values()
      ).sort((a, b) => b.modified - a.modified);
      
        res.setHeader('Content-Type', 'application/json');
        res.json({
          files: uniqueFiles,
          count: uniqueFiles.length
        });
        return; // Don't call next() - we've handled the request
      }
      
      // Otherwise, let static middleware handle it
      next();
    });
    
    // File upload endpoint - upload files to agent's workspace
    this.app.post('/files/upload', express.json({ limit: '50mb' }), (req, res) => {
      const { filename, content } = req.body;
      
      if (!filename || content === undefined) {
        return res.status(400).json({ error: 'Missing filename or content' });
      }
      
      try {
        // Sanitize filename - prevent directory traversal
        const safeFilename = path.basename(filename);
        const filePath = path.join(this.workingDirectory, safeFilename);
        
        // Ensure directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        // Write file
        fs.writeFileSync(filePath, content, 'utf8');
        
        res.json({
          success: true,
          filename: safeFilename,
          path: filePath,
          size: content.length
        });
      } catch (error: any) {
        res.status(500).json({ error: error.message });
      }
    });
    
    // Serve static files from /tmp, working directory, and team directory (with index disabled to prevent directory listings)
    this.app.use('/files', express.static('/tmp', { index: false }));
    this.app.use('/files', express.static(this.workingDirectory, { index: false }));
    // Serve team files at /files/teams/{filename} (and /files/shared for backwards compatibility)
    if (fs.existsSync(this.sharedDirectory)) {
      this.app.use('/files/teams', express.static(this.sharedDirectory, { index: false }));
      this.app.use('/files/shared', express.static(this.sharedDirectory, { index: false })); // backwards compatibility
    }
    
    // REST-AP discovery
    this.app.get('/.well-known/restap.json', (req, res) => {
      // Build agent identity from catalog and identity info
      const agentInfo: Record<string, any> = {
        name: this.agentIdentity?.name || this.agentName || 'Claude Agent',
        ...this.catalog  // Include all catalog fields (description, role, expertise, etc.)
      };

      // Add tokenId if available
      if (this.agentIdentity?.tokenId) {
        agentInfo.tokenId = this.agentIdentity.tokenId;
      }

      res.json({
        restap_version: '1.0',
        agent: agentInfo,
        provider: {
          name: 'Claude Agent SDK',
          version: '1.0'
        },
        endpoints: {
          talk: '/talk',
          news: '/news',
          news_post: '/news',
          catalog: '/catalog'
        },
        capabilities: [
          {
            id: 'talk',
            title: 'Talk to Claude',
            method: 'POST',
            endpoint: '/talk',
            description: 'Ask Claude to perform tasks with full tool access (Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch). Supports optional session_id for context continuity.',
            input_schema: {
              message: 'string (required)',
              session_id: 'string (optional) - session ID from previous query to maintain context'
            }
          },
          {
            id: 'news',
            title: 'Check for updates',
            method: 'GET',
            endpoint: '/news',
            description: 'Poll for task completion and results. Supports query parameters: since (timestamp), limit (item count), chars_start/chars_end (character range), query_id (filter by query). Use chars_start=0&chars_end=1000 to get the most recent 1000 characters, working backwards from newest (position 0).',
            input_schema: {
              since: 'number (optional) - timestamp to filter items after',
              limit: 'number (optional) - maximum number of items to return',
              chars_start: 'number (optional) - start position in character range (0 = newest)',
              chars_end: 'number (optional) - end position in character range (must be > chars_start)',
              query_id: 'string (optional) - filter items by specific query_id'
            }
          },
          {
            id: 'news_receive',
            title: 'Receive messages/replies',
            method: 'POST',
            endpoint: '/news',
            description: 'Receive messages or replies from other agents. Does NOT trigger LLM processing (prevents infinite loops). Used for direct reply delivery.',
            input_schema: {
              type: 'string (optional) - message type, e.g. "reply" or "message"',
              from: 'string (optional) - sender agent name',
              message: 'string (required) - the message content',
              in_reply_to: 'string (optional) - query_id this is replying to'
            }
          },
          {
            id: 'talk_to',
            title: 'Talk to another agent (synchronous)',
            method: 'POST',
            endpoint: '/talk-to',
            description: 'Send a message to another agent and wait for the reply. This endpoint blocks until the reply arrives or timeout (configurable per-agent via talkTimeout, default 2 min, max 10 min). No polling required - uses event-driven waiting.',
            input_schema: {
              to: 'string (required) - target agent name or id',
              message: 'string (required) - the message to send',
              timeout: 'number (optional) - max wait time in ms (default from agent config or 120000, max 600000)'
            }
          },
          {
            id: 'files',
            title: 'List and serve files',
            method: 'GET',
            endpoint: '/files',
            description: 'List all available files (GET /files) or access a specific file (GET /files/{filename}). Files in the working directory are served. For team files, use the shared team folder directly.'
          },
          {
            id: 'files_list',
            title: 'List files (JSON)',
            method: 'GET',
            endpoint: '/files/list',
            description: 'List all available files as JSON. Use this instead of GET /files to avoid redirects.'
          },
          {
            id: 'files_get',
            title: 'Get specific file',
            method: 'GET',
            endpoint: '/files/{filename}',
            description: 'Access a specific file from the agent working directory. For shared team files, read directly from the team folder.'
          },
          {
            id: 'files_upload',
            title: 'Upload file',
            method: 'POST',
            endpoint: '/files/upload',
            description: 'Upload a file to the agent\'s workspace. Body: { filename: string, content: string }'
          },
          {
            id: 'catalog',
            title: 'Update agent catalog',
            method: 'PATCH',
            endpoint: '/catalog',
            description: 'Update this agent\'s catalog fields (description, role, expertise, status, currentTask). Agents can update their own catalog to reflect their current state and capabilities.'
          }
        ]
      });
    });

    // GET /catalog - read current catalog
    this.app.get('/catalog', (req, res) => {
      res.json({
        name: this.agentIdentity?.name || this.agentName,
        tokenId: this.agentIdentity?.tokenId,
        ...this.catalog
      });
    });

    // PATCH /catalog - update agent catalog fields
    // Agents can update: description, role, expertise, status, currentTask, and custom fields
    this.app.patch('/catalog', async (req, res) => {
      const updates = req.body || {};

      // Update catalog with provided fields
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined) {
          delete this.catalog[key];
        } else {
          this.catalog[key] = value;
        }
      }

      // Sync to database if connected
      if (this.db && this.dbTeamId && this.dbAgentId) {
        try {
          // Read current metadata, merge catalog, then write back
          const agent = await this.db.agents.getById(this.dbAgentId);
          const merged = { ...(agent?.metadata || {}), catalog: this.catalog };
          await this.db.agents.updateMetadata(this.dbAgentId, merged);
        } catch (err: any) {
          console.error(`${logTime()} [Agent] Failed to sync catalog to database:`, err.message);
        }
      }

      console.log(`${logTime()} [Agent] 📋 Catalog updated:`, this.catalog);
      res.json({
        ok: true,
        catalog: {
          name: this.agentIdentity?.name || this.agentName,
          tokenId: this.agentIdentity?.tokenId,
          ...this.catalog
        }
      });
    });

    // Clear session endpoint - clears conversation context to recover from content filter errors
    this.app.post('/clear', (req, res) => {
      const oldSession = this.lastSessionId;
      this.lastSessionId = undefined;
      console.log(`${logTime()} [Agent] 🔄 Session cleared${oldSession ? ' (was: ' + oldSession.slice(0, 20) + '...)' : ''}`);
      res.json({
        ok: true,
        message: 'Session cleared - next query will start fresh',
        had_session: !!oldSession
      });
    });

    // Talk endpoint - universal string -> string (with optional session support)
    this.app.post('/talk', async (req, res) => {
      try {
        const { message, session_id, from } = req.body;

        if (!message) {
          return res.status(400).json({ error: 'Missing message' });
        }

        const queryId = `query_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

        // Add incoming message to news feed for complete history (best effort - don't fail if DB is down)
        try {
          await this.addNews('query.received', from ? `Query ${queryId} received from ${from}` : `Query ${queryId} received`, {
            query_id: queryId,
            message,
            session_id: session_id || undefined,
            from: from || undefined,
            status: 'processing'
          });
        } catch (newsErr: any) {
          console.error(`[Agent] Warning: Failed to persist news item for query ${queryId}:`, newsErr?.message || newsErr);
        }

        // Start query in background (with optional session for context continuity)
        this.startQuery(queryId, message, session_id, from);

        // Return 202 Accepted with job ID
        res.status(202).json({
          query_id: queryId,
          status: 'processing',
          message: 'Claude is working on your request. Poll /news for completion.'
        });
      } catch (err: any) {
        console.error(`${logTime()} [Agent] Error in /talk:`, err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Cancel endpoint - cancel the currently running query
    this.app.post('/cancel', async (req, res) => {
      try {
        // Check if harness supports cancellation
        if (typeof this.harness.cancel !== 'function') {
          return res.status(501).json({
            error: 'Cancellation not supported by this harness',
            harness: this.harnessType
          });
        }

        // Try to cancel the running process
        const cancelled = this.harness.cancel();

        if (cancelled) {
          // Find the currently processing query and mark it as cancelled
          const processingQuery = this.activeQueries.values().next().value;
          if (processingQuery && processingQuery.status === 'processing') {
            processingQuery.status = 'failed';
            processingQuery.error = 'Query was cancelled';

            // Add news item about cancellation
            await this.addNews('query.cancelled', 'Query was cancelled by user', {
              query_id: processingQuery.id
            });
          }

          console.log(`${logTime()} [Agent] Query cancelled`);
          res.json({
            cancelled: true,
            message: 'Query cancelled successfully'
          });
        } else {
          res.json({
            cancelled: false,
            message: 'No query was running'
          });
        }
      } catch (err: any) {
        console.error(`${logTime()} [Agent] Error in /cancel:`, err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
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

            if (itemEnd > chars_start && itemStart < chars_end) {
              rangedNews.push(item);
            }

            cumulativeChars = itemEnd;
            if (itemStart >= chars_end) break;
          }

          recentNews = rangedNews;
        } else if (limit && limit > 0) {
          recentNews = recentNews.slice(0, limit);
        }

        res.json({ items: recentNews, timestamp: Date.now(), total: recentNews.length });
      };

      run().catch((e) => res.status(500).json({ error: e?.message || String(e) }));
    });

    // POST /news - receive messages/replies from other agents
    // Can optionally trigger LLM processing with trigger=true
    this.app.post('/news', async (req, res) => {
      try {
        const { type, from, message, in_reply_to, data, trigger } = req.body;

        if (!message && !data) {
          return res.status(400).json({ error: 'Missing message or data' });
        }

        const newsType = type || (in_reply_to ? 'reply' : 'message');
        const newsMessage = message || (data?.message) || `${newsType} from ${from || 'unknown'}`;
        const ts = Date.now();

        // Add to news feed
        await this.addNews(newsType, newsMessage, {
          from: from || undefined,
          in_reply_to: in_reply_to || undefined,
          message: message || undefined,
          ...data
        });

        // Check if there's a pending waiter for this reply (from /talk-to)
        // If so, resolve the waiter immediately - no need to trigger LLM
        if (in_reply_to && this.pendingReplyWaiters.has(in_reply_to)) {
          const waiter = this.pendingReplyWaiters.get(in_reply_to)!;
          if (waiter.timeout) clearTimeout(waiter.timeout);
          this.pendingReplyWaiters.delete(in_reply_to);

          console.log(`${logTime()} [Agent] Received reply to ${in_reply_to} from ${from} - resolving waiter`);

          waiter.resolve({
            from: from || 'unknown',
            message: newsMessage,
            timestamp: ts
          });

          return res.status(201).json({
            success: true,
            type: newsType,
            timestamp: ts,
            waiter_resolved: true
          });
        }

        console.log(`${logTime()} [Agent] Received ${newsType}${from ? ` from ${from}` : ''}${in_reply_to ? ` (reply to ${in_reply_to})` : ''}${trigger ? ' (triggering LLM)' : ''}`);

        // If trigger is true, process the message with the LLM
        if (trigger && from) {
          const queryId = `news_${ts}_${Math.random().toString(36).substring(7)}`;

          // Craft a prompt that prevents infinite loops
          const triggerPrompt = this.craftNewsTriggerPrompt(from, newsMessage, in_reply_to);

          // Start processing in background (don't block the response)
          // Pass from so agent knows who sent it, but noAutoReply to prevent infinite loops
          this.startQuery(queryId, triggerPrompt, undefined, from, { noAutoReply: true });

          res.status(202).json({
            success: true,
            type: newsType,
            timestamp: ts,
            triggered: true,
            query_id: queryId
          });
        } else {
          res.status(201).json({
            success: true,
            type: newsType,
            timestamp: ts,
            triggered: false
          });
        }
      } catch (err: any) {
        console.error(`${logTime()} [Agent] Error in POST /news:`, err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });

    // Status endpoint - check query status
    this.app.get('/query/:id', (req, res) => {
      const run = async () => {
        const qid = req.params.id;
        if (this.db && this.dbTeamId && this.dbAgentId) {
          const q = await this.db.queries.getById(this.dbAgentId, qid);
          if (!q) return res.status(404).json({ error: 'Query not found' });
          return res.json({
            id: q.query_id,
            prompt: q.prompt,
            status: q.status,
            result: q.result,
            error: q.error,
            created: Number(q.created),
            completed: q.completed ? Number(q.completed) : undefined,
            sessionId: q.session_id || undefined
          });
        }

        const query = this.activeQueries.get(qid);
        if (!query) return res.status(404).json({ error: 'Query not found' });
        res.json(query);
      };

      run().catch((e) => res.status(500).json({ error: e?.message || String(e) }));
    });

    // Talk-to endpoint - send message to another agent and wait for reply (event-driven)
    // This endpoint blocks until the reply arrives or timeout (default 2 min, max 10 min)
    // INTERNAL ONLY - only accessible from localhost (agent's own LLM)
    this.app.post('/talk-to', async (req, res) => {
      try {
        // Security: Only allow internal requests (from localhost)
        const remoteAddr = req.ip || req.socket.remoteAddress || '';
        const isLocalhost = remoteAddr === '127.0.0.1' ||
                           remoteAddr === '::1' ||
                           remoteAddr === '::ffff:127.0.0.1' ||
                           remoteAddr === 'localhost';

        if (!isLocalhost) {
          console.log(`${logTime()} [Agent] Rejected /talk-to from external address: ${remoteAddr}`);
          return res.status(403).json({
            error: 'Forbidden - /talk-to is internal only. Use /talk for external requests.'
          });
        }

        const { to, message, timeout: requestTimeout } = req.body;

        if (!to || !message) {
          return res.status(400).json({ error: 'Missing "to" (agent name) or "message"' });
        }

        // Timeout: use request timeout, then agent config, then default 2 min, max 10 min
        const defaultTimeout = parseInt(process.env.ID_TALK_TIMEOUT || '120000', 10) || 120000;
        const timeoutMs = Math.min(requestTimeout || defaultTimeout, 600000);
        const myDisplayId = this.getDisplayId();

        // Look up target agent via manager
        const managerUrl = process.env.MANAGER_URL || 'http://id-agent-manager:4100';
        const team = this.agentIdentity?.team || process.env.ID_TEAM || process.env.ID_PROJECT || '';
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (team) {
          headers['X-Id-Team'] = team;
          headers['X-Id-Project'] = team; // backwards compatibility
        }

        const agentsRes = await fetch(`${managerUrl}/agents`, { headers });
        if (!agentsRes.ok) {
          return res.status(502).json({ error: `Failed to fetch agents list: ${agentsRes.status}` });
        }

        const agentsData = await agentsRes.json() as { agents: Array<{ name: string; id: string; alias?: string; displayId?: string; internal_url?: string; url?: string }> };
        // Match by name (displayId), alias, id, or displayId field (e.g., "agent.20" or "agent")
        const targetAgent = agentsData.agents?.find(a => a.name === to || a.alias === to || a.id === to || a.displayId === to);

        if (!targetAgent) {
          return res.status(404).json({ error: `Agent "${to}" not found` });
        }

        const targetUrl = targetAgent.internal_url || targetAgent.url;
        if (!targetUrl) {
          return res.status(404).json({ error: `No URL for agent "${to}"` });
        }

        // Send message to target agent
        const talkHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        const talkRes = await fetch(`${targetUrl}/talk`, {
          method: 'POST',
          headers: talkHeaders,
          body: JSON.stringify({ message, from: myDisplayId })
        });

        if (!talkRes.ok) {
          const errText = await talkRes.text().catch(() => talkRes.statusText);
          return res.status(502).json({ error: `Failed to send message to ${to}: ${errText}` });
        }

        const talkData = await talkRes.json() as { query_id: string };
        const queryId = talkData.query_id;

        console.log(`${logTime()} [Agent] 📤 Sent message to ${to}, waiting for reply (query: ${queryId}, timeout: ${timeoutMs}ms)`);

        // Record outbound message in our news feed
        await this.addNews('outbound.message', `Sent message to ${to}`, {
          to,
          message,
          query_id: queryId
        });

        // Create a waiter that persists until reply arrives
        // Timeout only affects HTTP response, not the waiter itself
        let httpTimedOut = false;
        let timeoutHandle: NodeJS.Timeout | null = null;

        const replyPromise = new Promise<{ from: string; message: string; timestamp: number }>((resolve) => {
          // Store the waiter - it persists until reply arrives
          this.pendingReplyWaiters.set(queryId, {
            queryId,
            resolve,
            reject: () => {}, // Never used - waiters don't expire
            timeout: null
          });

          // HTTP timeout - only affects how long this request blocks
          timeoutHandle = setTimeout(() => {
            httpTimedOut = true;
            // Don't delete waiter - it persists for when reply eventually arrives
            resolve({ from: '', message: '', timestamp: 0 }); // Resolve with empty to unblock
          }, timeoutMs);
        });

        // Wait for the reply (or HTTP timeout)
        const reply = await replyPromise;

        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }

        if (httpTimedOut) {
          // HTTP timed out but waiter persists - reply will be captured when it arrives
          console.log(`${logTime()} [Agent] ⏱️ HTTP timeout for ${to} (${timeoutMs}ms) - waiter persists for query ${queryId}`);
          return res.json({
            success: false,
            from: to,
            query_id: queryId,
            message: `Request timed out after ${timeoutMs}ms - reply will be captured when it arrives`,
            status: 'pending'
          });
        }

        console.log(`${logTime()} [Agent] 📬 Received reply from ${reply.from} for query ${queryId}`);

        res.json({
          success: true,
          from: reply.from,
          reply: reply.message,
          query_id: queryId
        });

      } catch (err: any) {
        console.error(`${logTime()} [Agent] Error in /talk-to:`, err?.message || err);
        res.status(500).json({
          error: err?.message || 'Internal server error'
        });
      }
    });

    // Identity update endpoint - called by manager after onchain registration
    this.app.patch('/identity', express.json({ limit: '10kb' }), (req, res) => {
      try {
        const { tokenId, metadata, domain } = req.body;

        if (!tokenId && !metadata && !domain) {
          return res.status(400).json({ error: 'No identity fields provided' });
        }

        // Type validation on identity fields
        if (tokenId !== undefined && typeof tokenId !== 'string') {
          return res.status(400).json({ error: 'tokenId must be a string' });
        }
        if (domain !== undefined && typeof domain !== 'string') {
          return res.status(400).json({ error: 'domain must be a string' });
        }
        if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
          return res.status(400).json({ error: 'metadata must be an object' });
        }

        // Merge new fields into existing identity
        const updatedIdentity = {
          ...this.agentIdentity,
          ...(tokenId !== undefined && { tokenId }),
          ...(domain !== undefined && { domain }),
          ...(metadata !== undefined && { metadata: { ...this.agentIdentity?.metadata, ...metadata } })
        };

        this.setIdentity(updatedIdentity);

        console.log(`${logTime()} [Agent] 🆔 Identity updated: ${this.getDisplayId()}`);

        res.json({
          success: true,
          displayId: this.getDisplayId(),
          identity: {
            name: this.agentName,
            tokenId: updatedIdentity.tokenId,
            domain: updatedIdentity.domain
          }
        });
      } catch (err: any) {
        console.error(`${logTime()} [Agent] Error updating identity:`, err?.message || err);
        res.status(500).json({ error: err?.message || 'Internal server error' });
      }
    });
  }

  public setIdentity(identity: { name?: string; team?: string; metadata?: any; tokenId?: string; domain?: string }) {
    this.agentIdentity = identity;
    if (identity?.name) {
      this.agentName = identity.name;
    }
    // Also load catalog from metadata if present
    if (identity?.metadata?.catalog) {
      this.catalog = { ...this.catalog, ...identity.metadata.catalog };
    }
  }

  /**
   * Update agent catalog fields (called by manager when PM updates catalog)
   */
  public setCatalog(catalog: Record<string, any>) {
    for (const [key, value] of Object.entries(catalog)) {
      if (value === null || value === undefined) {
        delete this.catalog[key];
      } else {
        this.catalog[key] = value;
      }
    }
    console.log(`${logTime()} [Agent] 📋 Catalog updated via manager:`, this.catalog);
  }

  /**
   * Get the formatted display identifier for this agent
   * Returns ENS domain (e.g., "agent-5.sep.xid.eth") if registered,
   * falls back to the local alias if not.
   */
  public getDisplayId(): string {
    // Prefer ENS domain name if available
    const domain = this.agentIdentity?.domain ||
                   this.agentIdentity?.metadata?.idchain_domain;
    if (domain) {
      return domain;
    }

    return this.agentName || this.agentIdentity?.name || 'unknown';
  }

  /**
   * Craft a prompt for processing incoming news/messages that prevents infinite loops.
   * The prompt instructs the agent NOT to reply to the sender but allows other actions.
   */
  private craftNewsTriggerPrompt(from: string, message: string, inReplyTo?: string): string {
    const myName = this.agentName || this.agentIdentity?.name || 'this agent';
    const isReply = !!inReplyTo;

    return `[Incoming ${isReply ? 'Reply' : 'Message'} from "${from}"]

${message}

---

IMPORTANT INSTRUCTIONS:
1. You have received ${isReply ? 'a reply' : 'a message'} from agent "${from}".
2. You may process this information, update your understanding, or take action based on it.
3. You may communicate with OTHER agents if needed (not "${from}").
4. DO NOT send a message or reply back to "${from}" - this would create an infinite loop.
5. If you need to respond to "${from}", simply include your response in your final output and it will be recorded in your news feed where "${from}" can check it later.

What would you like to do with this information?`;
  }

  /**
   * Send a reply back to the sender agent via their /news endpoint
   */
  private async sendReplyToSender(
    senderName: string,
    queryId: string,
    message: string,
    success: boolean,
    sessionId?: string
  ): Promise<void> {
    try {
      // Look up sender agent via manager
      const managerUrl = process.env.MANAGER_URL || 'http://id-agent-manager:4100';
      const team = this.agentIdentity?.team || process.env.ID_TEAM || process.env.ID_PROJECT || '';

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (team) {
        headers['X-Id-Team'] = team;
        headers['X-Id-Project'] = team; // backwards compatibility
      }
      const agentsRes = await fetch(`${managerUrl}/agents`, { headers });
      if (!agentsRes.ok) {
        console.error(`[Agent] Failed to fetch agents list: ${agentsRes.status}`);
        return;
      }

      const agentsData = await agentsRes.json() as { agents: Array<{ name: string; id: string; alias?: string; internal_url?: string; url?: string }> };
      // Match by name (displayId like "agent.20"), id, or alias (base name like "agent")
      // Note: alias match may be ambiguous if there are multiple agents with the same base name
      const senderAgent = agentsData.agents?.find(a =>
        a.name === senderName || a.id === senderName || a.alias === senderName
      );

      // Determine where to send the reply
      // For "manager" sender or unknown senders, route through team manager (it handles internal forwarding)
      // For regular agents on same network, route directly
      const senderUrl = senderAgent?.internal_url || senderAgent?.url;
      const isManagerSender = senderName === 'manager' || senderAgent?.id === 'interactive_manager';
      const isUnknownSender = !senderAgent;  // Sender not in agents list (e.g., "cli")
      const isExternalSender = !senderUrl;

      // POST reply to manager's /news endpoint (which forwards to CLI via polling)
      // or directly to the sender if they're on the same network
      const myDisplayId = this.getDisplayId();
      const replyPayload: Record<string, any> = {
        type: success ? 'reply' : 'reply.error',
        from: myDisplayId,
        in_reply_to: queryId,
        message: message,
        trigger: true,  // Notify sender's LLM when reply arrives
        data: { sessionId, to: senderName }  // Include session ID and intended recipient
      };

      const newsHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
      if (team) {
        newsHeaders['X-Id-Team'] = team;
        newsHeaders['X-Id-Project'] = team; // backwards compatibility
      }
      // Route through team manager for "manager" sender, unknown, or external senders
      // Team manager handles forwarding to automator brain internally
      const routeThroughManager = isUnknownSender || isManagerSender || isExternalSender;
      const targetUrl = routeThroughManager ? `${managerUrl}/news` : `${senderUrl}/news`;
      const replyRes = await fetch(targetUrl, {
        method: 'POST',
        headers: newsHeaders,
        body: JSON.stringify(replyPayload)
      });

      if (replyRes.ok) {
        const routeInfo = routeThroughManager ? ' (via manager)' : '';
        console.log(`${logTime()} [Agent] ✉️  Sent reply to ${senderName} for query ${queryId}${routeInfo}`);

        // Record outbound message in our own news feed for conversation history
        await this.addNews('outbound.reply', `Sent reply to ${senderName}`, {
          to: senderName,
          in_reply_to: queryId,
          message: message,
          success: success
        });
      } else {
        console.error(`[Agent] Failed to send reply to ${senderName}: ${replyRes.status}`);
      }
    } catch (err: any) {
      console.error(`[Agent] Error sending reply to ${senderName}:`, err?.message || err);
    }
  }

  private async startQuery(
    queryId: string,
    prompt: string,
    resume?: string,
    from?: string,
    options?: { noAutoReply?: boolean }
  ) {
    // Add to queue and process (serializes queries to prevent concurrent execution issues)
    this.queryQueue.push({ queryId, prompt, resume, from, options });
    console.log(`${logTime()} [Query Queue] Added ${queryId} to queue (queue size: ${this.queryQueue.length})`);
    this.processQueryQueue();
  }

  private async processQueryQueue() {
    // If already processing, the current processor will handle the queue
    if (this.isProcessingQuery) {
      return;
    }

    // Process all queued queries sequentially
    while (this.queryQueue.length > 0) {
      this.isProcessingQuery = true;
      const { queryId, prompt, resume, from, options } = this.queryQueue.shift()!;

      try {
        await this.executeQuery(queryId, prompt, resume, from, options);
      } catch (error) {
        console.error(`[Query Queue] Error processing ${queryId}:`, error);
      }
    }

    this.isProcessingQuery = false;
  }

  private async executeQuery(
    queryId: string,
    prompt: string,
    resume?: string,
    from?: string,
    options?: { noAutoReply?: boolean }
  ) {
    const query: ActiveQuery = {
      id: queryId,
      prompt,
      status: 'processing',
      created: Date.now()
    };

    this.activeQueries.set(queryId, query);
    await this.dbUpsertQuery(query);

    // Track whether we should send an auto-reply (default: yes if from is set)
    const shouldAutoReply = from && !options?.noAutoReply;

    // Track session ID for continuity (declared outside try for catch block access)
    // Use provided resume ID, or fall back to the agent's last session for continuity
    let sessionId = resume || this.lastSessionId;
    if (sessionId && !resume) {
      console.log(`${logTime()} [Claude Agent] 🔄 Resuming previous session: ${sessionId.slice(0, 20)}...`);
    }

    try {
      let result = '';
      const messages: string[] = [];

      console.log(`${logTime()} [Claude Agent] Processing query ${queryId}${from ? ` from ${from}` : ''}${options?.noAutoReply ? ' (no auto-reply)' : ''}: ${prompt.substring(0, 60)}...`);

      // Prepend sender info if present so Claude knows who sent the message
      const isManager = from === 'manager' || from === 'remote';
      const promptWithSender = from
        ? isManager
          ? `[Message from the manager (your owner/operator) | Query ID: ${queryId}]
[Respond directly and helpfully — this is the person who manages you.]

${prompt}`
          : `[Message from agent "${from}" | Query ID: ${queryId}]
[Note: ${from} will poll for your reply for ~2 minutes. Your reply will be sent with trigger notification, so ${from} will be notified even for longer tasks.]

${prompt}`
        : prompt;

      // Inject inter-agent communication skill into the prompt
      const enhancedPrompt = withInterAgentSkill(
        promptWithSender,
        this.agentIdentity || this.agentName
      );

      // Execute via harness
      // Read plugins from env (set by manager when spawning agent)
      // ID_PLUGINS is a JSON array of {name, path} objects (new format)
      const pluginsEnv = process.env.ID_PLUGINS;
      const plugins = pluginsEnv ? JSON.parse(pluginsEnv) : undefined;

      for await (const message of this.harness.run(enhancedPrompt, {
        model: this.model,
        allowedTools: this.allowedTools,
        workingDirectory: this.workingDirectory,
        resume: sessionId,
        plugins: plugins
      })) {
        // Capture session ID from system init or result message
        if (message.session_id) {
          sessionId = message.session_id;
          this.lastSessionId = sessionId;  // Persist for future queries
        }

        // Log and broadcast thinking
        if (message.type === 'thinking' && message.content) {
          console.log(`  💭 ${message.content}`);
          messages.push(`[Thinking] ${message.content}`);
          // Broadcast for /watch subscribers (fire and forget)
          this.addNews('query.thinking', message.content, {
            query_id: queryId,
            content: message.content
          }).catch(() => {});
        }

        // Log and broadcast tool use
        if (message.type === 'tool_use') {
          const toolName = (message as any).tool_name || 'unknown';
          const toolInput = (message as any).input;
          console.log(`  🔧 Tool: ${toolName}`);
          messages.push(`[Tool] ${toolName}`);
          // Broadcast for /watch subscribers (fire and forget)
          this.addNews('query.tool_use', `Using tool: ${toolName}`, {
            query_id: queryId,
            tool_name: toolName,
            input: toolInput
          }).catch(() => {});
        }

        // Log and broadcast progress
        if (message.type === 'progress' && message.content) {
          console.log(`  ⏳ ${message.content}`);
          messages.push(`[Progress] ${message.content}`);
          // Broadcast for /watch subscribers (fire and forget)
          this.addNews('query.progress', message.content, {
            query_id: queryId,
            content: message.content
          }).catch(() => {});
        }

        // If the agent surfaced an error message, capture it and fail the query with that exact message.
        // This prevents "empty result" errors from losing the underlying stderr/details.
        if (message.type === 'error' && message.content) {
          const errorContent = message.content;
          const apiHelp = getApiErrorHelp(errorContent, this.harnessType);

          if (apiHelp.isApiError) {
            console.error(`\n${apiHelp.helpMessage}\n`);
          } else {
            console.error(`  ❌ Claude Code error: ${errorContent}`);
          }

          messages.push(`[Error] ${errorContent}`);
          throw new Error(errorContent);
        }

        // Capture final result (do not require truthy; empty-string would otherwise get dropped).
        // Also handle structured results (arrays/objects) by stringifying them.
        if ('result' in message) {
          const r = (message as any).result;
          if (typeof r === 'string') result = r;
          else if (r !== undefined && r !== null) result = JSON.stringify(r);
        }
      }

      // Never treat "empty result" as success; bubble it up as a failure so it's debuggable.
      if (!result || !result.trim() || result.trim() === 'No response from Claude Code') {
        throw new Error('Claude Code produced an empty result');
      }

      // If the result is actually a raw Claude Code JSON payload (often on errors), extract/throw cleanly.
      const trimmed = (result || '').trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed?.is_error) {
            const msg = parsed.result || parsed.error || 'Unknown error from Claude Code';
            throw new Error(msg);
          }
          if (typeof parsed?.result === 'string' && parsed.result.trim()) {
            result = parsed.result;
          } else if (typeof parsed?.text === 'string' && parsed.text.trim()) {
            result = parsed.text;
          }
        } catch (e: any) {
          if (e?.message) throw e;
        }
      }

      // Mark as completed
      query.status = 'completed';
      query.completed = Date.now();
      query.result = {
        result,
        sessionId,
        messages,
        model: this.model
      };
      await this.dbUpsertQuery({ ...query, sessionId });

      // Post to news
      await this.addNews('query.completed', `Query ${queryId} completed`, {
        query_id: queryId,
        result: query.result
      });

      console.log(`${logTime()} [Claude Agent] ✅ Query ${queryId} completed`);

      // Send reply back to sender if auto-reply is enabled
      if (shouldAutoReply) {
        await this.sendReplyToSender(from!, queryId, result, true, sessionId);
      } else if (from && options?.noAutoReply) {
        // For triggered messages (noAutoReply), save response to our own news feed
        // This preserves the response without creating an infinite loop
        await this.addNews('response.saved', `Response to ${from} (not sent - triggered message)`, {
          to: from,
          in_reply_to: queryId,
          message: result,
          reason: 'noAutoReply'
        });
        console.log(`${logTime()} [Agent] 📝 Response saved to news feed (not sent to ${from} - triggered message)`);
      }

    } catch (error) {
      query.status = 'failed';
      query.completed = Date.now();
      query.error = error instanceof Error ? error.message : String(error);
      await this.dbUpsertQuery(query);

      // Check if this is an API-related error and show helpful message
      const apiHelp = getApiErrorHelp(query.error, this.harnessType);

      // Clear session on content filter errors to allow recovery
      // The corrupted context is likely causing the filter to trigger
      if (isContentFilterError(query.error)) {
        console.log(`${logTime()} [Claude Agent] 🔄 Content filter error detected - clearing session to allow recovery`);
        this.lastSessionId = undefined;
      }

      // Post to news with helpful message if API error
      const newsMessage = apiHelp.isApiError
        ? `Query ${queryId} failed (API issue): ${query.error}`
        : `Query ${queryId} failed: ${query.error}`;

      await this.addNews('query.failed', newsMessage, {
        query_id: queryId,
        error: query.error,
        is_api_error: apiHelp.isApiError,
        help: apiHelp.isApiError ? apiHelp.helpMessage : undefined,
        session_cleared: isContentFilterError(query.error)
      });

      if (apiHelp.isApiError) {
        console.error(`[Claude Agent] ❌ Query ${queryId} failed (API issue)`);
        console.error(`\n${apiHelp.helpMessage}\n`);
      } else {
        console.error(`[Claude Agent] ❌ Query ${queryId} failed:`, error);
      }

      // Send error reply back to sender if auto-reply is enabled
      // Include helpful message for API errors
      if (shouldAutoReply) {
        const replyMessage = apiHelp.isApiError
          ? `${query.error}\n\n${apiHelp.helpMessage}`
          : (query.error || 'Unknown error');
        await this.sendReplyToSender(from!, queryId, replyMessage, false, sessionId);
      }
    }
  }

  private async addNews(type: string, message: string, data?: any) {
    const timestamp = Date.now();
    // Ephemeral types are for /watch only - don't persist to database
    const ephemeralTypes = ['query.thinking', 'query.tool_use', 'query.progress'];
    const isEphemeral = ephemeralTypes.includes(type);

    // Store in memory (for local /news endpoint)
    this.newsItems.push({
      type,
      timestamp,
      message,
      data
    });

    // Only persist non-ephemeral messages to database
    if (!isEphemeral) {
      await this.dbAddNews(type, message, data);
    }

    // Keep only last 100 news items in memory
    if (this.newsItems.length > 100) {
      this.newsItems = this.newsItems.slice(-100);
    }

    // Broadcast to manager for real-time WebSocket delivery (fire-and-forget)
    // Ephemeral messages are only broadcast, never stored
    this.broadcastToManager(type, message, data, timestamp).catch(() => {});
  }

  /**
   * Post news to manager for WebSocket broadcast to CLI watchers
   */
  private async broadcastToManager(type: string, message: string, data: any, timestamp: number) {
    const managerUrl = process.env.MANAGER_URL;
    const teamId = process.env.ID_TEAM;

    if (!managerUrl) return;

    try {
      await fetch(`${managerUrl}/news`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Id-Team': teamId || ''
        },
        body: JSON.stringify({
          type,
          from: this.getDisplayId(),
          message,
          data,
          timestamp
        })
      });
    } catch {
      // Ignore broadcast failures - this is best-effort for /watch
    }
  }

  async start(port: number = 4101): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = this.app.listen(port, '127.0.0.1', () => {
        console.log(`\n🤖 Agent REST-AP Server`);
        console.log(`================================`);
        console.log(`Harness: ${this.harnessType}`);
        console.log(`Model: ${this.model}`);
        console.log(`Working Directory: ${this.workingDirectory}`);
        console.log(`Tools: ${this.allowedTools.join(', ')}`);
        console.log(`\nListening on http://localhost:${port}`);
        console.log(`\nREST-AP Endpoints:`);
        console.log(`  GET  /.well-known/restap.json - Discover capabilities`);
        console.log(`  POST /talk                     - Talk to Claude (triggers processing)`);
        console.log(`  GET  /news                     - Poll for updates`);
        console.log(`  POST /news                     - Receive replies (no processing)`);
        console.log(`  GET  /files/{filename}         - Serve files`);
        console.log(`\nTeam Folder:`);
        console.log(`  Shared files: ${this.sharedDirectory || '/workspace/teams/<team>/'}`);
        console.log(`  All agents in your team can read/write here directly.`);
        console.log(`\n`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // stop cleanup timer
    try {
      clearInterval(this.newsCleanupInterval);
    } catch {
      // ignore
    }

    // close HTTP server
    if (!this.httpServer) return;
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((err?: Error) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.httpServer = undefined;
  }
}
