// SPDX-License-Identifier: MIT

import { Pool } from 'pg';
import { DbAdapter, QueryResult } from './db-adapter.js';

export class PgAdapter implements DbAdapter {
  readonly dialect = 'postgres' as const;

  constructor(private pool: Pool) {}

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
