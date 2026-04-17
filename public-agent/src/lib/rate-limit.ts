import type { MiddlewareHandler } from 'hono';

/**
 * Token bucket per client key. Resets to full capacity every window.
 * `keyFn` chooses the client identity — IP, auth header, whatever.
 * Returns a no-op middleware when perMinute <= 0.
 */
export function tokenBucket(
  perMinute: number,
  keyFn: (c: { req: { header: (n: string) => string | undefined } }) => string,
): MiddlewareHandler {
  if (perMinute <= 0) {
    return async (_c, next) => {
      await next();
    };
  }
  const capacity = perMinute;
  const refillPerMs = perMinute / 60_000;
  const buckets = new Map<string, { tokens: number; lastRefill: number }>();

  return async (c, next) => {
    const key = keyFn(c);
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      buckets.set(key, bucket);
    } else {
      const elapsed = now - bucket.lastRefill;
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.lastRefill = now;
    }

    if (bucket.tokens < 1) {
      const retryMs = Math.ceil((1 - bucket.tokens) / refillPerMs);
      c.header('Retry-After', String(Math.ceil(retryMs / 1000)));
      return c.json(
        { error: 'rate_limited', detail: `cap ${perMinute}/min; retry in ~${Math.ceil(retryMs / 1000)}s` },
        429,
      );
    }
    bucket.tokens -= 1;
    await next();
  };
}

export function ipOf(c: { req: { header: (n: string) => string | undefined } }): string {
  const xff = c.req.header('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}
