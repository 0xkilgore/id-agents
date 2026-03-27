// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { TeamsRepository } from '../../db-service.js';
import type { TeamRow } from '../../types.js';
import type { DbAdapter } from '../../db-adapter.js';

export class PgTeamsRepo implements TeamsRepository {
  constructor(private readonly db: DbAdapter) {}

  async getOrCreateTeamId(teamName: string): Promise<string> {
    const name = teamName || 'default';
    const r = await this.db.query<{ id: string }>(
      'INSERT INTO teams (id, name) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
      [randomUUID(), name],
    );
    return r.rows[0].id;
  }

  async getTeam(teamId: string): Promise<TeamRow | null> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, created_at FROM teams WHERE id = $1',
      [teamId],
    );
    return r.rows[0] || null;
  }

  async getTeamByName(name: string): Promise<TeamRow | null> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name FROM teams WHERE name = $1',
      [name],
    );
    return r.rows[0] || null;
  }

  async getConfig(teamId: string): Promise<Record<string, unknown>> {
    const r = await this.db.query<{ config: Record<string, unknown> | null }>(
      'SELECT config FROM teams WHERE id = $1',
      [teamId],
    );
    // PG returns config as a JS object directly (jsonb column)
    return (r.rows[0]?.config as Record<string, unknown>) || {};
  }

  async listTeams(): Promise<TeamRow[]> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, created_at FROM teams ORDER BY created_at DESC',
    );
    return r.rows;
  }

  async listTeamsWithConfig(): Promise<TeamRow[]> {
    const r = await this.db.query<TeamRow>(
      'SELECT id, name, config, created_at FROM teams ORDER BY created_at DESC',
    );
    return r.rows;
  }

  async setRegistrarAddress(teamId: string, address: string): Promise<void> {
    await this.db.query(
      `UPDATE teams
       SET config = jsonb_set(config, '{sepolia_registrar_address}', to_jsonb($2::text), true)
       WHERE id = $1`,
      [teamId, String(address)],
    );
  }

  async setDefaultRegistry(teamId: string, chainId: string, registryAddress: string): Promise<void> {
    await this.db.query(
      `UPDATE teams
       SET config = jsonb_set(jsonb_set(config, '{default_chain_id}', to_jsonb($2::text), true),
                              '{default_registry_address}', to_jsonb($3::text), true)
       WHERE id = $1`,
      [teamId, String(chainId), String(registryAddress)],
    );
  }

  async deleteTeam(teamId: string): Promise<void> {
    await this.db.query('DELETE FROM teams WHERE id = $1', [teamId]);
  }
}
