import { useEffect, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  lastUpdated: number;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  paused: boolean,
  deps: ReadonlyArray<unknown> = [],
): PollingState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number>(0);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const ac = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const d = await fetcher(ac.signal);
        if (cancelled) return;
        setData(d);
        setError(null);
        setLastUpdated(Date.now());
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    };

    void run();
    const id = setInterval(() => {
      void run();
    }, intervalMs);

    return () => {
      cancelled = true;
      clearInterval(id);
      ac.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, intervalMs, ...deps]);

  return { data, error, lastUpdated };
}
