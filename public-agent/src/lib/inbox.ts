import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Env } from '../env.js';

export interface InboxEntry {
  id: string;
  received_at: string;     // ISO-8601
  from: string | null;     // client-declared sender; not verified
  ip: string | null;
  message: string;
  reply: string;
  model: string;
  tokens_used: { prompt: number; completion: number; total: number };
  status: 'unread' | 'archived';
  archived_at?: string;
}

function inboxDir(env: Env): string {
  return path.join(env.dataDir, 'inbox');
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function makeInboxId(timestamp: Date = new Date()): string {
  // Filename-safe ISO stamp + short random suffix keeps entries sorted lexically
  // and avoids collisions when two requests hit the same second.
  const iso = timestamp.toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
  const tag = crypto.randomBytes(3).toString('hex');
  return `${iso}-${tag}`;
}

export function writeInboxEntry(env: Env, entry: InboxEntry): void {
  const dir = inboxDir(env);
  ensureDir(dir);
  const file = path.join(dir, `${entry.id}.json`);
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
}

function readEntry(file: string): InboxEntry | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InboxEntry;
  } catch {
    return null;
  }
}

export function listInbox(env: Env, status: 'unread' | 'archived' | 'all'): InboxEntry[] {
  const dir = inboxDir(env);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const entries: InboxEntry[] = [];
  for (const f of files) {
    const entry = readEntry(path.join(dir, f));
    if (!entry) continue;
    if (status === 'all' || entry.status === status) {
      entries.push(entry);
    }
  }
  return entries;
}

export function archiveEntry(env: Env, id: string): InboxEntry | null {
  const dir = inboxDir(env);
  const file = path.join(dir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  const entry = readEntry(file);
  if (!entry) return null;
  if (entry.status === 'archived') return entry;
  entry.status = 'archived';
  entry.archived_at = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
  return entry;
}
