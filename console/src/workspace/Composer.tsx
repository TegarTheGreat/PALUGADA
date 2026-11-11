/**
 * Where a person writes in a room or a thread (F19.4, F19.6).
 *
 * On a desktop Enter sends and Shift+Enter breaks the line; on a phone Enter
 * breaks the line and the button sends. Enter never sends while an input
 * method is still composing a word, nor while the mention picker is open,
 * where it chooses. Telling the work is never sent by Enter: it is pressed.
 * A slash command only opens what it names, and only for someone who may
 * use it: a viewer's `/task` is kept as typed, and the composer says who
 * may ask. What is not sent yet stays with the room in this tab's memory,
 * and is gone with the tab.
 *
 * Up to five files go with a message, 24 MB together (STATUS 2.212): chosen
 * from the device, or on a phone taken with its camera. They are read into
 * this tab's memory only until the message is sent.
 *
 * The words keep their own direction as they are typed, whatever the
 * console's is. The text area is the mention list's combobox: while the
 * list is open it says so, names the list and the person the arrows are on,
 * so a screen reader follows the choice as a sighted person does.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ActionIcon, Alert, Box, Button, Checkbox, Group, SegmentedControl, Text, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowUp, IconCamera, IconMoodSmile, IconPaperclip, IconSparkles, IconUsersGroup, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { readForUpload } from '../files.ts';
import { count, fileSize } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { EmojiPicker } from './EmojiPicker.tsx';
import { mentionAt, mentionChoices, MentionPicker, optionId, type MentionChoice } from './MentionPicker.tsx';
import { mayAsk, useScope } from './scope.ts';

/** A message's longest, as the server holds it (STATUS 2.206). */
const BODY_MAX = 8_000;
/** Past this, the composer says how much is left. */
const COUNT_FROM = 7_000;
/** `@room` asks before it tells more people than this. */
const ROOM_ASKS_FROM = 10;
/** How many files a message carries, and their bytes together, as the server holds them. */
const FILES_MOST = 5;
const FILES_BYTES = 24 * 1024 * 1024;

/** A file chosen to go with the message: its name and its bytes, read into this tab's memory. */
export interface Attached {
  name: string;
  data: string;
  size: number;
}

/** Unsent words, by room and thread: this tab's memory only. */
const drafts = new Map<string, string>();

export interface Sent {
  body: string;
  mentions: string[];
  mentionsRoom: boolean;
  alsoInRoom: boolean;
  /** Told to the thread's work, once it is posted. */
  tell: boolean;
  /** The files that go with it. */
  files: Attached[];
}

export function Composer({ roomId, threadOf = null, placeholder, send, ask, meet, editLast, tellable = false, disabled = false }: {
  roomId: string;
  threadOf?: string | null;
  placeholder: string;
  send: (sent: Sent) => void;
  /** Ask the team: the words are posted, then the drawer that gives them as work opens; with none, it opens empty. */
  ask?: (body: string) => void;
  /**
   * Call a meeting about these words (STATUS 2.211): they are posted as the person's own, then the dialog that calls
   * the meeting opens on the message, so cancelling it leaves them in the room.
   */
  meet?: (body: string) => void;
  /** ↑ in an empty composer: edit your last message. */
  editLast?: () => void;
  /** A thread of work the reader may tell (F19.6). */
  tellable?: boolean;
  disabled?: boolean;
}) {
  const scope = useScope();
  const key = `${roomId}~${threadOf ?? ''}`;
  const [value, setValue] = useState(() => drafts.get(key) ?? '');
  const [chosen, setChosen] = useState<Array<{ principal: string; token: string }>>([]);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [emoji, setEmoji] = useState(false);
  const [mode, setMode] = useState<'message' | 'tell'>('message');
  const [alsoInRoom, setAlsoInRoom] = useState(false);
  const [files, setFiles] = useState<Attached[]>([]);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const listId = useId();
  // Where the caret goes once a chosen name or emoji is written in. Placed as the words are drawn, before the
  // next key is read: placed a frame later, a key typed at once lands before the caret moves back over it.
  const caretTo = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (caretTo.current === null) return;
    box.current?.focus();
    box.current?.setSelectionRange(caretTo.current, caretTo.current);
    caretTo.current = null;
  }, [value]);

  useEffect(() => { drafts.set(key, value); }, [key, value]);

  const room = scope.room;
  const typing = mentionAt(value, caret);
  const choices = typing && typing.start !== closedAt
    ? mentionChoices(scope.people, typing.query, (room?.members ?? []).map((one) => one.principal), Boolean(room?.may.mentionRoom))
    : [];
  const picking = choices.length > 0;
  const quietRoom = room !== null && (room.private || room.kind === 'direct');

  const change = (next: string, at: number) => {
    // Words at the limit that a choice cannot add to: the caret stays where it is.
    if (next.slice(0, BODY_MAX) === value) caretTo.current = null;
    setValue(next.slice(0, BODY_MAX));
    setCaret(at);
    setActive(0);
    if (closedAt !== null && !mentionAt(next, at)) setClosedAt(null);
  };

  const pick = (choice: MentionChoice) => {
    if (!typing) return;
    const written = `${choice.token} `;
    const next = value.slice(0, typing.start) + written + value.slice(caret);
    const at = typing.start + written.length;
    if ('person' in choice) setChosen((now) => [...now.filter((one) => one.principal !== choice.person.principal), { principal: choice.person.principal, token: choice.token }]);
    caretTo.current = at;
    setValue(next);
    setCaret(at);
  };

  const insert = (text: string) => {
    const element = box.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    caretTo.current = start + text.length;
    change(value.slice(0, start) + text + value.slice(end), start + text.length);
  };

  // Files chosen, or a picture taken, added to those already chosen: never more than a message carries.
  const attach = async (chosen: FileList | null) => {
    const list = [...(chosen ?? [])];
    if (list.length === 0) return;
    const total = [...files.map((one) => one.size), ...list.map((one) => one.size)].reduce((sum, size) => sum + size, 0);
    if (files.length + list.length > FILES_MOST || total > FILES_BYTES) {
      notifications.show({ color: 'yellow', message: t('A message carries up to five files, 24 MB in all.') });
      return;
    }
    try {
      const read = await Promise.all(list.map(async (file) => ({ ...await readForUpload(file), size: file.size })));
      setFiles((now) => [...now, ...read]);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const submit = () => {
    const body = value.trim();
    if ((!body && files.length === 0) || disabled) return;
    // A slash command opens what it names, and sends nothing. A viewer may not ask for work: the words stay as they
    // were typed, to be changed or sent as they are, and the composer says who may ask.
    const command = /^\/(task|tugas)(?:\s+([\s\S]*))?$/.exec(body);
    if (command && ask) {
      if (!mayAsk(scope.kind)) {
        notifications.show({ color: 'yellow', message: t('Asking the team for work is for members and approvers.') });
        return;
      }
      ask(command[2]?.trim() ?? '');
      setValue('');
      return;
    }
    if (/^\/mute$/.test(body)) {
      setValue('');
      // Quiet for a day, as the room's settings would make it.
      api('POST', `/api/companies/${scope.companyId}/rooms/${roomId}/settings`, { mutedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() })
        .then(() => {
          notifications.show({ color: 'teal', message: t('This room is quiet until this time tomorrow.') });
          scope.changed();
        }, (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }));
      return;
    }
    const everyone = /(^|\s)@room(\s|$)/.test(body) && Boolean(room?.may.mentionRoom);
    const others = (room?.members.length ?? 1) - 1;
    if (everyone && others > ROOM_ASKS_FROM
      && !window.confirm(tp('Notify {count} person?', 'Notify {count} people?', others))) return;
    send({
      body,
      // Only the people still named in the words: one written and then taken out is not mentioned.
      mentions: chosen.filter((one) => body.includes(one.token)).map((one) => one.principal),
      mentionsRoom: everyone,
      alsoInRoom: threadOf !== null && alsoInRoom,
      tell: mode === 'tell',
      files,
    });
    setValue('');
    setChosen([]);
    setFiles([]);
    setMode('message');
  };

  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Alt with an arrow goes to another room (Rooms.tsx), whatever is being typed.
    if (event.altKey) return;
    if (picking) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActive((now) => (now + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        pick(choices[Math.min(active, choices.length - 1)]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setClosedAt(typing?.start ?? null);
        return;
      }
    }
    if (event.key === 'ArrowUp' && value === '' && editLast) {
      event.preventDefault();
      editLast();
      return;
    }
    if (event.key !== 'Enter') return;
    // A word still being composed by an input method: its Enter is the method's.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.shiftKey || scope.phone || mode === 'tell') return;
    event.preventDefault();
    submit();
  };

  return (
    <Box className="composer" px={{ base: 'xs', sm: 'md' }} pb={{ base: 'xs', sm: 'md' }} pt={6}>
      {picking && <MentionPicker id={listId} choices={choices} active={Math.min(active, choices.length - 1)} pick={pick} />}
      {tellable && (
        <SegmentedControl size="xs" mb={6} value={mode} onChange={(next) => setMode(next as 'message' | 'tell')}
          data={[{ value: 'message', label: t('Message people') }, { value: 'tell', label: t('Tell the work') }]} />
      )}
      {mode === 'tell' && quietRoom && (
        <Alert variant="light" color="yellow" p="xs" mb={6}>
          <Text size="xs">{t('This becomes company work: its words are visible to everyone in {company} and to its agents.', { company: scope.ctx.company.name })}</Text>
        </Alert>
      )}
      {files.length > 0 && (
        <Group gap={6} mb={6} data-attached>
          {files.map((file, index) => (
            <Group key={`${file.name}-${index}`} gap={4} wrap="nowrap" className="attached-file">
              <Text size="xs" truncate maw={180} dir="auto">{file.name}</Text>
              <Text size="xs" c="dimmed">{fileSize(file.size)}</Text>
              <ActionIcon size="xs" variant="subtle" color="gray" aria-label={t('Remove {name}', { name: file.name })}
                onClick={() => setFiles((now) => now.filter((_, at) => at !== index))}>
                <IconX size={12} />
              </ActionIcon>
            </Group>
          ))}
        </Group>
      )}
      {value.length > COUNT_FROM && (
        <Text size="xs" c={value.length >= BODY_MAX ? 'red' : 'dimmed'} ta="end" mb={2}>
          {t('{used} of {max} characters', { used: count(value.length), max: count(BODY_MAX) })}
        </Text>
      )}
      <Group gap={6} align="flex-end" wrap="nowrap">
        <Textarea
          ref={box}
          data-composer
          style={{ flex: 1 }}
          autosize
          minRows={1}
          maxRows={8}
          disabled={disabled}
          placeholder={mode === 'tell' ? t('Tell the work: it reads this when it next starts') : placeholder}
          value={value}
          onChange={(event) => change(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={keyDown}
          aria-label={placeholder}
          dir="auto"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={picking}
          aria-controls={picking ? listId : undefined}
          aria-activedescendant={picking ? optionId(listId, Math.min(active, choices.length - 1)) : undefined}
        />
        {mode === 'message' && (
          <>
            <input ref={picker} type="file" multiple hidden onChange={(event) => { void attach(event.currentTarget.files); event.currentTarget.value = ''; }} />
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden
              onChange={(event) => { void attach(event.currentTarget.files); event.currentTarget.value = ''; }} />
            <ActionIcon size="lg" variant="subtle" color="gray" aria-label={t('Attach a file')} disabled={disabled} onClick={() => picker.current?.click()}>
              <IconPaperclip size={18} />
            </ActionIcon>
            {scope.phone && (
              <ActionIcon size="lg" variant="subtle" color="gray" aria-label={t('Take a picture')} disabled={disabled} onClick={() => camera.current?.click()}>
                <IconCamera size={18} />
              </ActionIcon>
            )}
          </>
        )}
        <EmojiPicker opened={emoji} setOpened={setEmoji} pick={insert} target={
          <ActionIcon size="lg" variant="subtle" color="gray" aria-label={t('Emoji')} onClick={() => setEmoji((open) => !open)} disabled={disabled}>
            <IconMoodSmile size={18} />
          </ActionIcon>
        } />
        {/* Calling a meeting of the company's agents about these words (section 2.211): the owner's and an approver's, at
            the top of a room, pressed and never sent by a key. Setting a people's meeting (section 2.215) goes here too. */}
        {meet && threadOf === null && (scope.kind === 'owner' || scope.kind === 'approver') && (
          <Tooltip label={t('Call a meeting about this')}>
            <ActionIcon size="lg" variant="subtle" aria-label={t('Call a meeting about this')} disabled={disabled || !value.trim()} onClick={() => {
              const body = value.trim();
              if (!body) return;
              setValue('');
              meet(body);
            }}>
              <IconUsersGroup size={18} />
            </ActionIcon>
          </Tooltip>
        )}
        {ask && mayAsk(scope.kind) && threadOf === null && (
          <Tooltip label={t('Ask the team')}>
            <ActionIcon size="lg" variant="subtle" aria-label={t('Ask the team')} disabled={disabled || !value.trim()} onClick={() => {
              const body = value.trim();
              if (!body) return;
              setValue('');
              ask(body);
            }}>
              <IconSparkles size={18} />
            </ActionIcon>
          </Tooltip>
        )}
        <ActionIcon data-send size="lg" radius="xl" aria-label={mode === 'tell' ? t('Tell the work') : t('Send')}
          disabled={disabled || (!value.trim() && files.length === 0)} onClick={submit}>
          <IconArrowUp size={18} />
        </ActionIcon>
      </Group>
      {threadOf !== null && mode === 'message' && (
        <Checkbox size="xs" mt={6} label={t('Also send to the room')} checked={alsoInRoom} onChange={(event) => setAlsoInRoom(event.currentTarget.checked)} />
      )}
      {mode === 'tell' && (
        <Group justify="flex-end" mt={6}>
          <Button size="xs" variant="light" disabled={!value.trim()} onClick={submit}>{t('Tell the work')}</Button>
        </Group>
      )}
    </Box>
  );
}
