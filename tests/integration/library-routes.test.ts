// SPDX-License-Identifier: MIT

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';

import {
  getLibraryAgent,
  getLibrarySkill,
  listLibraryAgents,
  listLibrarySkills,
} from '../../src/lib/library-inventory.js';

/*
 * Integration coverage for slice 7 library-inventory HTTP endpoints.
 *
 * We mount the same handlers the manager registers onto a lightweight
 * express app instead of spinning up the full AgentManagerDb (which would
 * require a Postgres fixture). The manager-side wiring in
 * src/agent-manager-db.ts is a thin `res.json(listLibraryAgents(...))` call
 * around the helper, so exercising the HTTP surface around the helper here
 * is equivalent in coverage to hitting the manager directly.
 */

const FIXTURE_LIBRARY_ROOT = '/Users/nxt3d/projects/id2/public-agents/configs';

function registerLibraryRoutes(app: express.Express, libraryRoot: string | null): void {
  app.get('/library/agents', (_req, res) => {
    res.json(listLibraryAgents(libraryRoot));
  });
  app.get('/library/agents/:name', (req, res) => {
    const detail = getLibraryAgent(libraryRoot, req.params.name);
    if (!detail) {
      res.status(404).json({ error: 'not_found', resource: 'library-agent', name: req.params.name });
      return;
    }
    res.json(detail);
  });
  app.get('/library/skills', (_req, res) => {
    res.json(listLibrarySkills(libraryRoot));
  });
  app.get('/library/skills/:name', (req, res) => {
    const detail = getLibrarySkill(libraryRoot, req.params.name);
    if (!detail) {
      res.status(404).json({ error: 'not_found', resource: 'library-skill', name: req.params.name });
      return;
    }
    res.json(detail);
  });
}

interface Harness {
  baseUrl: string;
  server: Server;
}

async function startHarness(libraryRoot: string | null): Promise<Harness> {
  const app = express();
  registerLibraryRoutes(app, libraryRoot);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, server };
}

async function stopHarness(harness: Harness): Promise<void> {
  await new Promise<void>(resolve => harness.server.close(() => resolve()));
}

async function getJson(baseUrl: string, pathname: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${pathname}`);
  const body = await res.json();
  return { status: res.status, body };
}

describe('library inventory routes (slice 7)', () => {
  let harness: Harness | null = null;

  afterEach(async () => {
    if (harness) {
      await stopHarness(harness);
      harness = null;
    }
  });

  describe('with the public-agents/configs foundry-dev fixture mounted', () => {
    beforeEach(async () => {
      harness = await startHarness(FIXTURE_LIBRARY_ROOT);
    });

    it('GET /library/agents returns the foundry-dev entry with its shape', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/agents');
      expect(status).toBe(200);
      expect(body.libraryRoot).toBe(FIXTURE_LIBRARY_ROOT);
      expect(body.errors).toEqual([]);

      const names = (body.entries as Array<{ name: string }>).map(e => e.name).sort();
      expect(names).toContain('foundry-dev');

      const foundry = (body.entries as Array<{ name: string; shape: string }>).find(
        e => e.name === 'foundry-dev',
      );
      expect(foundry).toBeDefined();
      expect(foundry?.shape).toBe('claude-native');
    });

    it('GET /library/agents/:name returns full detail for foundry-dev', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/agents/foundry-dev');
      expect(status).toBe(200);
      expect(body).toEqual({
        name: 'foundry-dev',
        shape: 'claude-native',
        dirPath: `${FIXTURE_LIBRARY_ROOT}/agents/foundry-dev`,
        memoryFile: `${FIXTURE_LIBRARY_ROOT}/agents/foundry-dev/CLAUDE.md`,
      });
    });

    it('GET /library/agents/:name returns 404 for an unknown agent', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/agents/not-here');
      expect(status).toBe(404);
      expect(body).toEqual({
        error: 'not_found',
        resource: 'library-agent',
        name: 'not-here',
      });
    });

    it('GET /library/skills lists top-level skills in the fixture', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/skills');
      expect(status).toBe(200);
      expect(body.libraryRoot).toBe(FIXTURE_LIBRARY_ROOT);
      // foundry-demo fixture does not ship standalone top-level skills; any
      // results we get should be name-only summaries, not filesystem paths.
      for (const entry of body.entries as Array<Record<string, unknown>>) {
        expect(Object.keys(entry)).toEqual(['name']);
        expect(typeof entry.name).toBe('string');
      }
    });

    it('GET /library/skills/:name returns 404 for an unknown skill', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/skills/not-a-skill');
      expect(status).toBe(404);
      expect(body).toEqual({
        error: 'not_found',
        resource: 'library-skill',
        name: 'not-a-skill',
      });
    });
  });

  describe('with no library root configured', () => {
    beforeEach(async () => {
      harness = await startHarness(null);
    });

    it('GET /library/agents returns an empty listing, not an error', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/agents');
      expect(status).toBe(200);
      expect(body).toEqual({ libraryRoot: null, entries: [], errors: [] });
    });

    it('GET /library/skills returns an empty listing, not an error', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/skills');
      expect(status).toBe(200);
      expect(body).toEqual({ libraryRoot: null, entries: [] });
    });

    it('GET /library/agents/:name returns 404 cleanly when no library is configured', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/agents/foundry-dev');
      expect(status).toBe(404);
      expect(body.error).toBe('not_found');
    });

    it('GET /library/skills/:name returns 404 cleanly when no library is configured', async () => {
      const { status, body } = await getJson(harness!.baseUrl, '/library/skills/anything');
      expect(status).toBe(404);
      expect(body.error).toBe('not_found');
    });
  });
});
