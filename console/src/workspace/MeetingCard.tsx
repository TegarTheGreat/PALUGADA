/**
 * Agent meetings in a room (F19.17, F19.18; STATUS 2.211).
 *
 * `MeetingCard` draws a meeting of the company's agents: the CEO's weekly
 * operating meeting, one quiet card in the company room, and a meeting called
 * about a message, drawn under that message as work is. It is read live from
 * the meeting's task every time the room is read, and holds no words of its
 * own: its week, its agenda counted from the facts it was handed, whether the
 * owner attends, and once it is over its record -- what the CEO wrote for the
 * owner, through Prose and said to be the CEO's -- and the to-dos it filed.
 * The owner may join it from here; its questions are then in its thread, put
 * to the owner alone, and the meeting goes on without an answer that does not
 * come in time.
 *
 * `CallMeeting` calls one about a message: the owner's or an approver's
 * press, never a keystroke, through the message's own door
 * (`…/messages/:id/meeting`). The Rooms page holds it, as it holds Ask the
 * team, so the room read again behind it takes away neither a refusal nor
 * the topic typed. From the composer the words are posted as the person's
 * own first, as Ask the team posts them, and it opens on the message once
 * kept: cancelling the meeting leaves the words in the room.
 */
import { useEffect, useState } from 'react';
import { Alert, Anchor, Avatar, Badge, Button, Group, Modal, Paper, Popover, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerStop, IconUsersGroup } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { count, STATUS_COLORS, statusLabel, whyStopped } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { rolePicture } from '../images.ts';
import { nameOf, useScope } from './scope.ts';
import type { CardView, MessageView } from './types.ts';

/** The longest topic the server takes: it is told to the meeting as an instruction is. */
const TOPIC_MAX = 2_000;

export function MeetingCard({ card, message }: { card: CardView; message: MessageView }) {
  const scope = useScope();
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const meeting = card.meeting;
  if (!meeting) return null;
  const stopped = card.whyStopped ? whyStopped(card.whyStopped, null).said : null;
  const failed = (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) });

  const join = async () => {
    if (!card.taskId) return;
    setBusy(true);
    try {
      await api('POST', `/api/companies/${scope.companyId}/meetings/${card.taskId}/join`, {});
      notifications.show({ color: 'teal', message: t('You joined. From its next step, its questions come to you, here and in your inbox.') });
      scope.changed();
    } catch (failure) {
      failed(failure);
    } finally {
      setBusy(false);
    }
  };

  // The owner stops a meeting by its task, as any work; the approver who called one, by its message.
  const stop = async () => {
    setBusy(true);
    try {
      if (scope.kind === 'owner' && card.taskId) {
        await api('POST', `/api/companies/${scope.companyId}/tasks/${card.taskId}/cancel`, {});
      } else {
        await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/stop`, {});
      }
      notifications.show({ color: 'teal', message: t('Cancelled, with everything it started.') });
      setStopping(false);
      scope.changed();
    } catch (failure) {
      failed(failure);
    } finally {
      setBusy(false);
    }
  };

  const agenda: Array<[string, number]> = [
    [t('Scorecard'), meeting.agenda.scorecard ?? 0],
    [t('Quarterly priorities'), meeting.agenda.priorities ?? 0],
    [t('To-dos'), meeting.agenda.todos ?? 0],
    [t('Issues'), meeting.agenda.issues ?? 0],
  ];
  // The week reads left to right and on one line in every console: isolated (U+2066 to U+2069) so a right-to-left
  // sentence does not turn "2026-W46" round, and joined with a hyphen that does not break (STATUS 2.218).
  const week = meeting.week ? `\u2066${meeting.week.replace(/-/g, '\u2011')}\u2069` : null;
  const title = meeting.called ? t('A meeting about this message')
    : week ? t('Weekly operating meeting, {week}', { week }) : t('Weekly operating meeting');

  return (
    <Paper withBorder radius="md" p="sm" mt={6} className="meeting-card" data-meeting={card.taskId ?? undefined} maw={560}
      style={{ borderInlineStart: '3px solid var(--mantine-color-grape-5)' }}>
      <Stack gap={6}>
        {/* What it is, who holds it, and where it is: wrapping on a narrow column rather than cut short. */}
        <Group gap="xs" wrap="wrap" justify="space-between" align="flex-start" style={{ rowGap: 4 }}>
          <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 10rem' }}>
            <Avatar size={28} radius="xl" src={rolePicture(card.role?.picture ?? 'agent')} alt="" style={{ flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="wrap" style={{ rowGap: 2 }}>
                <IconUsersGroup size={14} style={{ flexShrink: 0 }} />
                <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{title}</Text>
              </Group>
              <Group gap={6} wrap="wrap" style={{ rowGap: 2 }}>
                <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{card.role ? card.role.label : t('The company')}</Text>
                <Badge size="xs" variant="light" color="grape" radius="sm" style={{ flexShrink: 0 }}>{t('agent')}</Badge>
                {card.askedBy && <Text size="xs" c="dimmed">{t('called by {name}', { name: nameOf(card.askedBy) })}</Text>}
              </Group>
            </div>
          </Group>
          <Badge data-work-state={card.state} variant="light" color={STATUS_COLORS[card.state] ?? 'gray'} radius="sm" style={{ flexShrink: 0 }}>
            {statusLabel(card.state)}
          </Badge>
        </Group>
        <Group gap={6} wrap="wrap" aria-label={t('Agenda')}>
          {agenda.map(([label, n]) => (
            <Badge key={label} size="sm" variant="outline" color="gray" radius="sm" tt="none">
              {label} <span className="tabular">{count(n)}</span>
            </Badge>
          ))}
        </Group>
        {meeting.joined && meeting.joinMinutes !== null && (
          <Text size="xs" c="dimmed">
            {scope.kind === 'owner'
              // Both sentences on one line: the dictionary test reads a line at a time, and finds the plural through the first.
              ? tp('You attend: its questions come to you, and each waits {count} minute before the meeting goes on without your answer.', 'You attend: its questions come to you, and each waits {count} minutes before the meeting goes on without your answer.', meeting.joinMinutes)
              : t('The owner attends this meeting.')}
          </Text>
        )}
        {stopped && <Text size="xs" c="dimmed">{stopped}</Text>}
        {meeting.record && (
          <div>
            <Prose text={meeting.record} />
            {card.role && <Text size="xs" c="dimmed" mt={2}>{t('written by {role}', { role: card.role.label })}</Text>}
          </div>
        )}
        {meeting.todos.length > 0 && (
          <div>
            <Text size="xs" c="dimmed" fw={600}>{t('To-dos it filed')}</Text>
            {meeting.todos.map((todo) => <Prose key={todo.id} text={`- ${todo.title}`} size="xs" />)}
          </div>
        )}
        <Group gap="xs">
          {card.may.join && (
            <Button size="compact-xs" variant="light" loading={busy} onClick={() => void join()}>{t('Join')}</Button>
          )}
          {card.taskId && (
            <Button size="compact-xs" variant="subtle" onClick={() => scope.ctx.open('work', { item: card.taskId })}>{t('Open in Work')}</Button>
          )}
          {card.may.stop && (
            <Popover opened={stopping} onChange={setStopping} position="bottom-start" withArrow shadow="md">
              <Popover.Target>
                <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconPlayerStop size={12} />} onClick={() => setStopping((open) => !open)}>
                  {t('Stop')}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs" maw={240}>
                  <Text size="sm">{t('Cancel this task and everything it started?')}</Text>
                  <Button size="xs" color="red" loading={busy} onClick={() => void stop()}>{t('Cancel this task')}</Button>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}

export function CallMeeting({ calling, close }: {
  /** The message the meeting is to be called about, already kept in its room; null while it is closed. */
  calling: { message: MessageView } | null;
  close: () => void;
}) {
  const scope = useScope();
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const about = calling?.message ?? null;

  // Started afresh when it opens on a message, and only then: keyed by the message, never by the object that names
  // it, so the room drawn again behind it (as a refusal reads it again) keeps the refusal and what was typed.
  useEffect(() => {
    if (!about) return;
    setError(null);
    // The reader's own words are the topic to start from; someone else's are theirs, and are not put in the
    // reader's mouth: the topic is told to the meeting as the caller's own.
    setTopic(about.author.principal === scope.me ? about.body ?? '' : '');
  }, [about?.id]);

  const quietRoom = scope.room !== null && (scope.room.private || scope.room.kind === 'direct');
  const minutes = scope.ctx.company.rhythm.joinMinutes;

  const call = async () => {
    if (!about || !topic.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${about.roomId}/messages/${about.id}/meeting`, { topic: topic.trim() });
      notifications.show({ color: 'teal', message: t('The meeting is called. It shows under the message, and its record will be there when it ends.') });
      close();
      scope.changed();
    } catch (failure) {
      // A refusal may have left a line in the message's thread saying why, so the room is read again.
      setError(explain(failure));
      scope.changed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={about !== null} onClose={close} title={t('Call a meeting about this')} centered>
      <Stack data-call-meeting>
        <Text size="sm" c="dimmed">
          {t("The CEO holds a meeting of the company's agents about it, against the scorecard, the priorities, the to-dos and the issues, and files what follows. It reserves money from the CEO's budget, and a company calls at most three a day.")}
        </Text>
        <Textarea label={t('What the meeting is about')} autosize minRows={2} maxRows={8} maxLength={TOPIC_MAX} dir="auto"
          value={topic} onChange={(event) => setTopic(event.currentTarget.value)} data-autofocus />
        {scope.kind === 'owner' && (
          <Text size="sm" c="dimmed">
            {tp('You attend it: its questions come to you, and each waits {count} minute before it goes on without your answer.', 'You attend it: its questions come to you, and each waits {count} minutes before it goes on without your answer.', minutes)}
          </Text>
        )}
        {quietRoom && (
          <Alert variant="light" color="yellow">
            <Text size="sm">{t('This becomes company work: its words are visible to everyone in {company} and to its agents.', { company: scope.ctx.company.name })}</Text>
          </Alert>
        )}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Anchor component="button" type="button" size="sm" onClick={close}>{t('Cancel')}</Anchor>
          <Button data-call loading={busy} disabled={!topic.trim()} onClick={() => void call()}>{t('Call the meeting')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
