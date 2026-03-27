// SPDX-License-Identifier: MIT

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface DbAdapter {
  readonly dialect: 'postgres' | 'sqlite';
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  close(): Promise<void>;
}
