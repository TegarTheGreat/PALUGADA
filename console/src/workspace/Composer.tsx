/**
 * Where a person writes in a room or a thread (F19.4, F19.6).
 *
 * On a desktop Enter sends and Shift+Enter breaks the line; on a phone Enter
 * breaks the line and the button sends. Enter never sends while an input
 * method is still composing a word, nor while the mention picker is open,
 * where it chooses. Telling the work is never sent by Enter: it is pressed.
 * A slash command only opens what it names, and only for someone who may
 * use it: a viewer's `/task` is kept as typed, and the composer says who
 * may ask. `/meet` and `/rapat` set a people's meeting (STATUS 2.215), which
 * anyone who may write here may. What is not sent yet stays with the room in
 * this tab's memory, and is gone with the tab.
 *
 * Up to five files go with a message, 24 MB together (STATUS 2.212): chosen
 * from the device, on a phone taken with its camera, pasted, or dropped on
 * the composer (STATUS 2.218). A picture too large for a room to draw is
 * made small enough first (`pictures.ts`). They are read into this tab's
 * memory only until the message is sent.
 *
 * Whom a message mentions is whom its words name: a handle typed in full
 * mentions its person as one chosen from the list does (STATUS 2.218).
 *
 * On a phone, and wherever the buttons beside the words would leave them
 * less than 240 pixels (a room beside a thread on a small laptop), the words
 * have the whole width, with the buttons in a row beneath them, as a phone's
 * chat apps put them (STATUS 2.218). Ctrl+K or
 * ⌘K opens the search of everything from here too, and Esc closes a thread
 * or reads the room (keys.ts).
 *
 * The words keep their own direction as they are typed, whatever the
 * console's is. The text area is the mention list's combobox: while the
 * list is open it says so, names the list and the person the arrows are on,
 * so a screen reader follows the choice as a sighted person does.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ActionIcon, Alert, Box, Button, Checkbox, Group, Menu, SegmentedControl, Text, Textarea, Tooltip } from '@mantine/core';
import { useElementSize } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { spotlight } from '@mantine/spotlight';
import {
  IconArrowUp, IconCalendarEvent, IconCamera, IconMoodSmile, IconPaperclip, IconSparkles, IconUsersGroup, IconX,
} from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { readForUpload } from '../files.ts';
import { count, fileSize } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { EmojiPicker } from './EmojiPicker.tsx';
import { takeComposerFocus } from './keys.ts';
import { mentionAt, mentionChoices, MentionPicker, optionId, type MentionChoice } from './MentionPicker.tsx';
import { drawable } from './pictures.ts';
import { mayAsk, useScope, writtenMentions } from './scope.ts';

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

export function Composer({ roomId, threadOf = null, placeholder, send, ask, meet, setMeeting, editLast, tellable = false, disabled = false }: {
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
  /**
   * Set a people's meeting (STATUS 2.215): words typed are posted as the person's own, then the dialog that gives
   * them a time and the people asked opens on the message; with none, it opens empty.
   */
  setMeeting?: (body: string) => void;
  /** ↑ in an empty composer: edit your last message. */
  editLast?: () => void;
  /** A thread of work the reader may tell (F19.6). */
  tellable?: boolean;
  disabled?: boolean;
}) {
  const scope = useScope();
  // Calling a meeting of the company's agents (section 2.211) is the owner's and an approver's, at the top of a room.
  const callsMeeting = meet !== undefined && threadOf === null && (scope.kind === 'owner' || scope.kind === 'approver');
  // On a phone, setting a people's meeting and calling one of agents are one menu, so the words keep their room.
  const foldMeetings = scope.phone && callsMeeting && setMeeting !== undefined;
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
  // A room opened from the keyboard (Alt+↑ or Alt+↓) gives its composer the focus, so what is typed next lands here.
  useEffect(() => { if (threadOf === null && takeComposerFocus()) box.current?.focus(); }, []);
  const [dropping, setDropping] = useState(false);
  // The composer's own width: where its buttons beside the words would leave too little to write in, they go beneath.
  const frame = useElementSize();

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

  // Files chosen, pasted or dropped, or a picture taken, added to those already chosen: never more than a message
  // carries. A picture too large to be drawn is made smaller first, so it is the smaller one that counts.
  const attach = async (chosen: FileList | File[] | null) => {
    const given = [...(chosen ?? [])];
    if (given.length === 0) return;
    if (files.length + given.length > FILES_MOST) {
      notifications.show({ color: 'yellow', message: t('A message carries up to five files, 24 MB in all.') });
      return;
    }
    try {
      const list: File[] = [];
      for (const file of given) list.push(await drawable(file));
      const total = [...files.map((one) => one.size), ...list.map((one) => one.size)].reduce((sum, size) => sum + size, 0);
      if (total > FILES_BYTES) {
        notifications.show({ color: 'yellow', message: t('A message carries up to five files, 24 MB in all.') });
        return;
      }
      const read = await Promise.all(list.map(async (file) => ({ ...await readForUpload(file), size: file.size })));
      setFiles((now) => [...now, ...read]);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };
  // A picture pasted is attached, as a screenshot is in every chat; pasted words stay words.
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...event.clipboardData.files];
    if (pasted.length === 0 || event.clipboardData.getData('text/plain')) return;
    event.preventDefault();
    void attach(pasted);
  };
  // Files dropped anywhere on the composer are attached.
  const carriesFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const dragOver = (event: DragEvent) => {
    if (!carriesFiles(event) || disabled) return;
    event.preventDefault();
    setDropping(true);
  };
  const drop = (event: DragEvent) => {
    setDropping(false);
    if (!carriesFiles(event) || disabled) return;
    event.preventDefault();
    void attach([...event.dataTransfer.files]);
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
    // A people's meeting is talk, so every person who may write here may set one.
    const meeting = /^\/(meet|rapat)(?:\s+([\s\S]*))?$/.exec(body);
    if (meeting && setMeeting && threadOf === null) {
      setMeeting(meeting[2]?.trim() ?? '');
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
      // The people the words name, typed in full or chosen from the list; one written and taken out is not mentioned.
      mentions: [...new Set([...writtenMentions(body, scope.people), ...chosen.filter((one) => body.includes(one.token)).map((one) => one.principal)])],
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
    // Ctrl+K or ⌘K searches everything from here too, as it does from the page (the search's own keys pass text by).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      spotlight.open();
      return;
    }
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

  // The buttons beside the words on a desktop, and in a row beneath them on a phone.
  const tools: ReactNode = (
    <>
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
      {/* On a phone, where every button takes room from the words, the two meetings are one menu (section 2.215). */}
      {foldMeetings && (
        <Menu position="top-end" withinPortal>
          <Menu.Target>
            <ActionIcon size="lg" variant="subtle" color="gray" aria-label={t('More')} data-meetings-menu disabled={disabled}>
              <IconCalendarEvent size={18} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconCalendarEvent size={16} />} onClick={() => {
              const body = value.trim();
              setValue('');
              setMeeting?.(body);
            }}>
              {t('Set a meeting')}
            </Menu.Item>
            <Menu.Item leftSection={<IconUsersGroup size={16} />} disabled={!value.trim()} onClick={() => {
              const body = value.trim();
              if (!body) return;
              setValue('');
              meet?.(body);
            }}>
              {t('Call a meeting about this')}
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
      {/* Setting a people's meeting (section 2.215): anyone's, at the top of a room, pressed and never sent by a key.
          Words typed become its title and agenda; with none, the dialog asks for them. */}
      {setMeeting && threadOf === null && !foldMeetings && (
        <Tooltip label={t('Set a meeting')}>
          <ActionIcon size="lg" variant="subtle" color="gray" aria-label={t('Set a meeting')} data-set-meeting-button disabled={disabled} onClick={() => {
            const body = value.trim();
            setValue('');
            setMeeting(body);
          }}>
            <IconCalendarEvent size={18} />
          </ActionIcon>
        </Tooltip>
      )}
      {/* Calling a meeting of the company's agents about these words (section 2.211): the owner's and an approver's, at
          the top of a room, pressed and never sent by a key. */}
      {callsMeeting && !foldMeetings && (
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
    </>
  );
  // How many buttons go with the words, each about 40 pixels with its gap: on a phone, or where they would leave the
  // words less than 240 pixels, they go in a row beneath (STATUS 2.218).
  const buttons = 2 + (mode === 'message' ? 1 + (scope.phone ? 1 : 0) : 0) + (foldMeetings ? 1 : 0)
    + (setMeeting && threadOf === null && !foldMeetings ? 1 : 0) + (callsMeeting && !foldMeetings ? 1 : 0)
    + (ask && mayAsk(scope.kind) && threadOf === null ? 1 : 0);
  // The width measured is the composer's whole box, its padding (16 pixels a side beside a phone's) included.
  const beneath = scope.phone || (frame.width > 0 && frame.width - 32 - buttons * 40 < 240);
  const sendButton = (
    <ActionIcon data-send size="lg" radius="xl" aria-label={mode === 'tell' ? t('Tell the work') : t('Send')}
      disabled={disabled || (!value.trim() && files.length === 0)} onClick={submit}>
      <IconArrowUp size={18} />
    </ActionIcon>
  );

  return (
    <Box className="composer" ref={frame.ref} px={{ base: 'xs', sm: 'md' }} pb={{ base: 'xs', sm: 'md' }} pt={6}
      data-dropping={dropping || undefined} onDragOver={dragOver} onDragLeave={() => setDropping(false)} onDrop={drop}>
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
          style={{ flex: 1, minWidth: 0 }}
          autosize
          minRows={1}
          maxRows={8}
          disabled={disabled}
          placeholder={mode === 'tell' ? t('Tell the work: it reads this when it next starts') : placeholder}
          value={value}
          onChange={(event) => change(event.currentTarget.value, event.currentTarget.selectionStart ?? event.currentTarget.value.length)}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
          onKeyDown={keyDown}
          onPaste={paste}
          aria-label={placeholder}
          dir="auto"
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={picking}
          aria-controls={picking ? listId : undefined}
          aria-activedescendant={picking ? optionId(listId, Math.min(active, choices.length - 1)) : undefined}
        />
        {!beneath && tools}
        {!beneath && sendButton}
      </Group>
      {beneath && (
        <Group justify="space-between" wrap="nowrap" gap={2} mt={4} data-composer-tools>
          <Group gap={2} wrap="nowrap">{tools}</Group>
          {sendButton}
        </Group>
      )}
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
