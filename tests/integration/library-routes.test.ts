// SPDX-License-Identifier: MIT
/**
 * Slice 7 integration tests: read-only library inventory endpoints served
 * by the real AgentManagerDb. Boots a manager against an in-memory sqlite
 * DB with the public-agents foundry-dev fixture mounted as libraryRoot,
 * then exercises the four GET routes over HTTP.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { AgentManagerDb } from '../../src/agent-manager-db.js';
import { SqliteAdapter } from '../../src/db/sqlite-adapter.js';
import { migrateSqlite } from '../../src/db/migrations/sqlite.js';
import { SqliteTeamsRepo } from '../../src/db/repos/sqlite/teams-repo.js';
import { SqliteAgentsRepo } from '../../src/db/repos/sqlite/agents-repo.js';
import { SqliteQueriesRepo } from '../../src/db/repos/sqlite/queries-repo.js';
import { SqliteNewsRepo } from '../../src/db/repos/sqlite/news-repo.js';
import { SqliteSchedulesRepo } from '../../src/db/repos/sqlite/schedules-repo.js';
import { SqliteTasksRepo } from '../../src/db/repos/sqlite/tasks-repo.js';

const FIXTURE_LIBRARY_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs';
const FIXTURE_AGENT_ROOT = `${FIXTURE_LIBRARY_ROOT}/agents/foundry-dev`;

function createInMemoryDb() {
  const adapter = new SqliteAdapter(':memory:');
  migrateSqlite(adapter);
  return {
    adapter,
    teams: new SqliteTeamsRepo(adapter),
    agents: new SqliteAgentsRepo(adapter),
    queries: new SqliteQueriesRepo(adapter),
    news: new SqliteNewsRepo(adapter),
    schedules: new SqliteSchedulesRepo(adapter),
    tasks: new SqliteTasksRepo(adapter),
    async close() { await adapter.close(); },
  };
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      server.close(() => resolve(addr.port));
    });
    server.on('error', reject);
  });
}

async function stopManager(manager: AgentManagerDb): Promise<void> {
  await new Promise<void>(resolve => {
    (manager as any).httpServer?.close(() => resolve());
    setTimeout(resolve, 500);
  });
}

function adminHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Id-Team': 'slice-7-test',
    'X-Id-Admin': '1',
  };
}

async function getJson(baseUrl: string, pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`, { headers: adminHeaders() });
  const body = await res.json();
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ */
/*  With the foundry-dev fixture mounted                               */
/* ------------------------------------------------------------------ */

describe('library inventory routes — mounted foundry-dev fixture', () => {
  let manager: AgentManagerDb;
  let db: ReturnType<typeof createInMemoryDb>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-test-'));
    db = createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any, {
      libraryRoot: FIXTURE_LIBRARY_ROOT,
    });
    await manager.start(port);
  }, 15000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /library/agents returns the foundry-dev entry with full list contract', async () => {
    const { status, body } = await getJson(baseUrl, '/library/agents');
    expect(status).toBe(200);
    expect(body.libraryRoot).toBe(FIXTURE_LIBRARY_ROOT);
    expect(body.errors).toEqual([]);

    const foundry = (body.entries as Array<Record<string, unknown>>).find(e => e.name === 'foundry-dev');
    expect(foundry).toBeDefined();
    expect(foundry).toEqual({
      name: 'foundry-dev',
      shape: 'claude-native',
      hasReadme: true,
      hasLicense: false,
      subfolders: ['skills'],
      source_path: FIXTURE_AGENT_ROOT,
    });
  });

  it('GET /library/agents/:name returns persona body, README, and bundled skill names', async () => {
    const { status, body } = await getJson(baseUrl, '/library/agents/foundry-dev');
    expect(status).toBe(200);

    expect(body.name).toBe('foundry-dev');
    expect(body.shape).toBe('claude-native');
    expect(body.source_path).toBe(FIXTURE_AGENT_ROOT);
    expect(body.memoryFile).toBe(`${FIXTURE_AGENT_ROOT}/CLAUDE.md`);
    expect(body.hasReadme).toBe(true);
    expect(body.hasLicense).toBe(false);
    expect(body.subfolders).toEqual(['skills']);

    // Persona body is the raw CLAUDE.md.
    expect(body.memory).toBe(fs.readFileSync(`${FIXTURE_AGENT_ROOT}/CLAUDE.md`, 'utf-8'));
    // README body present and non-empty.
    expect(typeof body.readme).toBe('string');
    expect(body.readme.length).toBeGreaterThan(0);
    expect(body.readme).toBe(fs.readFileSync(`${FIXTURE_AGENT_ROOT}/README.md`, 'utf-8'));
    // Bundled skills enumerated from the entry's skills/ subdir.
    expect([...body.bundledSkills].sort()).toEqual([
      'foundry-scripting-and-deploy',
      'gas-optimization-foundry',
      'solidity-style-modern',
      'using-foundry',
      'writing-foundry-tests',
    ]);
  });

  it('GET /library/agents/:name returns 404 for an unknown agent', async () => {
    const { status, body } = await getJson(baseUrl, '/library/agents/not-here');
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'not_found',
      resource: 'library-agent',
      name: 'not-here',
    });
  });

  it('GET /library/skills returns empty list when the library has no top-level skills', async () => {
    // public-agents/configs/skills does not exist in this fixture, so
    // enumerateLibrarySkills returns an empty list — the correct answer
    // for "no top-level standalone skills".
    const { status, body } = await getJson(baseUrl, '/library/skills');
    expect(status).toBe(200);
    expect(body.libraryRoot).toBe(FIXTURE_LIBRARY_ROOT);
    expect(body.entries).toEqual([]);
  });

  it('GET /library/skills/:name returns 404 when skill is absent', async () => {
    const { status, body } = await getJson(baseUrl, '/library/skills/using-foundry');
    expect(status).toBe(404);
    expect(body).toEqual({
      error: 'not_found',
      resource: 'library-skill',
      name: 'using-foundry',
    });
  });
});

/* ------------------------------------------------------------------ */
/*  With a tmp library that includes standalone top-level skills        */
/* ------------------------------------------------------------------ */

describe('library inventory routes — standalone skills in a tmp library', () => {
  let manager: AgentManagerDb;
  let db: ReturnType<typeof createInMemoryDb>;
  let baseUrl: string;
  let workDir: string;
  let libraryRoot: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-skills-test-'));
    libraryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-skills-root-'));
    const skillDir = path.join(libraryRoot, 'skills', 'using-foundry');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: using-foundry',
        'description: Day-to-day Foundry project work.',
        'license: MIT',
        '---',
        '',
        'The body begins here.',
        'Second paragraph content.',
        '',
      ].join('\n'),
    );

    db = createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any, { libraryRoot });
    await manager.start(port);
  }, 15000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(libraryRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /library/skills returns the skill with full list contract', async () => {
    const { status, body } = await getJson(baseUrl, '/library/skills');
    expect(status).toBe(200);
    expect(body.libraryRoot).toBe(libraryRoot);
    expect(body.entries).toEqual([
      {
        name: 'using-foundry',
        hasSkillMd: true,
        source_path: path.join(libraryRoot, 'skills', 'using-foundry'),
      },
    ]);
  });

  it('GET /library/skills/:name returns parsed frontmatter and body length', async () => {
    const { status, body } = await getJson(baseUrl, '/library/skills/using-foundry');
    expect(status).toBe(200);
    expect(body.name).toBe('using-foundry');
    expect(body.hasSkillMd).toBe(true);
    expect(body.source_path).toBe(path.join(libraryRoot, 'skills', 'using-foundry'));
    expect(body.skillFile).toBe(path.join(libraryRoot, 'skills', 'using-foundry', 'SKILL.md'));
    expect(body.skillName).toBe('using-foundry');
    expect(body.description).toBe('Day-to-day Foundry project work.');

    const expectedBody = '\nThe body begins here.\nSecond paragraph content.\n';
    expect(body.bodyLength).toBe(expectedBody.length);
  });
});

/* ------------------------------------------------------------------ */
/*  With no library root configured                                    */
/* ------------------------------------------------------------------ */

describe('library inventory routes — no library configured', () => {
  let manager: AgentManagerDb;
  let db: ReturnType<typeof createInMemoryDb>;
  let baseUrl: string;
  let workDir: string;

  beforeAll(async () => {
    const port = await findFreePort();
    baseUrl = `http://127.0.0.1:${port}`;
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'library-routes-empty-test-'));
    db = createInMemoryDb();
    manager = new AgentManagerDb(workDir, db as any, { libraryRoot: null });
    await manager.start(port);
  }, 15000);

  afterAll(async () => {
    if (manager) await stopManager(manager);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('GET /library/agents returns { libraryRoot: null, entries: [], errors: [] }', async () => {
    const { status, body } = await getJson(baseUrl, '/library/agents');
    expect(status).toBe(200);
    expect(body).toEqual({ libraryRoot: null, entries: [], errors: [] });
  });

  it('GET /library/skills returns { libraryRoot: null, entries: [] }', async () => {
    const { status, body } = await getJson(baseUrl, '/library/skills');
    expect(status).toBe(200);
    expect(body).toEqual({ libraryRoot: null, entries: [] });
  });

  it('GET /library/agents/:name returns 404 when no library is configured', async () => {
    const { status, body } = await getJson(baseUrl, '/library/agents/foundry-dev');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });

  it('GET /library/skills/:name returns 404 when no library is configured', async () => {
    const { status, body } = await getJson(baseUrl, '/library/skills/anything');
    expect(status).toBe(404);
    expect(body.error).toBe('not_found');
  });
});
