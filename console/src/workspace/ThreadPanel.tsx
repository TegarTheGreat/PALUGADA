/**
 * A thread: the message it began with, its replies and the cards in it
 * (F19.4, F19.6). Beside the room on a wide screen, in its place on a
 * narrower one, and a sheet over the room on a phone.
 *
 * In the thread of work the reader may steer, the composer offers "Tell the
 * work": the reply is posted as words, and only then, pressed, told to the
 * work as an instruction (STATUS 2.206), which its next run reads. Whoever
 * follows a thread is told of its replies; the reader follows or stops here.
 * A work's thread is read again whenever the work's own stream says it moved.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActionIcon, Box, Group, Loader, ScrollArea, Switch, Text } from '@mantine/core';
import { useDocumentVisibility } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { useLivePulse } from '../hooks.ts';
import { t } from '../i18n.ts';
import { Composer, type Sent } from './Composer.tsx';
import { MessageRow } from './MessageRow.tsx';
import { useScope } from './scope.ts';
import { PendingRow, usePosting, type Pending } from './Timeline.tsx';
import type { MessageView, ThreadView } from './types.ts';
import { useRoomPulse } from './useRoomStream.ts';

/** How often an open thread is read again when the room stream is refused (five tabs open already). */
const POLL_MS = 5_000;

export function ThreadPanel({ roomId, rootId, close, alone }: {
  roomId: string;
  rootId: string;
  close: () => void;
  /** Drawn in the room's place, with a way back to it, rather than beside it. */
  alone: boolean;
}) {
  const scope = useScope();
  const companyId = scope.companyId;
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef(0);

  const load = useCallback(async () => {
    try {
      setThread(await api('GET', `/api/companies/${companyId}/rooms/${roomId}/threads/${rootId}`));
      setError(null);
    } catch (failure) {
      setError(explain(failure));
    }
  }, [companyId, roomId, rootId]);
  useEffect(() => { void load(); }, [load, scope.tick]);
  // Read again when the room stream says the room changed: a frame names the message that changed, not its
  // thread, so any change in the room reads the thread (STATUS 2.210); on a clock only where the stream is refused.
  const changedHere = useRoomPulse(companyId, (frame) => 'room' in frame && frame.room === roomId && frame.kind !== 'read' && frame.kind !== 'member');
  useEffect(() => { if (changedHere.pulse > 0) void load(); }, [changedHere.pulse]);
  useEffect(() => {
    if (changedHere.live) return undefined;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void load(); }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, changedHere.live]);
  // A work's thread is read again the moment the work moves, so its progress and cards keep up with it.
  const taskId = thread?.root.card?.taskId ?? null;
  const pulse = useLivePulse(companyId, (event) => taskId !== null && event.taskId === taskId);
  useEffect(() => { if (pulse > 0) void load(); }, [pulse]);

  // Told to the work once the reply is kept; a refusal leaves it a reply, and says why.
  const kept = useCallback((message: MessageView, pending: Pending) => {
    if (pending.then === 'tell') {
      api('POST', `/api/companies/${companyId}/rooms/${roomId}/messages/${message.id}/tell`, {})
        .then(() => notifications.show({ color: 'teal', message: t('Recorded. It reads this when its next run starts.') }),
          (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }))
        .finally(() => scope.changed());
    } else {
      scope.changed();
    }
  }, [companyId, roomId, scope.changed]);
  const posting = usePosting(companyId, roomId, kept);
  const send = (sent: Sent) => {
    void posting.start({
      body: sent.body, mentions: sent.mentions, mentionsRoom: sent.mentionsRoom, alsoInRoom: sent.alsoInRoom,
      threadOf: rootId, then: sent.tell ? 'tell' : null,
    }).catch((failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }));
  };
  const retry = (pending: Pending) => {
    void posting.post(pending).catch((failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }));
  };

  const follow = async (on: boolean) => {
    try {
      await api('POST', `/api/companies/${companyId}/rooms/${roomId}/threads/${rootId}/follow`, { on });
      void load();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  // The thread's mentions of the reader are seen once its newest reply has been shown for a second in a tab that is
  // looked at; someone who has not joined the room is read for too, as the server sees what named them without a
  // mark (STATUS 2.206). Once read, the rail and the badges are read again, since their counts fell.
  const newest = thread?.replies.at(-1) ?? thread?.root;
  const shownHere = scope.room?.id === roomId;
  const visible = useDocumentVisibility() === 'visible';
  useEffect(() => {
    if (!newest) return;
    end.current?.scrollIntoView({ block: 'end' });
  }, [newest?.position]);
  useEffect(() => {
    if (!newest || newest.position <= seen.current || !shownHere || !visible) return;
    const timer = window.setTimeout(() => {
      seen.current = newest.position;
      void api('POST', `/api/companies/${companyId}/rooms/${roomId}/read`, { position: newest.position, threadOf: rootId })
        .then(() => scope.changed(), () => { seen.current = 0; });
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [newest?.position, shownHere, visible]);

  const mine = [...(thread?.replies ?? [])].reverse().find((one) => one.author.principal === scope.me && one.may.edit);
  const work = thread?.root.card?.kind === 'work' ? thread.root.card : null;

  return (
    <Box className="rooms-thread" data-pane="thread" data-alone={alone || undefined} component="aside" aria-label={t('Thread')}>
      <Group className="pane-head" justify="space-between" wrap="nowrap" px="md" py="xs">
        <Group gap="xs" wrap="nowrap">
          {(alone || scope.phone) && (
            <ActionIcon variant="subtle" color="gray" onClick={close} aria-label={t('Back to the room')}><IconArrowLeft size={18} /></ActionIcon>
          )}
          <Text fw={700}>{t('Thread')}</Text>
        </Group>
        <Group gap="xs" wrap="nowrap">
          {thread && <Switch size="xs" label={t('Follow')} checked={thread.following} onChange={(event) => void follow(event.currentTarget.checked)} />}
          {!alone && !scope.phone && (
            <ActionIcon variant="subtle" color="gray" onClick={close} aria-label={t('Close the thread')} data-close-thread><IconX size={18} /></ActionIcon>
          )}
        </Group>
      </Group>
      <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars="y">
        {!thread && !error && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
        {error && <Text c="red" size="sm" p="md">{error}</Text>}
        {thread && (
          <Box py="xs">
            <MessageRow message={thread.root} inThread pinned={(scope.room?.pins ?? []).includes(thread.root.id)} />
            {thread.progress && (
              <Box px="md" py={4} className="thread-progress">
                <Text size="xs" c="dimmed" fw={600}>{t('Where the work is')}</Text>
                <Prose text={thread.progress} size="xs" />
              </Box>
            )}
            <Text size="xs" c="dimmed" px="md" py={4}>{t('Replies')}</Text>
            {thread.replies.map((reply) => (
              <MessageRow key={reply.id} message={reply} inThread editing={editing === reply.id}
                setEditing={(on) => setEditing(on ? reply.id : null)} />
            ))}
            {posting.pending.map((one) => <PendingRow key={one.clientId} pending={one} retry={retry} />)}
            <div ref={end} />
          </Box>
        )}
      </ScrollArea>
      {scope.room && !scope.room.archived && scope.room.joined && (
        <Composer
          roomId={roomId}
          threadOf={rootId}
          placeholder={t('Reply in the thread')}
          send={send}
          tellable={Boolean(work?.may.tell)}
          {...(mine ? { editLast: () => setEditing(mine.id) } : {})}
        />
      )}
    </Box>
  );
}
