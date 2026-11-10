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
 * last position it heard (`live`, ../api.ts). When the server will not serve
 * it -- the person has five tabs of the company open already, or the server
 * is older than the stream -- its listeners are told, and fall back: the work
 * pages to `/live`, the rooms to reading again every few seconds.
 */
import { useEffect, useRef, useState } from 'react';
import { live } from '../api.ts';
import type { RoomFrame } from './types.ts';

type Listener = (frame: RoomFrame) => void;

interface Shared {
  listeners: Set<Listener>;
  /** Told when the server will not serve this stream. */
  refusals: Set<() => void>;
  stop: AbortController;
  refused: boolean;
}

const streams = new Map<string, Shared>();
const reopenings = new Set<() => void>();

/**
 * Listens to a company's room stream; `refused` is told, now or later, if the
 * server will not serve it. Answers how to stop listening.
 */
export function listenToRooms(companyId: string, listener: Listener, refused?: () => void): () => void {
  let stream = streams.get(companyId);
  if (!stream) {
    const opened: Shared = { listeners: new Set(), refusals: new Set(), stop: new AbortController(), refused: false };
    stream = opened;
    streams.set(companyId, opened);
    void live('GET', `/api/companies/${companyId}/room-stream`, (frame: RoomFrame) => {
      for (const one of opened.listeners) one(frame);
    }, opened.stop.signal, {
      // Too many tabs, or a server without the room stream: each listener falls back, and nothing is tried again.
      refused: (status, code) => {
        if (code !== 'stream.too_many' && status !== 404) return false;
        opened.refused = true;
        for (const one of opened.refusals) one();
        return true;
      },
      reopened: () => {
        for (const one of reopenings) one();
      },
    });
  }
  const held = stream;
  held.listeners.add(listener);
  if (refused) {
    held.refusals.add(refused);
    if (held.refused) refused();
  }
  return () => {
    held.listeners.delete(listener);
    if (refused) held.refusals.delete(refused);
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
 * whether the stream is served: false once the server refused it, when the
 * caller reads again on its own clock instead.
 */
export function useRoomStream(companyId: string | null, heard: Listener): { live: boolean } {
  const [refused, setRefused] = useState(false);
  const wanted = useRef(heard);
  wanted.current = heard;
  useEffect(() => {
    setRefused(false);
    if (!companyId) return undefined;
    return listenToRooms(companyId, (frame) => wanted.current(frame), () => setRefused(true));
  }, [companyId]);
  return { live: companyId !== null && !refused };
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
