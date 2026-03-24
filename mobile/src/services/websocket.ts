import { ServerEntry, WsMessage } from '../types';

type WsHandler = (message: WsMessage) => void;

/**
 * Manages a WebSocket connection to the manager server.
 * Handles auto-reconnect and keep-alive pings.
 */
export class WebSocketManager {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: Set<WsHandler> = new Set();
  private server: ServerEntry;
  private shouldReconnect = true;

  constructor(server: ServerEntry) {
    this.server = server;
  }

  /**
   * Connect to the manager WebSocket
   */
  connect(): void {
    this.shouldReconnect = true;
    this.doConnect();
  }

  private doConnect(): void {
    const url = new URL(this.server.url);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${url.host}/ws?team=${encodeURIComponent(this.server.team)}&apiKey=${encodeURIComponent(this.server.apiKey)}`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.emit({
          type: 'connected',
          message: `Connected to ${this.server.name}`,
        } as WsMessage);

        // Start keep-alive pings every 30 seconds
        this.pingTimer = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 30000);
      };

      this.ws.onmessage = (event) => {
        try {
          const message: WsMessage = JSON.parse(
            typeof event.data === 'string' ? event.data : ''
          );
          this.emit(message);
        } catch {
          // Ignore parse errors
        }
      };

      this.ws.onclose = () => {
        this.cleanup();
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect();
          }, 5000);
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after this
      };
    } catch {
      // Connection failed, will retry via onclose
    }
  }

  /**
   * Disconnect and stop reconnecting
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this.cleanup();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Register a message handler
   */
  onMessage(handler: WsHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Check if currently connected
   */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private emit(message: WsMessage): void {
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
