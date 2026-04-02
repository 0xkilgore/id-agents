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

// ---------- Types ----------

export interface XmtpConfig {
  /** Wallet private key (hex). Falls back to XMTP_WALLET_KEY env var. */
  walletKey?: string;
  /** DB encryption key (64 hex chars). Falls back to XMTP_DB_ENCRYPTION_KEY env var. */
  dbEncryptionKey?: string;
  /** XMTP network: 'local' | 'dev' | 'production'. Falls back to XMTP_ENV. */
  env?: 'local' | 'dev' | 'production';
  /** Optional DB path override. */
  dbPath?: string;
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
      console.log(`[XMTP] Allowed sender: ${addressOrName} → ${resolved}`);
      return resolved;
    }
    console.warn(`[XMTP] Could not resolve ${addressOrName}`);
    return null;
  }

  /** Remove a sender from the allowlist. */
  removeSender(address: string): void {
    this.allowedSenders.delete(address.toLowerCase());
  }

  /** Check if a sender address is allowed (or if allowlist is empty = open mode). */
  isSenderAllowed(address: string): boolean {
    if (this.allowedSenders.size === 0) return true; // open mode
    return this.allowedSenders.has(address.toLowerCase());
  }

  /** Get the agent's wallet address (available after start). */
  get address(): string | null {
    return this.agent?.address ?? null;
  }

  /** Start the XMTP agent and begin listening for messages. */
  async start(): Promise<void> {
    if (this.started) return;

    // Set up name resolver for ENS lookups
    this.resolveAddress = createNameResolver(process.env.WEB3_BIO_API_KEY || '');

    this.agent = await Agent.createFromEnv({
      ...(this.config.env && { env: this.config.env }),
      ...(this.config.dbPath && { dbPath: () => this.config.dbPath! }),
    });

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
        if (!this.resolveAddress) {
          return { success: false, error: 'Name resolver not initialized' };
        }
        const resolved = await this.resolveAddress(to);
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

      console.log(`[XMTP] Inbound from ${senderAddress}${isDm ? ' (DM)' : ' (group)'}: ${content.substring(0, 80)}...`);

      // Step 3: Approval check — human can see sender and content before it's processed
      if (this.approvalCallback) {
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
