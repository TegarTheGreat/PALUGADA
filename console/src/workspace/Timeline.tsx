/**
 * A room's messages, oldest at the top (F19.4, F19.10).
 *
 * Read from the server a page at a time, the newest first and earlier ones
 * as the person asks; read again the moment the room stream says the room
 * changed (STATUS 2.210), so a colleague's words arrive and a card shows its
 * work moving, and every five seconds while the tab is seen only while the
 * stream is not heard (refused, down, or not yet open). Grouped by author
 * and minute, divided by day, with a "New" line at the person's read mark
 * as it was when the room was opened. A room is
 * marked read only once its newest message has been in view for a second,
 * or when the person presses Esc in it, and the mark only ever rises. Work
 * asked for here is read again the moment the company's live stream says it
 * moved, so its card changes as the work does.
 *
 * A message being sent is drawn at once and replaced by the server's copy;
 * one that failed says so and is sent again, with the same client id, so
 * the server keeps it once however often it is tried.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Button, Divider, Group, Loader, Text } from '@mantine/core';
import { useHotkeys } from '@mantine/hooks';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { day } from '../format.ts';
import { useLivePulse } from '../hooks.ts';
import { t } from '../i18n.ts';
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
  /** What to do once it is kept: ask the team about it, call a meeting about it, or tell it to the thread's work. */
  then: 'ask' | 'meeting' | 'tell' | null;
}

/** How often an open room is read again while the room stream is not heard: refused for five tabs open already, or down. */
const POLL_MS = 5_000;
/** How long the newest message is in view before the room counts as read. */
const SEEN_MS = 1_000;

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

export function Timeline({ roomId, pending, retry, editing, setEditing, shown, escapeReads }: {
  roomId: string;
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
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [readPosition, setReadPosition] = useState(0);
  const [newFrom, setNewFrom] = useState<number | null>(null);
  const [hasBefore, setHasBefore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const first = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [older, setOlder] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const lastSeen = useRef(0);

  const latest = useCallback(async () => {
    try {
      const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?limit=50`);
      setMessages((now) => merged(now, page.messages));
      setReadPosition(page.readPosition);
      setNewFrom((now) => (now === null ? page.readPosition : now));
      // Whether there is more above is the first page's to say; later reads of the newest do not know.
      if (first.current) setHasBefore(page.hasBefore);
      first.current = false;
      setLoaded(true);
      setError(null);
    } catch (failure) {
      setError(explain(failure));
    }
  }, [companyId, roomId]);

  // Read when opened, when something changed here (a post, a press, an edit), and the moment the room stream says
  // the room changed (STATUS 2.210); every few seconds only while the stream is not heard.
  useEffect(() => { void latest(); }, [latest, scope.tick]);
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

  const loadOlder = async () => {
    const top = messages[0];
    if (!top) return;
    setOlder(true);
    const box = scroller.current;
    const from = box ? box.scrollHeight - box.scrollTop : 0;
    try {
      const page: MessagePage = await api('GET', `/api/companies/${companyId}/rooms/${roomId}/messages?before=${top.position}&limit=50`);
      setMessages((now) => merged(now, page.messages));
      setHasBefore(page.hasBefore);
      // Kept where the person was reading, not jumped to the new top.
      requestAnimationFrame(() => { if (box) box.scrollTop = box.scrollHeight - from; });
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setOlder(false);
    }
  };

  useEffect(() => { shown(messages); }, [messages, shown]);

  // Down to the newest as it arrives, unless the person has scrolled up to read.
  useEffect(() => {
    if (atBottom.current) end.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, pending.length]);

  // The room read up to its newest message; a mark the server already has is not sent again. Someone who has not
  // joined the room is read for too: the server keeps them no mark, but sees what named them (STATUS 2.206).
  const newest = messages.at(-1);
  const shownHere = scope.room?.id === roomId;
  const readTo = (position: number) => {
    if (!shownHere || position <= Math.max(readPosition, lastSeen.current)) return;
    lastSeen.current = position;
    api('POST', `/api/companies/${companyId}/rooms/${roomId}/read`, { position })
      .then((answer: { readPosition: number }) => {
        setReadPosition(answer.readPosition);
        scope.ctx.refreshUnread();
      }, () => { lastSeen.current = 0; });
  };
  useHotkeys([['Escape', () => { if (escapeReads && newest) readTo(newest.position); }]]);

  // Read once the newest has been in view for a second.
  useEffect(() => {
    const target = end.current;
    if (!target || !newest || !shownHere) return undefined;
    let timer: number | undefined;
    const watch = new IntersectionObserver(([entry]) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
      if (!entry?.isIntersecting || document.visibilityState !== 'visible') return;
      timer = window.setTimeout(() => readTo(newest.position), SEEN_MS);
    });
    watch.observe(target);
    return () => {
      watch.disconnect();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [newest?.position, readPosition, shownHere, companyId, roomId]);

  const pins = scope.room?.pins ?? [];
  return (
    <div
      role="log"
      aria-live="polite"
      aria-label={t('Messages')}
      className="rooms-log"
      ref={scroller}
      onScroll={(event) => {
        const box = event.currentTarget;
        atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      }}
    >
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
        const before = messages[index - 1];
        const newDay = !before || new Date(before.createdAt).toDateString() !== new Date(message.createdAt).toDateString();
        const fresh = newFrom !== null && message.position > newFrom && (!before || before.position <= newFrom)
          && message.author.principal !== scope.me;
        return (
          <Box key={message.id}>
            {newDay && <Divider my={6} mx="md" label={dayOf(message.createdAt)} labelPosition="center" />}
            {fresh && <Divider my={4} mx="md" color="red" label={<Text size="xs" c="red" fw={700}>{t('New')}</Text>} labelPosition="right" data-new />}
            <MessageRow
              message={message}
              compact={!newDay && !fresh && together(before, message)}
              pinned={pins.includes(message.id)}
              editing={editing === message.id}
              setEditing={(on) => setEditing(on ? message.id : null)}
            />
          </Box>
        );
      })}
      {pending.filter((one) => one.threadOf === null || one.alsoInRoom).map((one) => <PendingRow key={one.clientId} pending={one} retry={retry} />)}
      <div ref={end} style={{ height: 1 }} />
    </div>
  );
}
