import { Hono } from 'hono';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Env } from '../env.js';
import { buildCatalog } from '../catalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// SKILL.md ships next to the compiled entrypoint via Dockerfile COPY, and
// two levels up from src/routes/ when running `npm run dev` outside Docker.
function findSkillFile(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../SKILL.md'),
    path.resolve(__dirname, '../../../SKILL.md'),
    path.resolve(process.cwd(), 'SKILL.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // ignore
    }
  }
  return null;
}

export function wellknownRoutes(env: Env): Hono {
  const app = new Hono();

  app.get('/.well-known/skill.md', (c) => {
    const p = findSkillFile();
    if (!p) return c.text('SKILL.md not found', 500);
    const body = fs.readFileSync(p, 'utf8');
    return c.body(body, 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
  });

  app.get('/.well-known/restap.json', (c) => c.json(buildCatalog(env)));

  return app;
}
