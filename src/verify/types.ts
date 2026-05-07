// SPDX-License-Identifier: MIT
//
// Spec 053 — verify_signal types. Five typed check kinds embedded in
// the dispatch protocol; the runner walks them and returns a VerifyResult.

export interface HttpGetCheck {
  type: 'http_get';
  url: string;
  must_contain?: string;
  /** Expected HTTP status code; defaults to 200. */
  status?: number;
}

export interface FileMtimeCheck {
  type: 'file_mtime';
  path: string;
  /** Unix epoch seconds — file mtime must be > this. */
  after: number;
}

export interface DeskTagCheck {
  type: 'desk_tag';
  artifact_path: string;
  within_hours: number;
}

export interface ApiCallCheck {
  type: 'api_call';
  service: 'gmail' | 'resend' | 'telegram' | 'trello' | 'vercel_deploy';
  /** Service-specific check name (e.g. "deployment_ready"). */
  check: string;
  id: string;
}

export interface AllCheck {
  type: 'all';
  checks: VerifySignal[];
}

export type VerifySignal =
  | HttpGetCheck
  | FileMtimeCheck
  | DeskTagCheck
  | ApiCallCheck
  | AllCheck;

export interface VerifyFailure {
  check: VerifySignal;
  reason: string;
}

export interface VerifyResult {
  status: 'pass' | 'fail';
  failures: VerifyFailure[];
}

export interface VerifyContext {
  /** dispatched_at unix epoch ms — anchor for desk_tag windows. */
  dispatched_at: number;
  /** Path to Desk.md — defaults to ~/Dropbox/Obsidian/Desk.md. */
  desk_path?: string;
  /** Override for fetch (tests inject fakes). */
  fetch?: typeof fetch;
  /** Override for fs reads (tests inject fakes). */
  readFile?: (path: string) => Promise<string>;
  statFile?: (path: string) => Promise<{ mtimeMs: number }>;
  /** Vercel deploy lookup (tests inject fakes). */
  vercelDeployStatus?: (id: string) => Promise<'READY' | 'BUILDING' | 'ERROR' | 'CANCELED' | 'QUEUED'>;
}
