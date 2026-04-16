import { useEffect, useRef, useState } from 'react';

export interface PollingState<T> {
  data: T | null;
  error: Error | null;
  lastUpdated: number;
}

interface InternalState<T> {
  data: T | null;
  error: Error | null;
  lastUpdated: number;
  signature: string;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
  paused: boolean,
  deps: ReadonlyArray<unknown> = [],
): PollingState<T> {
  const [state, setState] = useState<InternalState<T>>({
    data: null,
    error: null,
    lastUpdated: 0,
    signature: '',
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const ac = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const d = await fetcher(ac.signal);
        if (cancelled) return;
        const sig = signatureOf(d);
        const prev = stateRef.current;
        if (sig === prev.signature && prev.error === null) return;
        setState({ data: d, error: null, lastUpdated: Date.now(), signature: sig });
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof Error && (err.name === 'AbortError' || ac.signal.aborted)) return;
        const e = err instanceof Error ? err : new Error(String(err));
        const prev = stateRef.current;
        if (prev.error && prev.error.message === e.message) return;
        setState({ ...prev, error: e });
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

  return { data: state.data, error: state.error, lastUpdated: state.lastUpdated };
}

function signatureOf(value: unknown): string {
  try {
    return JSON.stringify(value, stableReplacer);
  } catch {
    return String(value);
  }
}

function stableReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
    return sorted;
  }
  return value;
}
