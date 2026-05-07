import { retryQueue } from "./retry-queue.js";
import { VetraClient } from "./client.js";

export function startVetraRetryWorker(drainFn = async () => {
  const client = new VetraClient();
  const entries = retryQueue.readPending();
  const remaining = [];

  for (const entry of entries) {
    try {
      await client.createDocumentIfMissing(entry.document_id);
      await client.mutateDocument(entry.document_id, entry.action);
    } catch {
      remaining.push({
        ...entry,
        attempt_count: entry.attempt_count + 1,
        last_failed_at: new Date().toISOString(),
      });
    }
  }

  retryQueue.rewritePending(remaining);
}) {
  const handle = setInterval(() => {
    void drainFn();
  }, 30_000);

  return () => clearInterval(handle);
}
