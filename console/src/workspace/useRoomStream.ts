/**
 * The room stream, one per company in view (F19.11; STATUS 2.210).
 *
 * Every part of the console that wants to know something changed listens
 * here: the rail, an open room and thread, Activity, the badges, the work
 * pages through `useLivePulse`, and a hidden tab's notifications. They share
 * one stream per company, opened by the first and closed when the last goes,
 * so a tab holds one connection for all of it: a browser gives an origin six,
 * and three tabs holding two streams each would leave their pages none.
 *
 * A frame says where and what changed, never the words, which each listener
 * reads the ordinary way. The stream is opened again when it drops, from the
 * last position it heard (`live`, ../api.ts). Its listeners are told whether
 * it is heard, and read on their own clocks whenever it is not: until its
 * first bytes arrive, while it is down, and while it is refused because the
 * person has five tabs of the company open already, when it is asked for
 * again, a little later each time, so a tab closed gives its place. A refused
 * tab opens no other stream: over HTTP/1.1 a browser has six connections to
 * an address, five tabs hold five, and the sixth is every tab's for its
 * pages. Only a server older than the room stream sends the work pages to
 * `/live`.
 */
import { useEffect, useRef, useState } from 'react';
import { live } from '../api.ts';
import type { RoomFrame } from './types.ts';

type Listener = (frame: RoomFrame) => void;

/**
 * Whether the server serves the stream: being opened or opened again, heard,
 * refused for the tabs open already (asked again later), or not served at all.
 */
export type Served = 'opening' | 'open' | 'busy' | 'absent';

interface Shared {
  listeners: Set<Listener>;
  /** Told each time whether the stream is served changes. */
  watchers: Set<(served: Served) => void>;
  stop: AbortController;
  served: Served;
}

const streams = new Map<string, Shared>();
const reopenings = new Set<() => void>();

/**
 * Listens to a company's room stream; `told` is told now, and each time it
 * changes, whether the server serves it. Answers how to stop listening.
 */
export function listenToRooms(companyId: string, listener: Listener, told?: (served: Served) => void): () => void {
  let stream = streams.get(companyId);
  if (!stream) {
    const opened: Shared = { listeners: new Set(), watchers: new Set(), stop: new AbortController(), served: 'opening' };
    stream = opened;
    streams.set(companyId, opened);
    const now = (served: Served) => {
      if (opened.served === served) return;
      opened.served = served;
      for (const one of opened.watchers) one(served);
    };
    void live('GET', `/api/companies/${companyId}/room-stream`, (frame: RoomFrame) => {
      for (const one of opened.listeners) one(frame);
    }, opened.stop.signal, {
      // A server without the room stream is not asked again; too many tabs is, as a dropped stream is.
      refused: (status, code) => {
        if (status === 404) now('absent');
        else if (code === 'stream.too_many') now('busy');
        return status === 404;
      },
      reopened: () => {
        for (const one of reopenings) one();
      },
      hearing: (yes) => now(yes ? 'open' : 'opening'),
    });
  }
  const held = stream;
  held.listeners.add(listener);
  if (told) {
    held.watchers.add(told);
    told(held.served);
  }
  return () => {
    held.listeners.delete(listener);
    if (told) held.watchers.delete(told);
    if (held.listeners.size === 0) {
      held.stop.abort();
      streams.delete(companyId);
    }
  };
}

/**
 * Told whenever a room stream opens again after the server ended it. The
 * server ends a member of staff's streams when the owner changes what they
 * may do, so this is when the console reads who it is again (STATUS 2.209).
 */
export function whenRoomStreamReopens(listener: () => void): () => void {
  reopenings.add(listener);
  return () => {
    reopenings.delete(listener);
  };
}

/**
 * Hears every frame of the company's room stream while mounted. Answers
 * whether the stream is heard: false until its first bytes arrive, while it
 * is down, and while the server refuses it, when the caller reads again on
 * its own clock instead.
 */
export function useRoomStream(companyId: string | null, heard: Listener): { live: boolean } {
  const [served, setServed] = useState<Served>('opening');
  const wanted = useRef(heard);
  wanted.current = heard;
  useEffect(() => {
    setServed('opening');
    if (!companyId) return undefined;
    return listenToRooms(companyId, (frame) => wanted.current(frame), setServed);
  }, [companyId]);
  return { live: companyId !== null && served === 'open' };
}

/**
 * A number that grows when the room stream says something the caller draws
 * has changed -- for `useLoad`'s `pulse`, or an effect that reads again. A
 * burst of changes makes one pulse. A `reset`, said when the stream could not
 * say what was missed, touches everything.
 */
export function useRoomPulse(companyId: string | null, touches: (frame: RoomFrame) => boolean): { pulse: number; live: boolean } {
  const [pulse, setPulse] = useState(0);
  const soon = useRef<number | undefined>(undefined);
  const wanted = useRef(touches);
  wanted.current = touches;
  const { live } = useRoomStream(companyId, (frame) => {
    if ((frame.kind !== 'reset' && !wanted.current(frame)) || soon.current !== undefined) return;
    soon.current = window.setTimeout(() => {
      soon.current = undefined;
      setPulse((value) => value + 1);
    }, 150);
  });
  useEffect(() => () => {
    if (soon.current !== undefined) window.clearTimeout(soon.current);
  }, []);
  return { pulse, live };
}

/** Whether a frame is about a room's change, and which room. */
export function roomOf(frame: RoomFrame): string | null {
  return 'room' in frame ? frame.room : null;
}
