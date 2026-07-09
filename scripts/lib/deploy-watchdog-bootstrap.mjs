// SPDX-License-Identifier: MIT

export const BOOTSTRAP_BACKOFF_MS = [15000, 30000, 60000];

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry the launchd bootout+bootstrap pair. The caller supplies the command
 * runner so unit tests do not touch launchd.
 */
export async function retryLaunchdBootstrap({
  service,
  plist,
  run,
  log = () => {},
  sleep = defaultSleep,
  backoffMs = BOOTSTRAP_BACKOFF_MS,
}) {
  let lastError = null;
  for (let index = 0; index < backoffMs.length; index += 1) {
    const attempt = index + 1;
    try {
      run(`launchctl bootout gui/$(id -u)/${service} || true`);
      run(`launchctl bootstrap gui/$(id -u) ${plist}`);
      return { ok: true, attempts: attempt };
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      log(`launchd bootstrap attempt ${attempt}/${backoffMs.length} failed: ${message}`);
      if (attempt < backoffMs.length) {
        await sleep(backoffMs[index]);
      }
    }
  }
  return {
    ok: false,
    attempts: backoffMs.length,
    error: lastError instanceof Error ? lastError : new Error(String(lastError ?? "bootstrap failed")),
  };
}
