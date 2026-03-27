// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class SqliteAdapter implements DbAdapter {
  readonly dialect = 'sqlite' as const;
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const stmt = this.db.prepare(sql);

    if (/^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
      const rows = stmt.all(...params) as T[];
      return { rows, rowCount: rows.length };
    }

    const info = stmt.run(...params);
    return { rows: [] as T[], rowCount: info.changes };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}
