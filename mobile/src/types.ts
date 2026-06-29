// Server connection configuration
export interface ServerEntry {
  url: string;
  apiKey: string;
  team: string;
  name: string; // user-given label for this server
}

export type ClaudeCredentialKind = 'claude-code-oauth' | 'anthropic-api-key';

export interface ClaudeAuthStatus {
  ok: boolean;
  connected: boolean;
  team_id: string;
  team?: string;
  kind?: ClaudeCredentialKind;
  updated_at?: number;
  storage: 'os-keychain' | 'memory';
  error?: string;
}

// Response from POST /remote
export interface RemoteResponse {
  ok?: boolean;
  success?: boolean;
  result?: any;
  error?: string;
}

// WebSocket message types from the manager
export interface WsMessage {
  type: 'connected' | 'news' | 'result' | 'error' | 'pong';
  // For 'news' type
  from?: string;
  message?: string;
  newsType?: string;
  to?: string;
  in_reply_to?: string;
  session_id?: string;
  timestamp?: string;
  data?: Record<string, any>;
  // For 'error' type
  error?: string;
}

// Terminal output line
export interface OutputLine {
  id: string;
  text: string;
  type: 'command' | 'result' | 'error' | 'info' | 'ws-news' | 'system';
  timestamp: number;
}

// Agent info from /agents
export interface AgentInfo {
  name: string;
  alias?: string;
  tokenId?: string;
  displayId?: string;
  type: string;
  status: string;
  model?: string;
  port?: number;
  endpoint?: string;
}

// QR code payload
export interface QrPayload {
  url: string;
  apiKey: string;
  team: string;
}

// Navigation param types
export type RootStackParamList = {
  Scan: undefined;
  Terminal: { server: ServerEntry };
  Settings: undefined;
};
