import { useCallback, useEffect, useRef, useState } from 'react';
import { explain, live, type LiveEvent } from './api.ts';

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  /** When the data on screen was fetched: what "updated 5s ago" reads. */
  updatedAt: Date | null;
}

/**
 * Loads what a page draws, and loads it again when asked -- or on its own,
 * every `every` milliseconds while the tab is visible, so a page showing work
 * in flight shows it moving.
 *
 * A late answer for a company the owner has already switched away from is
 * dropped rather than drawn: the sequence number says which request is the
 * current one. A refresh keeps the old data on screen until the new arrives,
 * so a live page never flashes back to skeletons.
 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[], options: { every?: number; pulse?: number } = {}): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const sequence = useRef(0);
  const first = useRef(true);

  useEffect(() => {
    first.current = true;
    setData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const mine = ++sequence.current;
    if (first.current) setLoading(true);
    load().then(
      (value) => {
        if (mine !== sequence.current) return;
        first.current = false;
        setData(value);
        setError(null);
        setLoading(false);
        setUpdatedAt(new Date());
      },
      (failure: unknown) => {
        if (mine !== sequence.current) return;
        // Said on the page rather than swallowed: a panel that silently
        // draws nothing looks exactly like a company with nothing in it.
        setError(explain(failure));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);

  // A live event that touches what is drawn (`useLivePulse`): loaded again
  // now, keeping what is on screen until the answer comes.
  useEffect(() => {
    if (options.pulse) reload();
  }, [options.pulse, reload]);

  useEffect(() => {
    if (!options.every) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, options.every);
    return () => window.clearInterval(timer);
  }, [options.every, reload]);

  return { data, error, loading, reload, updatedAt };
}

/**
 * One live stream per company (GET /api/companies/:companyId/live), shared by
 * every component listening to it and closed when the last one goes.
 */
const streams = new Map<string, { listeners: Set<(event: LiveEvent) => void>; stop: AbortController }>();

function listen(companyId: string, listener: (event: LiveEvent) => void): () => void {
  let stream = streams.get(companyId);
  if (!stream) {
    const opened = { listeners: new Set<(event: LiveEvent) => void>(), stop: new AbortController() };
    stream = opened;
    streams.set(companyId, opened);
    void live('GET', `/api/companies/${companyId}/live`, (event) => {
      for (const one of opened.listeners) one(event);
    }, opened.stop.signal);
  }
  stream.listeners.add(listener);
  return () => {
    stream!.listeners.delete(listener);
    if (stream!.listeners.size === 0) {
      stream!.stop.abort();
      streams.delete(companyId);
    }
  };
}

/**
 * A number that grows when the company's live stream says something that
 * touches what the caller draws -- for `useLoad`'s `pulse`, so a page shows
 * work moving the moment it moves (the analysis of 3 October, §9 P1 item 11).
 * A burst of events, a run's every step, makes one pulse.
 */
export function useLivePulse(companyId: string, touches: (event: LiveEvent) => boolean = () => true): number {
  const [pulse, setPulse] = useState(0);
  const wanted = useRef(touches);
  wanted.current = touches;
  useEffect(() => {
    let soon: number | undefined;
    const stop = listen(companyId, (event) => {
      if (!wanted.current(event) || soon !== undefined) return;
      soon = window.setTimeout(() => {
        soon = undefined;
        setPulse((value) => value + 1);
      }, 400);
    });
    return () => {
      stop();
      if (soon !== undefined) window.clearTimeout(soon);
    };
  }, [companyId]);
  return pulse;
}

/** A clock that ticks once a second, for "5s ago" labels. */
export function useNow(every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [every]);
  return now;
}
