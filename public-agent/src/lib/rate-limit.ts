import type { Context, MiddlewareHandler } from 'hono';

/**
 * Token bucket per client key. Resets to full capacity every window.
 * `keyFn` chooses the client identity — IP, auth header, whatever.
 * Returns a no-op middleware when perMinute <= 0.
 */
export function tokenBucket(
  perMinute: number,
  keyFn: (c: Context) => string,
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

type ConnInfoFn = (c: Context) => { remote: { address?: string | undefined } };

/**
 * Best-effort client IP.
 *   - If trustedProxy=true, the first hop in X-Forwarded-For is honored.
 *     Chain this only behind a reverse proxy you control.
 *   - Otherwise, the socket's remoteAddress (via @hono/node-server) is used.
 * Returns null if no source provides an IP — callers should 400 rather than
 * fall back to an "unknown" bucket, which would collide every anonymous
 * client into a single shared rate-limit slot.
 */
export function clientIp(c: Context, connInfo: ConnInfoFn, trustedProxy: boolean): string | null {
  if (trustedProxy) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const real = c.req.header('x-real-ip');
    if (real && real.trim()) return real.trim();
  }
  try {
    const info = connInfo(c);
    const addr = info?.remote?.address;
    if (addr && addr.trim()) return addr.trim();
  } catch {
    // conninfo is only available under @hono/node-server; fall through.
  }
  return null;
}
