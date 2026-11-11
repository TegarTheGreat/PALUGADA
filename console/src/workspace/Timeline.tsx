/**
 * A room's messages, oldest at the top (F19.4, F19.10).
 *
 * A room opens where its person left off (STATUS 2.218): at their read mark,
 * under a line that says how many messages are new, with what came just
 * before it above and a way down to the newest; or at its newest, when
 * everything new fits on the screen with it. A message found, pinned, named
 * in Activity or linked opens the room around it, marked. The mark rises only
 * as far as messages have really been in view for a second while the tab is
 * looked at, or when the person presses Esc or "Mark as read", and it only
 * ever rises.
 *
 * The view holds its place as what is drawn changes size -- a picture loaded,
 * the composer drawn under the log, a bar shown above it, a page of earlier
 * messages put on top: at the newest it stays at the newest, and anywhere
 * else the message at the top of the view stays where it was. Some browsers
 * do this themselves and some do not, so the log does it, from a
 * ResizeObserver on the log's own box and on what it holds.
 *
 * Read from the server a page at a time, and again the moment the room stream
 * says the room changed (STATUS 2.210), so a colleague's words arrive and a
 * card shows its work moving; every five seconds while the tab is seen only
 * while the stream is not heard. Grouped by author and minute and divided by
 * day. Work asked for here is read again the moment the company's live stream
 * says it moved, so its card changes as the work does.
 *
 * A message being sent is drawn at once and replaced by the server's copy;
 * one that failed says so and is sent again, with the same client id, so
 * the server keeps it once however often it is tried.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, Button, Divider, Group, Loader, Text } from '@mantine/core';
import { IconArrowDown } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { count, day, time } from '../format.ts';
import { useLivePulse } from '../hooks.ts';
import { t, tp } from '../i18n.ts';
import type { Attached } from './Composer.tsx';
import { useEscape } from './keys.ts';
import { MessageRow } from './MessageRow.tsx';
import { newClientId, useScope } from './scope.ts';
import type { MessagePage, MessageView } from './types.ts';
import { useRoomPulse } from './useRoomStream.ts';

/** A message on its way, drawn before the server answers. */
export interface Pending {
  clientId: string;
  body: string;
  mentions: string[];
  mentionsRoom: boolean;
  alsoInRoom: boolean;
  threadOf: string | null;
  failed: boolean;
  /**
   * What to do once it is kept: ask the team about it, call a meeting about it, tell it to the thread's work, or set
   * a people's meeting from it (STATUS 2.215).
   */
  then: 'ask' | 'meeting' | 'tell' | 'set_meeting' | null;
  /** The files that go with it, held in this tab's memory until it is kept. */
  files?: Attached[];
}

/** How often an open room is read again while the room stream is not heard: refused for five tabs open already, or down. */
const POLL_MS = 5_000;
/** How long a message is in view before it counts as seen, and the room read up to it. */
const SEEN_MS = 1_000;
/** A page of a room, as it is read. */
const PAGE = 50;
/** Within this of the end, the log counts as at its newest, and stays there as what it holds grows. */
const NEAR_END = 48;
/** The most a room's own unread count says: past it, the line says how many were new as "99+". */
const ROOM_UNREAD_MOST = 99;
/** How far below the top of the log the line of new messages is put when a room opens on it. */
const NEW_LINE_FROM_TOP = 56;

/** Messages in order, each once: what is read again replaces what was there. */
export function merged(now: MessageView[], incoming: MessageView[]): MessageView[] {
  const byId = new Map(now.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((one, other) => one.position - other.position);
}

/**
 * Sends a message, drawn first as `pending`, then as the server keeps it;
 * the caller says what happens once it is kept. A failure leaves it drawn as
 * not sent, to be tried again with the same id.
 */
export function usePosting(companyId: string, roomId: string, kept: (message: MessageView, pending: Pending) => void) {
  const [pending, setPending] = useState<Pending[]>([]);
  const post = useCallback(async (one: Pending) => {
    setPending((now) => [...now.filter((other) => other.clientId !== one.clientId), { ...one, failed: false }]);
    try {
      const answer: { message: MessageView; mentionsDropped: Array<{ principal: string; why: string }> } = await api('POST',
        `/api/companies/${companyId}/rooms/${roomId}/messages`, {
          body: one.body, clientId: one.clientId, mentions: one.mentions,
          ...(one.mentionsRoom ? { mentionsRoom: true } : {}),
          ...(one.threadOf ? { threadOf: one.threadOf, alsoInRoom: one.alsoInRoom } : {}),
          ...(one.files && one.files.length > 0 ? { files: one.files.map((file) => ({ name: file.name, data: file.data })) } : {}),
        });
      setPending((now) => now.filter((other) => other.clientId !== one.clientId));
      kept(answer.message, one);
      return answer;
    } catch (failure) {
      setPending((now) => now.map((other) => (other.clientId === one.clientId ? { ...other, failed: true } : other)));
      throw failure;
    }
  }, [companyId, roomId, kept]);
  const start = (one: Omit<Pending, 'clientId' | 'failed'>) => post({ ...one, clientId: newClientId(), failed: false });
  return { pending, post, start };
}

/** A message being sent, or one that was not. */
export function PendingRow({ pending, retry }: { pending: Pending; retry: (pending: Pending) => void }) {
  return (
    <Box className="message-row" data-pending px={{ base: 'xs', sm: 'md' }} py={4} style={{ opacity: pending.failed ? 1 : 0.6 }}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box w={36} style={{ flexShrink: 0 }} />
        <Box style={{ flex: 1, minWidth: 0 }} className="message-body" dir="auto">
          <Prose text={pending.body} />
          {(pending.files ?? []).map((file, index) => <Text key={index} size="xs" c="dimmed" dir="auto">{file.name}</Text>)}
          {pending.failed
            ? <Group gap={6}><Text size="xs" c="red">{t('Not sent')}</Text><Button size="compact-xs" variant="subtle" color="red" onClick={() => retry(pending)}>{t('Retry')}</Button></Group>
            : <Text size="xs" c="dimmed">{t('Sending…')}</Text>}
        </Box>
      </Group>
    </Box>
  );
}

/** Whether two messages are drawn as one run: the same person, the same minute, both plain words. */
function together(one: MessageView | undefined, other: MessageView): boolean {
  if (!one || one.kind !== 'text' || other.kind !== 'text' || one.deleted || other.deleted) return false;
  return one.author.principal === other.author.principal
    && Math.floor(new Date(one.createdAt).getTime() / 60_000) === Math.floor(new Date(other.createdAt).getTime() / 60_000);
}

/** A day as a divider says it. */
function dayOf(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString() ? t('Today') : day(iso);
}

/** Whether a message is new to its reader as the server counts unread: someone else's words, said here. */
function counted(message: MessageView, me: string): boolean {
  return message.kind === 'text' && !message.deleted && message.via !== 'import' && message.author.principal !== me;
}

/** Where an element is in the log as it scrolls: its top and bottom, from the top of what the log shows. */
function placeOf(element: Element, log: HTMLElement): { top: number; bottom: number } {
  const box = element.getBoundingClientRect();
  const frame = log.getBoundingClientRect();
  return { top: box.top - frame.top, bottom: box.bottom - frame.top };
}

/** How the log lands once a room's first page is drawn: at the newest, at the line of new messages, or at a message. */
type Landing = { kind: 'end' } | { kind: 'new' } | { kind: 'at'; position: number };

export function Timeline({ roomId, at, pending, retry, editing, setEditing, shown, escapeReads }: {
  roomId: string;
  /** A message to open the room around, marked, by its position: one found, pinned, named in Activity or linked. */
  at: number | null;
  /** Esc marks the room read; not while a thread is open, where Esc closes the thread. */
  escapeReads: boolean;
  pending: Pending[];
  retry: (pending: Pending) => void;
  /** The message being edited, as ↑ asks. */
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** The messages drawn, for the room pane: its newest, and the person's own last one. */
  shown: (messages: MessageView[]) => void;
}) {
  const scope = useScope();
  const companyId = scope.companyId;
  const me = scope.me;
  const shownHere = scope.room?.id === roomId;
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [readPosition, setReadPosition] = useState(0);
  // The read mark as the room was opened: where the line of new messages is drawn, which does not move as it is read.
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);
  // Whether more were new than the room's count says: the server counts a room's unread up to 99 (STATUS 2.206).
  const [unreadMore, setUnreadMore] = useState(false);
  const [hasBefore, setHasBefore] = useState(false);
  // Whether more lies after the newest drawn: a room opened at its read mark or at a message may not reach its end.
  const [hasAfter, setHasAfter] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const [newer, setNewer] = useState(false);
  const [focused, setFocused] = useState<number | null>(null);
  // Whether the person is far from the newest, when the way down to it is drawn.
  const [far, setFar] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // The message at the top of the view, and how far below the log's top it is: kept there as sizes change.
  const anchor = useRef<{ position: number; offset: number } | null>(null);
  const landing = useRef<Landing | null>(null);
  // Where the log last put itself. A scroll event for that is the log's own, not the person's: a picture laid out
  // between the scroll and its event leaves the view short of the newest, and is not the person scrolling up.
  const ownTop = useRef<number | null>(null);
  // How tall what the log holds was, and its own box, when the log last put itself or last heard where it was. A
  // scroll heard after either changed, before the log has held its view again, is the browser keeping the view
  // inside what changed -- something put on the page before its size was known, the composer drawn -- not the person.
  const knownSize = useRef<{ content: number; box: number } | null>(null);
  const lastSeen = useRef(0);
  const opening = useRef(0);
  const loadingNewer = useRef(false);
  // While "Jump to newest" reads the newest page and until it is drawn: what is drawn is about to be replaced, so a
  // scroll heard meanwhile says nothing of where the person is, and a later page read now would land in the gap.
  const jumping = useRef(false);
  const held = useRef({ messages, hasAfter });
  held.current = { messages, hasAfter };

  // Opens the room: around a message when one is asked for, else at the person's read mark, or at the newest when
  // what is new fits on the screen with it.
  const open = useCallback(async () => {
    const mine = ++opening.current;
    setLoaded(false);
    try {
      let page: MessagePage;
      let land: Landing;
      if (at !== null) {
        page = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?around=${at}&limit=${PAGE}`);
        land = { kind: 'at', position: at };
      } else {
        page = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?limit=${PAGE}`);
        const first = page.messages[0];
        const kept = page.readPosition;
        // More is new than the newest page holds: the page around the mark, so the first new message is drawn.
        if (kept !== null && first && page.hasBefore && first.position > kept + 1) {
          page = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?around=${kept + 1}&limit=${PAGE}`);
        }
        // Someone not in the room keeps no mark there, so nothing in it is new to them: it opens at its newest.
        const mark = page.readPosition;
        land = mark !== null && page.messages.some((one) => one.position > mark && counted(one, me)) ? { kind: 'new' } : { kind: 'end' };
      }
      if (mine !== opening.current) return;
      const mark = page.readPosition;
      landing.current = land;
      anchor.current = null;
      atBottom.current = land.kind === 'end';
      jumping.current = false;
      setMessages(page.messages);
      setReadPosition(mark ?? 0);
      setNewFrom(mark);
      setUnreadAtOpen(mark === null ? 0 : page.messages.filter((one) => one.position > mark && counted(one, me)).length);
      setUnreadMore(false);
      setHasBefore(page.hasBefore);
      setHasAfter(page.hasAfter);
      setFocused(at);
      setLoaded(true);
      setError(null);
    } catch (failure) {
      if (mine === opening.current) setError(explain(failure));
    }
  }, [companyId, roomId, at, me]);
  useEffect(() => { void open(); }, [open]);

  // When more is new than the drawn page reaches, the room's own count says how much.
  const roomUnread = shownHere ? scope.room?.unread ?? 0 : 0;
  const countedOnce = useRef(false);
  useEffect(() => { countedOnce.current = false; }, [open]);
  useEffect(() => {
    if (!loaded || countedOnce.current || !shownHere) return;
    countedOnce.current = true;
    if (!hasAfter) return;
    setUnreadAtOpen((now) => {
      if (roomUnread >= ROOM_UNREAD_MOST && now < roomUnread) setUnreadMore(true);
      return Math.max(now, roomUnread);
    });
  }, [loaded, shownHere]);

  // What changed since. When what is drawn reaches the room's end: its newest page, and what lies between when more
  // came than a page holds. Otherwise what is drawn from its first message on, which reaches further down each time.
  const latest = useCallback(async () => {
    const { messages: now, hasAfter: detached } = held.current;
    // Not opened yet: the opening reads the room, and this would only race it.
    if (opening.current === 0) return;
    try {
      if (detached && now.length > 0) {
        const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?after=${now[0]!.position - 1}&limit=100`);
        // The newest page replaced what this was read from while it was asked for: it would fill a gap that is gone.
        if (jumping.current || !held.current.hasAfter) return;
        setMessages((drawn) => merged(drawn, page.messages));
        setReadPosition((mark) => Math.max(mark, page.readPosition ?? 0));
        setHasAfter(page.hasAfter);
        return;
      }
      const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?limit=${PAGE}`);
      const last = now.at(-1);
      const oldest = page.messages[0];
      if (last && oldest && page.hasBefore && oldest.position > last.position) {
        const fill: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?after=${last.position}&limit=100`);
        if (!fill.hasAfter) {
          setMessages((drawn) => merged(drawn, [...fill.messages, ...page.messages]));
        } else if (atBottom.current) {
          // More came than is filled in: the newest alone, for someone at the newest; the rest stays where it is.
          setMessages(page.messages);
          setHasBefore(page.hasBefore);
        } else {
          setHasAfter(true);
        }
      } else {
        setMessages((drawn) => merged(drawn, page.messages));
        if (!last) setHasBefore(page.hasBefore);
      }
      setReadPosition((mark) => Math.max(mark, page.readPosition ?? 0));
      setError(null);
    } catch (failure) {
      setError(explain(failure));
    }
  }, [companyId, roomId]);

  // Read again when something changed here (a post, a press, an edit), and the moment the room stream says the room
  // changed (STATUS 2.210); every few seconds only while the stream is not heard.
  useEffect(() => { if (scope.tick > 0) void latest(); }, [scope.tick]);
  const changedHere = useRoomPulse(companyId, (frame) => 'room' in frame && frame.room === roomId && frame.kind !== 'read' && frame.kind !== 'member');
  useEffect(() => { if (changedHere.pulse > 0) void latest(); }, [changedHere.pulse]);
  useEffect(() => {
    if (changedHere.live) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void latest(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [latest, changedHere.live]);
  // And at once when work shown here moves: the work's own stream names the task, never the room.
  const working = useRef(new Set<string>());
  working.current = new Set(messages.flatMap((message) => (message.card?.taskId ? [message.card.taskId] : [])));
  const pulse = useLivePulse(companyId, (event) => event.taskId !== null && working.current.has(event.taskId));
  useEffect(() => { if (pulse > 0) void latest(); }, [pulse]);

  // Earlier messages, put on top: the message at the top of the view stays where it is.
  const loadOlder = async () => {
    const top = messages[0];
    if (!top) return;
    setOlder(true);
    try {
      const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?before=${top.position}&limit=${PAGE}`);
      setMessages((now) => merged(now, page.messages));
      setHasBefore(page.hasBefore);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setOlder(false);
    }
  };
  // Later messages, as the person reaches the end of what is drawn.
  const loadNewer = useCallback(async () => {
    const last = held.current.messages.at(-1);
    if (!last || loadingNewer.current || jumping.current) return;
    loadingNewer.current = true;
    setNewer(true);
    try {
      const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?after=${last.position}&limit=${PAGE}`);
      // The newest page was drawn instead while this was asked for (jump): what it read belongs to a gap that is gone.
      if (jumping.current || !held.current.hasAfter) return;
      setMessages((drawn) => merged(drawn, page.messages));
      setHasAfter(page.hasAfter);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      loadingNewer.current = false;
      setNewer(false);
    }
  }, [companyId, roomId]);

  useEffect(() => { shown(messages); }, [messages, shown]);

  // The log scrolled by the log itself, and where it then is noted.
  const scrollLog = useCallback((log: HTMLElement, top: number) => {
    log.scrollTop = top;
    ownTop.current = log.scrollTop;
    knownSize.current = { content: log.scrollHeight, box: log.clientHeight };
  }, []);

  // The view held as sizes change: at the newest, the newest; anywhere else, the message at the top of the view.
  const hold = useCallback(() => {
    const log = scroller.current;
    if (!log) return;
    if (atBottom.current) {
      scrollLog(log, log.scrollHeight);
      return;
    }
    const kept = anchor.current;
    const row = kept ? log.querySelector(`[data-room-position="${kept.position}"]`) : null;
    if (!kept || !row) return;
    const moved = placeOf(row, log).top - kept.offset;
    if (Math.abs(moved) >= 1) scrollLog(log, log.scrollTop + moved);
  }, [scrollLog]);

  // Where the person is: at the newest or not, and which message is at the top of the view.
  const place = useCallback(() => {
    const log = scroller.current;
    if (!log || jumping.current) return;
    const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
    const own = ownTop.current !== null && Math.abs(log.scrollTop - ownTop.current) < 2;
    const known = knownSize.current;
    const resized = known !== null && (known.content !== log.scrollHeight || known.box !== log.clientHeight);
    if (atBottom.current && gap > 1 && (own || resized)) {
      // At the newest, and either the log put itself here and what it holds grew since, or the browser moved the view
      // as sizes changed and they changed again before it said so -- on a busy phone, two pictures put on the page
      // before they were read moved the view up by their placeholders and were drawn full size before the browser
      // told of it (STATUS 2.220). Still at the newest, as the person left it. A person who scrolls in that same
      // instant is brought back once; their next move is theirs.
      scrollLog(log, log.scrollHeight);
      return;
    }
    knownSize.current = { content: log.scrollHeight, box: log.clientHeight };
    atBottom.current = gap < NEAR_END && !held.current.hasAfter;
    setFar(gap > log.clientHeight / 2 || held.current.hasAfter);
    for (const row of log.querySelectorAll<HTMLElement>('[data-room-position]')) {
      const { top, bottom } = placeOf(row, log);
      if (bottom > 0) {
        anchor.current = { position: Number(row.dataset.roomPosition), offset: top };
        break;
      }
    }
  }, [scrollLog]);

  // The read mark, raised to what the person has seen: a mark the server already has is not sent again. Someone who
  // has not joined the room is read for too: the server keeps them no mark, but sees what named them (STATUS 2.206).
  const marked = useRef(0);
  marked.current = readPosition;
  const readTo = useCallback((position: number) => {
    if (!shownHere || position <= Math.max(marked.current, lastSeen.current)) return;
    lastSeen.current = position;
    api('POST', `/api/companies/${companyId}/rooms/${roomId}/read`, { position })
      .then((answer: { readPosition: number }) => {
        setReadPosition((mark) => Math.max(mark, answer.readPosition));
        scope.ctx.refreshUnread();
      }, () => { lastSeen.current = 0; });
  }, [shownHere, companyId, roomId, scope.ctx]);

  // The newest message whose end is in view while the tab is looked at: what the person has seen.
  const seenNow = useCallback((): number => {
    const log = scroller.current;
    if (!log || document.visibilityState !== 'visible') return 0;
    let seen = 0;
    for (const row of log.querySelectorAll<HTMLElement>('[data-room-position]')) {
      const { bottom } = placeOf(row, log);
      if (bottom > 0 && bottom <= log.clientHeight + 1) seen = Math.max(seen, Number(row.dataset.roomPosition));
    }
    return seen;
  }, []);
  // Read up to it once it has been there a second, by the read as it is then: the room's details may have arrived.
  const seeing = useRef<number | undefined>(undefined);
  const reading = useRef(readTo);
  reading.current = readTo;
  const look = useCallback(() => {
    if (seeing.current !== undefined || seenNow() <= Math.max(marked.current, lastSeen.current)) return;
    seeing.current = window.setTimeout(() => {
      seeing.current = undefined;
      const seen = seenNow();
      if (seen > 0) reading.current(seen);
    }, SEEN_MS);
  }, [seenNow]);
  useEffect(() => () => { if (seeing.current !== undefined) window.clearTimeout(seeing.current); }, []);
  useEffect(() => {
    const visible = () => { if (document.visibilityState === 'visible') look(); };
    document.addEventListener('visibilitychange', visible);
    return () => document.removeEventListener('visibilitychange', visible);
  }, [look]);
  // Once the room's details are read it may be read for: look again.
  useEffect(() => { if (loaded && shownHere) look(); }, [loaded, shownHere, look]);

  // The landing, once the first page is drawn and before it is painted: at the newest, at the line of new messages
  // with what came before it above, or at the message asked for, in the middle.
  useLayoutEffect(() => {
    const log = scroller.current;
    const land = landing.current;
    if (!log || !land || !loaded) return;
    landing.current = null;
    jumping.current = false;
    if (land.kind === 'end') {
      atBottom.current = true;
      scrollLog(log, log.scrollHeight);
    } else if (land.kind === 'new') {
      const line = log.querySelector('[data-new-line]');
      const top = line ? placeOf(line, log).top + log.scrollTop : null;
      if (top === null || (!hasAfter && top >= log.scrollHeight - log.clientHeight)) {
        atBottom.current = !hasAfter;
        scrollLog(log, log.scrollHeight);
      } else {
        atBottom.current = false;
        scrollLog(log, top - NEW_LINE_FROM_TOP);
      }
    } else {
      const row = log.querySelector(`[data-room-position="${land.position}"]`) ?? log.querySelector('[data-room-position]');
      if (row) {
        const { top, bottom } = placeOf(row, log);
        atBottom.current = false;
        scrollLog(log, log.scrollTop + top - Math.max(0, (log.clientHeight - (bottom - top)) / 2));
      }
    }
    place();
  }, [loaded, messages]);

  // As what the log holds, or its own box, changes size, the view is held: a picture drawn, the composer mounted.
  useEffect(() => {
    const log = scroller.current;
    const inner = content.current;
    if (!log || !inner || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(() => {
      hold();
      look();
    });
    watch.observe(log);
    watch.observe(inner);
    return () => watch.disconnect();
  }, [hold, look]);
  // New messages drawn are held as well, before they are painted.
  useLayoutEffect(() => { if (!landing.current) hold(); }, [messages, pending.length, hold]);

  // Down to the newest: the newest page when what is drawn does not reach it. That page is landed on once it is drawn,
  // by the landing above, and not before: a scroll made now would go to the end of what is about to be replaced, and
  // its event, heard before the new page is drawn, would say the person had left the newest.
  const jump = useCallback(async () => {
    setFar(false);
    if (held.current.hasAfter) {
      if (jumping.current) return;
      jumping.current = true;
      try {
        const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?limit=${PAGE}`);
        if (!jumping.current) return;
        landing.current = { kind: 'end' };
        atBottom.current = true;
        setMessages(page.messages);
        setHasBefore(page.hasBefore);
        setHasAfter(false);
        setReadPosition((mark) => Math.max(mark, page.readPosition ?? 0));
      } catch (failure) {
        jumping.current = false;
        setError(explain(failure));
      }
      return;
    }
    atBottom.current = true;
    const log = scroller.current;
    if (log) scrollLog(log, log.scrollHeight);
  }, [companyId, roomId]);

  // The person's own message, sent: they see it go, at the newest.
  const sending = pending.length;
  const sentBefore = useRef(sending);
  useEffect(() => {
    if (sending > sentBefore.current) {
      if (held.current.hasAfter) void jump();
      else atBottom.current = true;
      hold();
    }
    sentBefore.current = sending;
  }, [sending]);

  // What waits beneath, read as the person reaches the end of what is drawn.
  useEffect(() => {
    const target = end.current;
    if (!target || !hasAfter) return undefined;
    const watch = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) void loadNewer(); }, { root: scroller.current });
    watch.observe(target);
    return () => watch.disconnect();
  }, [hasAfter, loadNewer, messages.length]);

  // Everything here read: up to the room's newest, whether or not it is drawn.
  const newestKnown = Math.max(messages.at(-1)?.position ?? 0, shownHere ? scope.room?.lastPosition ?? 0 : 0);
  const readAll = () => { if (newestKnown > 0) readTo(newestKnown); };
  useEscape(() => { if (escapeReads) readAll(); });

  // The line of new messages: above the first new message from someone else, when what is drawn reaches back to the
  // mark -- never above the first message drawn while more that is new lies above it.
  const firstNew = newFrom === null ? -1 : messages.findIndex((one) => one.position > newFrom);
  const lineAt = firstNew < 0 || (firstNew === 0 && hasBefore) ? null
    : messages.slice(firstNew).find((one) => counted(one, me)) ?? null;
  const waiting = unreadAtOpen > 0 && lineAt !== null && readPosition < newestKnown;
  // "99+" isolated (U+2066 to U+2069), so a right-to-left sentence does not read it as "+99".
  const newCount: Record<string, string> = unreadMore ? { count: `\u2066${count(ROOM_UNREAD_MOST)}+\u2069` } : {};

  const pins = scope.room?.pins ?? [];
  return (
    <Box className="rooms-timeline">
      {waiting && (
        <Group className="unread-bar" data-unread-bar justify="space-between" wrap="nowrap" gap="xs" px={{ base: 'xs', sm: 'md' }} py={4}>
          <Text size="xs" fw={600} truncate style={{ minWidth: 0, flex: '1 1 auto' }}>
            {tp('{count} new message since {time}', '{count} new messages since {time}', unreadAtOpen, { time: time(lineAt.createdAt), ...newCount })}
          </Text>
          {/* The button gives way as the words do, so a long label on a phone is cut short rather than cut off. */}
          <Button size="compact-xs" variant="subtle" data-mark-read onClick={readAll} style={{ flex: '0 1 auto', minWidth: 0, maxWidth: '50%' }}
            styles={{ inner: { minWidth: 0 }, label: { display: 'block', minWidth: 0, textOverflow: 'ellipsis' } }} title={t('Mark as read')}>{t('Mark as read')}</Button>
        </Group>
      )}
      <div
        role="log"
        aria-live="polite"
        aria-label={t('Messages')}
        className="rooms-log"
        ref={scroller}
        onScroll={() => {
          place();
          look();
        }}
      >
        <div ref={content}>
          {hasBefore && (
            <Group justify="center" py="xs">
              <Button size="compact-sm" variant="subtle" loading={older} onClick={() => void loadOlder()}>{t('Earlier messages')}</Button>
            </Group>
          )}
          {!loaded && !error && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
          {error && <Text c="red" size="sm" p="md">{error}</Text>}
          {loaded && messages.length === 0 && pending.length === 0 && (
            <Text c="dimmed" size="sm" p="xl" ta="center">{t('Nothing has been said here yet. Say hello.')}</Text>
          )}
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const newDay = !previous || new Date(previous.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
            const fresh = message.id === lineAt?.id;
            return (
              <Box key={message.id} data-room-position={message.position}>
                {newDay && <Divider my={6} mx="md" label={dayOf(message.createdAt)} labelPosition="center" />}
                {fresh && (
                  <Divider my={4} mx="md" color="red" labelPosition="right" data-new-line
                    label={<Text size="xs" c="red" fw={700}>{tp('{count} new message', '{count} new messages', Math.max(unreadAtOpen, 1), newCount)}</Text>} />
                )}
                <MessageRow
                  message={message}
                  compact={!newDay && !fresh && together(previous, message)}
                  pinned={pins.includes(message.id)}
                  editing={editing === message.id}
                  setEditing={(on) => setEditing(on ? message.id : null)}
                  focused={focused === message.position}
                />
              </Box>
            );
          })}
          {hasAfter && (
            <Group justify="center" py="xs">
              <Button size="compact-sm" variant="subtle" loading={newer} onClick={() => void loadNewer()}>{t('Later messages')}</Button>
            </Group>
          )}
          {!hasAfter && pending.filter((one) => one.threadOf === null || one.alsoInRoom).map((one) => <PendingRow key={one.clientId} pending={one} retry={retry} />)}
          <div ref={end} style={{ height: 1 }} />
        </div>
      </div>
      {far && loaded && (
        <Button className="jump-newest" data-jump size="compact-sm" radius="xl" leftSection={<IconArrowDown size={14} />} onClick={() => void jump()}>
          {t('Jump to newest')}
        </Button>
      )}
    </Box>
  );
}
