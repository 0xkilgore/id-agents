// Retry policy for OpenRouter calls. Shape borrowed from OpenCode's
// session/retry.ts — honor Retry-After headers, always retry 5xx, match
// 429 bodies against a short list of rate-limit keywords, and never retry
// context-overflow errors (would loop forever).
//
// Exported as a generic `retryFetch` so both the main LLM path and the
// guard classifier pick up the same behavior.

export const BASE_DELAY_MS = 500;
export const BACKOFF_FACTOR = 2;
export const MAX_DELAY_MS = 8_000;
export const JITTER_PCT = 0.2;
export const MAX_ATTEMPTS = 4;

const RATE_LIMIT_BODY_RE = /rate[_ -]?limit|too[_ ]?many[_ ]?requests|overloaded|quota|throttle/i;
const OVERFLOW_BODY_RE =
  /context[_ ]?length|max[_ ]?tokens|prompt is too long|input is too long|context window|reduce the length/i;

export interface RetryLogRecord {
  attempt: number;
  reason: string;
  statusCode?: number;
  waitMs: number;
}

export interface RetryFetchOptions {
  maxAttempts?: number;
  logger?: (rec: RetryLogRecord) => void;
  label?: string;
  /** Maximum ms to honor from a Retry-After header. Default: uncapped. */
  maxRetryAfterMs?: number;
}

function jitter(ms: number): number {
  const delta = ms * JITTER_PCT;
  return Math.max(0, Math.round(ms + (Math.random() * 2 - 1) * delta));
}

export function backoffDelay(attempt: number): number {
  // attempt is 1-indexed; attempt=1 -> BASE_DELAY, attempt=2 -> BASE*2, ...
  const exp = BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempt - 1);
  return jitter(Math.min(MAX_DELAY_MS, exp));
}

// Parses a Retry-After value. Returns ms to wait, or null if absent/unparseable.
// Accepts: "<seconds>" (integer or decimal) or HTTP-date.
// Optional capMs clamps the result to a maximum wait.
export function parseRetryAfter(
  value: string | null,
  nowMs: number = Date.now(),
  capMs?: number,
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  let ms: number | null = null;
  if (Number.isFinite(n) && n >= 0) {
    ms = Math.round(n * 1000);
  } else {
    const t = Date.parse(trimmed);
    if (Number.isFinite(t)) ms = Math.max(0, t - nowMs);
  }
  if (ms === null) return null;
  return capMs !== undefined ? Math.min(ms, capMs) : ms;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  const msg = err.message;
  // fetch failures across Node versions surface as TypeError / AbortError /
  // plain Error with messages like "fetch failed", "ECONNRESET", "ENOTFOUND".
  if (name === 'TypeError' || name === 'FetchError' || name === 'AbortError') return true;
  if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg)) return true;
  return false;
}

// Classifies a completed HTTP response. The decision tree matches OpenCode's
// retryable(): 5xx -> always retry; 429 -> retry; 4xx other -> no; 2xx -> done.
// The body is consulted for a rate-limit keyword match even on non-standard
// status codes (e.g. some providers surface throttling as 400 with a
// rate_limit body).
export function classifyResponse(res: Response, body: string):
  | { retry: false }
  | { retry: true; reason: string } {
  const status = res.status;
  if (status < 400) return { retry: false };
  if (status >= 500) return { retry: true, reason: `http_${status}` };
  if (status === 429) return { retry: true, reason: 'http_429' };
  if (RATE_LIMIT_BODY_RE.test(body)) return { retry: true, reason: 'body_rate_limit' };
  return { retry: false };
}

// Heuristic for context-overflow. Stubbed here (per task spec) with a simple
// substring/regex check — can be expanded later with the OpenCode catalog.
export function looksLikeContextOverflow(status: number, body: string): boolean {
  if (status === 413) return true;
  return OVERFLOW_BODY_RE.test(body);
}

async function readBodyForClassification(res: Response): Promise<{ body: string; clone: Response }> {
  // We consume the body here to classify, then hand the caller a fresh
  // Response built from the already-read text so they can parse it again.
  const text = await res.text().catch(() => '');
  const clone = new Response(text, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  return { body: text, clone };
}

export class HttpRetryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HttpRetryError';
  }
}

// Wraps an async fetcher with bounded exponential backoff + Retry-After
// honoring. The fetcher must throw (for network errors) or return a Response.
// Non-retryable errors are re-thrown immediately. Context-overflow responses
// are never retried: they surface as HttpRetryError with status untouched so
// the caller can produce a friendly message.
export async function retryFetch(
  fetcher: () => Promise<Response>,
  opts: RetryFetchOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const label = opts.label ?? 'openrouter';
  const maxRetryAfterMs = opts.maxRetryAfterMs;
  const log = opts.logger ?? ((rec) => {
    console.log(
      `[public-agent] ${label} retry attempt=${rec.attempt}/${maxAttempts} reason=${rec.reason}` +
        (rec.statusCode ? ` status=${rec.statusCode}` : '') +
        ` wait_ms=${rec.waitMs}`,
    );
  });

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetcher();
      if (res.ok) return res;

      const { body, clone } = await readBodyForClassification(res);
      if (looksLikeContextOverflow(res.status, body)) {
        throw new HttpRetryError(`context_overflow: ${res.status} ${body.slice(0, 200)}`, res.status, body);
      }
      const verdict = classifyResponse(clone, body);
      if (!verdict.retry) {
        throw new HttpRetryError(`http ${res.status}: ${body.slice(0, 500)}`, res.status, body);
      }
      if (attempt >= maxAttempts) {
        throw new HttpRetryError(
          `http ${res.status} after ${maxAttempts} attempts: ${body.slice(0, 500)}`,
          res.status,
          body,
        );
      }
      const retryAfter = parseRetryAfter(clone.headers.get('retry-after'), Date.now(), maxRetryAfterMs);
      const waitMs = retryAfter !== null ? retryAfter : backoffDelay(attempt);
      log({ attempt, reason: verdict.reason, statusCode: res.status, waitMs });
      await sleep(waitMs);
      continue;
    } catch (err) {
      if (err instanceof HttpRetryError) throw err;
      if (!isNetworkError(err)) throw err;
      lastErr = err;
      if (attempt >= maxAttempts) break;
      const waitMs = backoffDelay(attempt);
      log({ attempt, reason: 'network_error', waitMs });
      await sleep(waitMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`retry exhausted: ${String(lastErr)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
