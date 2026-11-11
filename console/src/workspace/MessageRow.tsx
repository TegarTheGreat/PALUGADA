/**
 * One message in a room or a thread (F19.4, F19.5, F19.21).
 *
 * A person's words are drawn with their picture, their name and always,
 * beside it, their handle, under a chip read from the principal: the owner
 * is the owner because the session that wrote it was the owner's, never
 * because of a name, so a seat called "Owner" is still drawn as staff. The
 * words go through Prose, isolated from the text around them so a name
 * written right to left cannot turn the line round. A card is the work it
 * points at, read live; a notice is said in the reader's language.
 *
 * What may be done with a message is what the server says the reader may
 * (`MessageView.may`): pressed from a menu on a desktop, and on a phone from
 * a sheet that a long press opens, or the message's one button beside it,
 * which a keyboard, a screen reader and a narrow window without touch reach
 * too. No action is a keystroke.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ActionIcon, Anchor, Avatar, Badge, Box, Button, Drawer, Group, Menu, Modal, NavLink, Stack, Text, Textarea, Tooltip, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconCopy, IconDots, IconFileDescription, IconHistory, IconMessageReply, IconMoodSmile, IconPencil, IconPin, IconPinnedOff,
  IconPlayerStop, IconSparkles, IconTrash, IconUsersGroup,
} from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose, type Mention } from '../components/Prose.tsx';
import { dateTime, relative } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { EmojiPicker } from './EmojiPicker.tsx';
import { QUICK_REACTIONS } from './emoji.ts';
import { MeetingCard } from './MeetingCard.tsx';
import { NoticeRow } from './NoticeRow.tsx';
import { QuestionCard } from './QuestionCard.tsx';
import { RoomFiles } from './RoomFiles.tsx';
import { personPicture } from '../images.ts';
import { nameOf, tokenOf, useScope } from './scope.ts';
import type { MessageView } from './types.ts';
import { WorkState } from './WorkState.tsx';

/** How long a finger rests on a message before its actions open, on a phone. */
const LONG_PRESS_MS = 500;

/** One thing that may be done with a message, as both the menu and the sheet draw it. */
interface Action {
  id: string;
  label: string;
  icon: ReactNode;
  run: () => void;
  color?: string;
}

export function MessageRow({ message, compact = false, inThread = false, pinned = false, editing = false, setEditing }: {
  message: MessageView;
  /** The same person, the same minute, as the message above: drawn without their picture and name again. */
  compact?: boolean;
  /** Drawn in a thread: no thread summary under it, and no "reply in thread". */
  inThread?: boolean;
  pinned?: boolean;
  /** Being edited, as ↑ in an empty composer asks. */
  editing?: boolean;
  setEditing?: (editing: boolean) => void;
}) {
  const scope = useScope();
  const [sheet, setSheet] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [history, setHistory] = useState<Array<{ body: string; replacedAt: string }> | null>(null);
  const [words, setWords] = useState(message.body ?? '');
  const pressing = useRef<number | undefined>(undefined);
  const author = message.author;
  // An edit starts from the words as they are now, however it was opened (the menu, or ↑ in the composer): the
  // message may have been edited since the row was first drawn, and saving the older words would undo that.
  useEffect(() => { if (editing) setWords(message.body ?? ''); }, [editing]);

  if (message.kind === 'notice' && message.notice) {
    return <Box className="message-row" data-message={message.id} px={{ base: 'xs', sm: 'md' }}><NoticeRow notice={message.notice} /></Box>;
  }

  const failed = (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) });
  const react = async (emoji: string, on: boolean) => {
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/react`, { emoji, on });
      scope.changed();
    } catch (failure) {
      failed(failure);
    }
  };
  const pin = async () => {
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/pin`, { on: !pinned });
      scope.changed();
    } catch (failure) {
      failed(failure);
    }
  };
  const edit = async () => {
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/edit`, { body: words });
      setEditing?.(false);
      scope.changed();
    } catch (failure) {
      failed(failure);
    }
  };
  const remove = async () => {
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/delete`, {});
      setDeleting(false);
      scope.changed();
    } catch (failure) {
      failed(failure);
    }
  };
  const showHistory = async () => {
    try {
      const answer: { revisions: Array<{ body: string; replacedAt: string }> } = await api('GET', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/history`);
      setHistory(answer.revisions);
    } catch (failure) {
      failed(failure);
    }
  };
  // Only the owner's own words, typed here, are filed as the owner's issue (F19.9): the server holds the same.
  const fileAsIssue = async () => {
    const title = (message.body ?? '').split('\n')[0]!.slice(0, 120);
    try {
      await api('POST', `/api/companies/${scope.companyId}/tickets`, {
        title, kind: 'issue', fromMessage: { roomId: message.roomId, messageId: message.id },
      });
      notifications.show({ color: 'teal', message: t('Filed as an issue. It is on Work, under Issues.') });
    } catch (failure) {
      failed(failure);
    }
  };
  const stop = async () => {
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/stop`, {});
      notifications.show({ color: 'teal', message: t('Cancelled, with everything it started.') });
      scope.changed();
    } catch (failure) {
      failed(failure);
    }
  };

  const text = message.kind === 'text' && !message.deleted;
  const actions: Action[] = [
    ...(!inThread && message.threadOf === null ? [{ id: 'reply', label: t('Reply in thread'), icon: <IconMessageReply size={16} />, run: () => scope.openThread(message.id) }] : []),
    ...(text ? [{ id: 'react', label: t('React'), icon: <IconMoodSmile size={16} />, run: () => setReacting(true) }] : []),
    ...(text && message.body ? [{ id: 'copy', label: t('Copy'), icon: <IconCopy size={16} />, run: () => { void navigator.clipboard?.writeText(message.body ?? ''); } }] : []),
    ...(message.may.edit ? [{ id: 'edit', label: t('Edit'), icon: <IconPencil size={16} />, run: () => setEditing?.(true) }] : []),
    ...(message.may.pin ? [{ id: 'pin', label: pinned ? t('Unpin') : t('Pin'), icon: pinned ? <IconPinnedOff size={16} /> : <IconPin size={16} />, run: () => void pin() }] : []),
    ...(message.may.giveAsWork ? [{ id: 'work', label: t('Ask the team about this'), icon: <IconSparkles size={16} />, run: () => scope.askWork(message) }] : []),
    // A seat stops only work it asked for, by its message; the owner stops any, here or under the work.
    ...(message.may.stop && scope.kind !== 'owner' ? [{ id: 'stop', label: t('Stop the work'), icon: <IconPlayerStop size={16} />, run: () => void stop(), color: 'red' }] : []),
    ...(message.may.fileAsIssue ? [{ id: 'issue', label: t('File as an issue'), icon: <IconFileDescription size={16} />, run: () => void fileAsIssue() }] : []),
    ...(message.may.history ? [{ id: 'history', label: t('What it said before'), icon: <IconHistory size={16} />, run: () => void showHistory() }] : []),
    // A meeting of the company's agents called about this message (section 2.211); a people's meeting set from it
    // (section 2.215) is added here.
    ...(message.may.callMeeting ? [{ id: 'meeting', label: t('Call a meeting about this'), icon: <IconUsersGroup size={16} />, run: () => scope.callMeeting(message) }] : []),
    ...(message.may.delete ? [{ id: 'delete', label: t('Delete'), icon: <IconTrash size={16} />, run: () => setDeleting(true), color: 'red' }] : []),
  ];

  // A finger held on a message opens its actions, on a phone; a scroll or a lift before then does not.
  const touch = {
    onTouchStart: () => {
      if (!scope.phone || actions.length === 0) return;
      pressing.current = window.setTimeout(() => { pressing.current = undefined; setSheet(true); }, LONG_PRESS_MS);
    },
    onTouchEnd: () => { if (pressing.current !== undefined) window.clearTimeout(pressing.current); },
    onTouchMove: () => { if (pressing.current !== undefined) window.clearTimeout(pressing.current); },
  };

  const chip = author.principal === 'owner'
    ? <Badge data-chip="owner" size="xs" variant="filled" color="brand" radius="sm">{t('Owner')}</Badge>
    : author.principal.startsWith('seat:')
      ? <Badge data-chip="staff" size="xs" variant="light" color="gray" radius="sm">{t('Staff')}</Badge>
      : null;
  const handle = 'handle' in author && author.handle ? author.handle : null;
  const said = author.principal === 'platform' ? 'PALUGADA' : 'former' in author ? author.name : nameOf(author);
  const picture = author.principal === 'platform' ? '/brand/palugada-app-icon.svg' : personPicture(author.principal, 'picture' in author ? author.picture : null);

  // The people the words told, marked where they are named: the reader most strongly, and the room when it was called.
  const named: Mention[] = [
    ...message.mentions.map((person) => ({ token: tokenOf(person).slice(1), principal: person.principal, mine: person.principal === scope.me })),
    ...(message.mentionsRoom ? [{ token: 'room', principal: 'room', mine: author.principal !== scope.me }] : []),
  ].filter((one) => one.token.length > 0);
  // The room was called without `@room` in the words (a relay may say so): said beneath them instead.
  const roomUnwritten = message.mentionsRoom && !/(^|[^\w@])@room(?![\w-])/iu.test(message.body ?? '');
  // Words addressed to the reader stand out from the rest: named by them, or the whole room called by someone else.
  const forMe = author.principal !== scope.me
    && (message.mentions.some((person) => person.principal === scope.me) || message.mentionsRoom);

  return (
    <Box className="message-row" data-message={message.id} data-compact={compact || undefined} data-for-me={forMe || undefined}
      px={{ base: 'xs', sm: 'md' }} py={compact ? 1 : 6} {...touch}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box w={36} style={{ flexShrink: 0 }}>
          {!compact && <Avatar size={36} radius="xl" src={picture} alt="" />}
        </Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          {!compact && (
            <Group gap={6} wrap="wrap" align="baseline">
              {author.principal !== 'owner' && <Text size="sm" fw={700} className="message-author">{said}</Text>}
              {handle && <Text size="xs" c="dimmed" data-handle dir="ltr">@{handle}</Text>}
              {chip}
              {'former' in author && <Badge size="xs" variant="outline" color="gray" radius="sm">{t('imported')}</Badge>}
              <Tooltip label={dateTime(message.createdAt)} openDelay={300}>
                <Text size="xs" c="dimmed">{relative(message.createdAt)}</Text>
              </Tooltip>
              {message.via === 'relay' && <Text size="xs" c="dimmed">{t('via relay')}</Text>}
              {message.via === 'import' && <Text size="xs" c="dimmed">{t('imported')}</Text>}
              {pinned && <IconPin size={12} color="var(--mantine-color-dimmed)" aria-label={t('Pinned')} />}
            </Group>
          )}
          {message.deleted ? (
            <Text size="sm" c="dimmed" fs="italic">
              {message.expired ? t('Removed when its time was up.') : t('This message was removed.')}
            </Text>
          ) : editing ? (
            <Stack gap={6} mt={4}>
              <Textarea autosize minRows={1} maxRows={8} value={words} onChange={(event) => setWords(event.currentTarget.value)} autoFocus dir="auto" />
              <Group gap="xs" justify="flex-end">
                <Button size="compact-sm" variant="default" onClick={() => setEditing?.(false)}>{t('Cancel')}</Button>
                <Button size="compact-sm" disabled={!words.trim() || words === message.body} onClick={() => void edit()}>{t('Save')}</Button>
              </Group>
            </Stack>
          ) : message.body ? (
            // A message of files alone says nothing, and draws no words.
            <Box className="message-body" dir="auto">
              <Prose text={message.body} mentions={named} />
              {(message.edited || roomUnwritten) && (
                <Group gap={6} mt={2}>
                  {roomUnwritten && <Badge size="xs" variant="light" color="orange" radius="sm" tt="none">@room</Badge>}
                  {message.edited && (message.may.history
                    ? <Anchor component="button" type="button" size="xs" c="dimmed" onClick={() => void showHistory()}>{t('edited')}</Anchor>
                    : <Text size="xs" c="dimmed">{t('edited')}</Text>)}
                </Group>
              )}
            </Box>
          ) : null}
          <RoomFiles roomId={message.roomId} files={message.files} removed={message.deleted} />
          {/* A people's meeting set from this message (section 2.215) is drawn here. */}
          {message.card && (message.card.kind === 'work'
            ? <WorkState card={message.card} message={message} />
            : message.card.kind === 'question' ? <QuestionCard card={message.card} />
              : message.card.kind === 'approval' ? <ApprovalCard card={message.card} />
                : message.card.kind === 'meeting' ? <MeetingCard card={message.card} message={message} />
                  : null)}
          {message.reactions.length > 0 && (
            <Group gap={4} mt={4}>
              {message.reactions.map((one) => (
                <UnstyledButton key={one.emoji} className="reaction" data-mine={one.mine || undefined} onClick={() => void react(one.emoji, !one.mine)}
                  aria-label={tp('{emoji}: {count} person', '{emoji}: {count} people', one.count, { emoji: one.emoji })} disabled={!text}>
                  {one.emoji} <span className="tabular">{one.count}</span>
                </UnstyledButton>
              ))}
            </Group>
          )}
          {!inThread && message.replies && (
            <UnstyledButton data-replies={message.id} className="thread-summary" mt={4} onClick={() => scope.openThread(message.id)}>
              <Text size="xs" c="brand" fw={600} span>{tp('{count} reply', '{count} replies', message.replies.count)}</Text>
              {message.replies.lastAt && <Text size="xs" c="dimmed" span> · {t('last {time}', { time: relative(message.replies.lastAt) })}</Text>}
            </UnstyledButton>
          )}
        </Box>
        {actions.length > 0 && !editing && scope.phone && (
          <Group gap={0} className="message-actions" wrap="nowrap">
            <ActionIcon size="sm" variant="subtle" color="gray" data-actions={message.id} aria-label={t('More actions')} onClick={() => setSheet(true)}>
              <IconDots size={16} />
            </ActionIcon>
          </Group>
        )}
        {actions.length > 0 && !editing && !scope.phone && (
          <Group gap={0} className="message-actions" wrap="nowrap">
            {text && (
              <EmojiPicker opened={reacting} setOpened={setReacting} pick={(emoji) => void react(emoji, true)} target={
                <ActionIcon size="sm" variant="subtle" color="gray" aria-label={t('React')} onClick={() => setReacting((open) => !open)}>
                  <IconMoodSmile size={16} />
                </ActionIcon>
              } />
            )}
            <Menu position="bottom-end" withinPortal shadow="md">
              <Menu.Target>
                <ActionIcon size="sm" variant="subtle" color="gray" data-actions={message.id} aria-label={t('More actions')}>
                  <IconDots size={16} />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                {text && (
                  <Group gap={2} px={6} py={4}>
                    {QUICK_REACTIONS.map((emoji) => (
                      <Menu.Item key={emoji} p={4} w="auto" onClick={() => void react(emoji, true)} aria-label={emoji}>{emoji}</Menu.Item>
                    ))}
                  </Group>
                )}
                {actions.filter((one) => one.id !== 'react').map((one) => (
                  <Menu.Item key={one.id} data-action={one.id} leftSection={one.icon} color={one.color} onClick={one.run}>{one.label}</Menu.Item>
                ))}
              </Menu.Dropdown>
            </Menu>
          </Group>
        )}
      </Group>

      {/* As tall as what it offers, so the message it acts on stays in sight above it. */}
      <Drawer opened={sheet} onClose={() => setSheet(false)} position="bottom" radius="lg" withCloseButton={false}
        styles={{ content: { flex: '0 0 auto', height: 'auto', maxHeight: '80dvh' } }}>
        {text && (
          <Group gap={4} justify="center" pb="xs">
            {QUICK_REACTIONS.map((emoji) => (
              <ActionIcon key={emoji} size="xl" variant="subtle" color="gray" aria-label={emoji} onClick={() => { setSheet(false); void react(emoji, true); }}>
                <span className="emoji-choice">{emoji}</span>
              </ActionIcon>
            ))}
          </Group>
        )}
        <Stack gap={2} pb="md">
          {actions.filter((one) => one.id !== 'react').map((one) => (
            <NavLink key={one.id} data-action={one.id} label={one.label} leftSection={one.icon} c={one.color}
              onClick={() => { setSheet(false); one.run(); }} />
          ))}
        </Stack>
      </Drawer>

      <Modal opened={deleting} onClose={() => setDeleting(false)} title={t('Delete this message?')} centered>
        <Text size="sm">{t('Its words are gone for everyone, now. The room keeps a line saying a message was removed.')}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setDeleting(false)}>{t('Keep it')}</Button>
          <Button color="red" onClick={() => void remove()}>{t('Delete')}</Button>
        </Group>
      </Modal>

      <Modal opened={history !== null} onClose={() => setHistory(null)} title={t('What it said before')} centered>
        <Stack gap="sm">
          {(history ?? []).map((one) => (
            <Box key={one.replacedAt}>
              <Text size="xs" c="dimmed">{t('Replaced {time}', { time: dateTime(one.replacedAt) })}</Text>
              <Prose text={one.body} />
            </Box>
          ))}
          {history?.length === 0 && <Text size="sm" c="dimmed">{t('Nothing it said before is kept.')}</Text>}
        </Stack>
      </Modal>
    </Box>
  );
}
