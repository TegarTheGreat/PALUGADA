import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads what a page draws, and loads it again when asked.
 *
 * A late answer for a company the owner has already switched away from is
 * dropped rather than drawn: the sequence number says which request is the
 * current one.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const sequence = useRef(0);

  useEffect(() => {
    const mine = ++sequence.current;
    setLoading(true);
    setError(null);
    load().then(
      (value) => {
        if (mine !== sequence.current) return;
        setData(value);
        setLoading(false);
      },
      (failure: unknown) => {
        if (mine !== sequence.current) return;
        // Said on the page rather than swallowed: a panel that silently
        // draws nothing looks exactly like a company with nothing in it.
        setError((failure as Error).message);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}
