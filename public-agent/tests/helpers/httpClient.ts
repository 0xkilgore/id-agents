/**
 * Thin in-memory HTTP client for Hono apps.
 * Uses app.fetch(request) — no port binding needed.
 */
import type { Hono } from 'hono';

export interface TestResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export async function req(
  app: Hono,
  method: string,
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<TestResponse> {
  const url = `http://localhost${path}`;
  const init: RequestInit = { method };
  const hdrs: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) {
    hdrs['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  init.headers = hdrs;
  const response = await app.fetch(new Request(url, init));
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body, text };
}
