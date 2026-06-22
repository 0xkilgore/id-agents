// Desktop remote access (2026-06-22) — configurable manager bind host.
//
// The manager binds to 127.0.0.1:4100 by default (loopback-only, safe). Set
// AGENT_MANAGER_HOST=0.0.0.0 to listen on all interfaces so the Tauri desktop
// app can reach the manager over a private Tailscale tailnet — the second-user
// scenario (Liz's Mac / Chris's laptop) where the desktop app otherwise shows
// "MANAGER UNREACHABLE".
//
// SECURITY: the management API (:4100) has NO authentication today. A
// non-loopback bind exposes every management route to anything that can reach
// the host on that interface. Only ever bind to a non-loopback host on a
// trusted PRIVATE network (a Tailscale tailnet is private to your devices) —
// never a public interface.

export interface ManagerBindHost {
  /** The host to pass to server.listen(). */
  host: string;
  /** True when the host is a loopback address (no network exposure). */
  isLoopback: boolean;
  /** Operator security warning when the bind exposes the no-auth API; null when safe. */
  warning: string | null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"]);

/**
 * Resolve the manager's bind host from AGENT_MANAGER_HOST (default 127.0.0.1).
 * Pure + env-injected so it is unit-testable.
 */
export function resolveManagerBindHost(env: NodeJS.ProcessEnv = process.env): ManagerBindHost {
  const host = (env.AGENT_MANAGER_HOST ?? "").trim() || "127.0.0.1";
  const isLoopback = LOOPBACK_HOSTS.has(host);
  const warning = isLoopback
    ? null
    : `Manager bound to non-loopback host ${host} — the management API (:4100) has NO authentication. ` +
      `Expose it ONLY over a trusted private network (e.g. a Tailscale tailnet); never a public interface.`;
  return { host, isLoopback, warning };
}
