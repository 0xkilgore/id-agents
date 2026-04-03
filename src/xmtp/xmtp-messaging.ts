// SPDX-License-Identifier: MIT
/**
 * XMTP Messaging Module
 *
 * Enables agents to send and receive encrypted messages via XMTP.
 * Messages can be sent to any wallet address or ENS name (e.g., agent-15.xid.eth).
 * This allows cross-team and cross-system agent communication.
 *
 * Security model:
 * - Sender identity is verified cryptographically before message content is processed
 * - Inbound messages go through an approval callback before being delivered to the agent
 * - Outbound messages can optionally go through an approval callback before being sent
 */

import { Agent, createNameResolver, type MessageContext } from '@xmtp/agent-sdk';
import { EventEmitter } from 'events';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import yaml from 'js-yaml';

// ---------- Types ----------

export interface XmtpConfig {
  /** Wallet private key (hex). Falls back to XMTP_WALLET_KEY env var. */
  walletKey?: string;
  /** OWS wallet name. If set, uses OWS for signing instead of raw key. */
  owsWallet?: string;
  /** DB encryption key (64 hex chars). Falls back to XMTP_DB_ENCRYPTION_KEY env var. */
  dbEncryptionKey?: string;
  /** XMTP network: 'local' | 'dev' | 'production'. Falls back to XMTP_ENV. */
  env?: 'local' | 'dev' | 'production';
  /** Optional DB path override. */
  dbPath?: string;
  /** Working directory for persisting .xmtp/ data (allowlist, DB). */
  workingDirectory?: string;
  /**
   * If true, accept messages from any sender (even if allowlist is empty).
   * Must be explicitly set — defaults to false (closed mode).
   * In closed mode, only allowlisted senders can reach the agent.
   */
  openMode?: boolean;
}

export interface InboundMessage {
  /** Sender's wallet address (resolved before content is exposed). */
  senderAddress: string;
  /** Sender's ENS name, if resolvable. */
  senderName?: string;
  /** Whether this is a DM or group message. */
  isDm: boolean;
  /** Conversation ID. */
  conversationId: string;
  /** Raw message content (text). */
  content: string;
  /** Timestamp. */
  timestamp: number;
}

export interface OutboundMessage {
  /** Recipient wallet address or ENS name. */
  to: string;
  /** Resolved wallet address. */
  toAddress?: string;
  /** Message text. */
  content: string;
}

/**
 * Approval callback. Return true to allow, false to reject.
 * This is where human-in-the-loop approval happens.
 */
export type ApprovalCallback = (message: InboundMessage | OutboundMessage, direction: 'inbound' | 'outbound') => Promise<boolean>;

/**
 * Message handler for inbound messages that passed approval.
 */
export type MessageHandler = (message: InboundMessage) => Promise<string | void>;

// ---------- XMTP Messaging Service ----------

export class XmtpMessaging extends EventEmitter {
  private agent: Agent | null = null;
  private config: XmtpConfig;
  private approvalCallback: ApprovalCallback | null = null;
  private messageHandler: MessageHandler | null = null;
  private resolveAddress: ((name: string) => Promise<string | null>) | null = null;
  private started = false;

  /**
   * Allowlist of trusted sender addresses (lowercase).
   * If non-empty, only messages from these addresses are processed.
   * Messages from unknown senders are silently dropped before reaching the approval callback.
   */
  private allowedSenders: Set<string> = new Set();

  /** Maps addresses to the name they were added with (for readable YAML output). */
  private allowedSenderNames: Map<string, string> = new Map();

  constructor(config: XmtpConfig = {}) {
    super();
    this.config = config;
  }

  /** Set the approval callback for inbound and outbound messages. */
  setApprovalCallback(cb: ApprovalCallback) {
    this.approvalCallback = cb;
  }

  /** Set the handler for approved inbound messages. */
  setMessageHandler(handler: MessageHandler) {
    this.messageHandler = handler;
  }

  /**
   * Add a trusted sender by wallet address or ENS name.
   * ENS names are resolved to addresses on add.
   * Only messages from allowed senders reach the approval callback.
   * If no senders are added, all messages reach the approval callback (open mode).
   */
  async allowSender(addressOrName: string): Promise<string | null> {
    // Already a wallet address
    if (addressOrName.match(/^0x[a-fA-F0-9]{40}$/)) {
      this.allowedSenders.add(addressOrName.toLowerCase());
      this.saveAllowlist();
      console.log(`[XMTP] Allowed sender: ${addressOrName}`);
      return addressOrName;
    }
    // Resolve ENS name
    if (!this.resolveAddress) {
      console.warn(`[XMTP] Cannot resolve ${addressOrName} — name resolver not initialized (call after start)`);
      return null;
    }
    const resolved = await this.resolveAddress(addressOrName);
    if (resolved) {
      this.allowedSenders.add(resolved.toLowerCase());
      this.allowedSenderNames.set(resolved.toLowerCase(), addressOrName);
      this.saveAllowlist();
      console.log(`[XMTP] Allowed sender: ${addressOrName} → ${resolved}`);
      return resolved;
    }
    console.warn(`[XMTP] Could not resolve ${addressOrName}`);
    return null;
  }

  /** Remove a sender from the allowlist. */
  removeSender(address: string): void {
    this.allowedSenders.delete(address.toLowerCase());
    this.saveAllowlist();
  }

  /** Check if a sender address is allowed. Closed by default — only allowlisted senders pass. */
  isSenderAllowed(address: string): boolean {
    if (this.allowedSenders.has(address.toLowerCase())) return true;
    // Open mode must be explicitly configured
    if (this.config.openMode && this.allowedSenders.size === 0) return true;
    return false;
  }

  /** Check if a sender is explicitly on the allowlist (not just open mode). */
  isSenderTrusted(address: string): boolean {
    return this.allowedSenders.has(address.toLowerCase());
  }

  /** Per-agent data directory: ~/.xmtp/{address}/ */
  private dataDir: string | null = null;

  /** Get the per-agent data directory. Available after signer is resolved. */
  private getDataDir(address: string): string {
    const home = process.env.HOME || '/tmp';
    const dir = path.join(home, '.xmtp', address.toLowerCase());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Get the path to allowlist.yaml */
  private getAllowlistPath(): string | null {
    if (!this.dataDir) return null;
    return path.join(this.dataDir, 'allowlist.yaml');
  }

  /** Load allowlist from .xmtp/allowlist.yaml */
  private loadAllowlist(): void {
    const filePath = this.getAllowlistPath();
    if (!filePath || !existsSync(filePath)) return;
    try {
      // Parse YAML entries (list of {address, name} objects or plain strings)
      const data = yaml.load(readFileSync(filePath, 'utf8'));
      if (!Array.isArray(data)) return;
      for (const entry of data) {
        if (typeof entry === 'string') {
          this.allowedSenders.add(entry.toLowerCase());
        } else if (entry && typeof entry === 'object' && entry.address) {
          this.allowedSenders.add(entry.address.toLowerCase());
          if (entry.name) {
            this.allowedSenderNames.set(entry.address.toLowerCase(), entry.name);
          }
        }
      }
      console.log(`[XMTP] Loaded ${this.allowedSenders.size} allowed senders from ${filePath}`);
    } catch (err: any) {
      console.warn(`[XMTP] Failed to load allowlist: ${err.message}`);
    }
  }

  /** Save allowlist to .xmtp/allowlist.yaml */
  private saveAllowlist(): void {
    const filePath = this.getAllowlistPath();
    if (!filePath) return;
    try {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const entries = [...this.allowedSenders].map(addr => {
        const name = this.allowedSenderNames.get(addr);
        return name ? { address: addr, name } : { address: addr };
      });
      writeFileSync(filePath, '# XMTP allowed senders\n' + yaml.dump(entries));
    } catch (err: any) {
      console.warn(`[XMTP] Failed to save allowlist: ${err.message}`);
    }
  }

  /** Get the agent's wallet address (available after start). */
  get address(): string | null {
    return this.agent?.address ?? null;
  }

  /**
   * Get or generate the DB encryption key.
   * Persisted at .xmtp/db.key so it survives restarts.
   */
  private async getDbEncryptionKey(): Promise<`0x${string}`> {
    // Explicit env var takes priority
    if (process.env.XMTP_DB_ENCRYPTION_KEY) {
      const key = process.env.XMTP_DB_ENCRYPTION_KEY.replace(/^0x/, '');
      return `0x${key}` as `0x${string}`;
    }

    // Load or generate from ~/.xmtp/{address}/db.key
    if (this.dataDir) {
      const keyPath = path.join(this.dataDir, 'db.key');
      if (existsSync(keyPath)) {
        const key = readFileSync(keyPath, 'utf8').trim().replace(/^0x/, '');
        return `0x${key}` as `0x${string}`;
      }
      // Generate new key
      const { randomBytes } = await import('crypto');
      const key = randomBytes(32).toString('hex');
      writeFileSync(keyPath, key, { mode: 0o600 });
      console.log(`[XMTP] Generated DB encryption key at ${keyPath}`);
      return `0x${key}` as `0x${string}`;
    }

    // No data dir — generate ephemeral key
    const { randomBytes } = await import('crypto');
    return `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  }

  /** Start the XMTP agent and begin listening for messages. */
  async start(): Promise<void> {
    if (this.started) return;

    // Set up name resolver for ENS lookups
    this.resolveAddress = createNameResolver(process.env.WEB3_BIO_API_KEY || '');

    const env = this.config.env || (process.env.XMTP_ENV as any) || 'production';

    // Determine signer and resolve address to set up data directory
    const owsWallet = this.config.owsWallet || process.env.OWS_WALLET;
    let signerAddress: string;

    if (owsWallet) {
      const { createOwsSigner } = await import('./ows-signer.js');
      const { signer, address } = createOwsSigner(owsWallet);
      signerAddress = address;
      console.log(`[XMTP] Using OWS wallet "${owsWallet}" (${address})`);

      // Set up data dir at ~/.xmtp/{address}/
      this.dataDir = this.getDataDir(address);
      this.loadAllowlist();

      const dbEncryptionKey = await this.getDbEncryptionKey();
      const dbPath = path.join(this.dataDir, `${env}.db3`);

      this.agent = await Agent.create(signer, {
        env,
        dbPath: () => dbPath,
        dbEncryptionKey,
      });
    } else {
      // Fallback: raw key from env — address resolved after agent creation
      this.agent = await Agent.createFromEnv({
        ...(this.config.env && { env: this.config.env }),
      });
      signerAddress = this.agent.address || '';
      if (signerAddress) {
        this.dataDir = this.getDataDir(signerAddress);
        this.loadAllowlist();
      }
    }

    // Handle incoming text messages
    this.agent.on('text', async (ctx: MessageContext) => {
      await this.handleInbound(ctx);
    });

    this.agent.on('start', () => {
      console.log(`[XMTP] Agent started`);
      console.log(`[XMTP] Address: ${this.agent!.address}`);
      this.emit('ready', this.agent!.address);
    });

    this.agent.on('unhandledError', (error: Error) => {
      console.error(`[XMTP] Error:`, error);
      this.emit('error', error);
    });

    this.started = true;
    await this.agent.start();
  }

  /** Resolve xid.eth names via id-cli (CCIP-Read gateway workaround). */
  private resolveViaIdCli(name: string): string | null {
    try {
      const output = execFileSync('id-cli', ['info', name], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const data = JSON.parse(output);
      const addr = data?.data?.ethAddress;
      if (addr && addr.match(/^0x[a-fA-F0-9]{40}$/)) {
        return addr;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Stop the XMTP agent. */
  async stop(): Promise<void> {
    // Agent SDK doesn't expose a stop method in the current API
    this.started = false;
    this.agent = null;
  }

  /**
   * Send a message to a wallet address or ENS name.
   * Resolves ENS names to addresses automatically.
   * Goes through outbound approval if a callback is set.
   */
  async sendMessage(to: string, content: string): Promise<{ success: boolean; conversationId?: string; error?: string }> {
    if (!this.agent) {
      return { success: false, error: 'XMTP agent not started' };
    }

    try {
      // Resolve ENS name to address if needed
      let toAddress = to;
      if (!to.match(/^0x[a-fA-F0-9]{40}$/)) {
        // Try id-cli first for xid.eth names, then fall back to web3.bio
        let resolved: string | null = null;
        if (to.endsWith('.xid.eth')) {
          resolved = this.resolveViaIdCli(to);
        }
        if (!resolved && this.resolveAddress) {
          resolved = await this.resolveAddress(to);
        }
        if (!resolved) {
          return { success: false, error: `Could not resolve "${to}" to a wallet address` };
        }
        toAddress = resolved;
        console.log(`[XMTP] Resolved ${to} → ${toAddress}`);
      }

      // Outbound approval check
      if (this.approvalCallback) {
        const outbound: OutboundMessage = { to, toAddress, content };
        const approved = await this.approvalCallback(outbound, 'outbound');
        if (!approved) {
          console.log(`[XMTP] Outbound message to ${to} rejected by approval`);
          return { success: false, error: 'Message rejected by approval callback' };
        }
      }

      // Create or get existing DM conversation
      const dm = await this.agent.createDmWithAddress(toAddress as `0x${string}`);
      await dm.sendText(content);

      console.log(`[XMTP] Sent message to ${to} (${toAddress})`);
      this.emit('sent', { to, toAddress, content, conversationId: dm.id });

      return { success: true, conversationId: dm.id };
    } catch (err: any) {
      console.error(`[XMTP] Error sending to ${to}:`, err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  }

  /**
   * Handle an inbound message:
   * 1. Resolve sender identity (before exposing content)
   * 2. Run approval callback
   * 3. If approved, deliver to message handler
   * 4. If handler returns a reply, send it back
   */
  private async handleInbound(ctx: MessageContext): Promise<void> {
    try {
      // Step 1: Identify the sender BEFORE processing content
      const senderAddress = await ctx.getSenderAddress();

      // Skip messages from ourselves
      if (senderAddress?.toLowerCase() === this.agent?.address?.toLowerCase()) {
        return;
      }

      // Step 2: Check allowlist BEFORE exposing content to any callback
      if (!this.isSenderAllowed(senderAddress || '')) {
        console.log(`[XMTP] Dropped message from untrusted sender: ${senderAddress}`);
        this.emit('dropped', { senderAddress, reason: 'not in allowlist' });
        return;
      }

      const isDm = ctx.isDm();
      const content = ctx.message.content as string;
      const conversationId = ctx.conversation.id;

      const inbound: InboundMessage = {
        senderAddress: senderAddress || 'unknown',
        isDm,
        conversationId,
        content,
        timestamp: Date.now(),
      };

      const trusted = this.isSenderTrusted(senderAddress || '');
      console.log(`[XMTP] Inbound from ${senderAddress}${isDm ? ' (DM)' : ' (group)'}${trusted ? ' (trusted)' : ''}: ${content.substring(0, 80)}...`);

      // Step 3: Approval check — skip for trusted (allowlisted) senders
      if (!trusted && this.approvalCallback) {
        const approved = await this.approvalCallback(inbound, 'inbound');
        if (!approved) {
          console.log(`[XMTP] Inbound message from ${senderAddress} rejected by approval`);
          this.emit('rejected', inbound);
          return;
        }
      }

      this.emit('message', inbound);

      // Step 3: Deliver to handler
      if (this.messageHandler) {
        const reply = await this.messageHandler(inbound);

        // Step 4: If handler returns a reply, send it back in the conversation
        if (reply) {
          // Outbound approval for the reply
          if (this.approvalCallback) {
            const outbound: OutboundMessage = {
              to: senderAddress || 'unknown',
              toAddress: senderAddress || undefined,
              content: reply,
            };
            const approved = await this.approvalCallback(outbound, 'outbound');
            if (!approved) {
              console.log(`[XMTP] Reply to ${senderAddress} rejected by approval`);
              return;
            }
          }

          await ctx.conversation.sendText(reply);
          console.log(`[XMTP] Replied to ${senderAddress}`);
        }
      }
    } catch (err: any) {
      console.error(`[XMTP] Error handling inbound:`, err?.message || err);
    }
  }
}
