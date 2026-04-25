// SPDX-License-Identifier: MIT
/**
 * Bridges the gap between "DB row exists / process spawned" and
 * "the agent's HTTP server is actually accepting requests" so an
 * immediate /ask after /sync or /deploy does not fire into a port
 * that is not yet listening.
 */

export async function waitForAgentReady(
  url: string,
  opts?: { timeoutMs?: number; intervalMs?: number; perRequestTimeoutMs?: number },
): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 8000;
  const intervalMs = opts?.intervalMs ?? 250;
  const perRequestTimeoutMs = opts?.perRequestTimeoutMs ?? 750;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/.well-known/restap.json`, {
        signal: AbortSignal.timeout(perRequestTimeoutMs),
      });
      if (r.ok) return true;
    } catch {
      /* keep polling */
    }
    if (Date.now() + intervalMs >= deadline) break;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false;
}
