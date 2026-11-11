/**
 * Setting a people's meeting, or changing one (F19.26; STATUS 2.215).
 *
 * A meeting is a person's own words at the top of a room given a time, a
 * length (5 to 480 minutes), the people asked and, when someone pastes one, a
 * call link: the words are its title and agenda, and its thread is the
 * notes. Opened on a message already kept -- from the composer, whose words
 * are posted first as Ask the team posts them, or from a message's actions --
 * or empty, from `/meet` or `/rapat` alone, when what is written here is
 * posted as the person's words before the meeting is set, once however often
 * Set is pressed. Cancelling the dialog leaves posted words in the room.
 *
 * Only people who can see the room may be asked: a private room's members
 * and the owner, a direct conversation's people, anyone of the company in an
 * open room. The server refuses anyone else, and the database too. A call
 * link is `https://` only, and nothing here or on the server ever opens it.
 *
 * The Rooms page holds this, as it holds Ask the team, so the room read again
 * behind it takes away neither a refusal nor what was typed.
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Anchor, Button, Group, Modal, MultiSelect, NumberInput, Stack, Text, Textarea, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';
import { nameOf, newClientId, useScope } from './scope.ts';
import type { MessageView, Person } from './types.ts';

/** What the server holds: a meeting's length, its people, its link, and its words as a message's. */
const MINUTES = { least: 5, most: 480 } as const;
const ATTENDEES_MOST = 50;
const CALL_URL_MOST = 2_000;
const BODY_MAX = 8_000;

/** A moment as a `datetime-local` input shows it: the reader's own time, to the minute. */
function localInput(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The next whole hour from now: where a new meeting starts until the person says otherwise. */
function nextHour(): Date {
  const at = new Date(Date.now() + 60 * 60 * 1000);
  at.setMinutes(0, 0, 0);
  return at;
}

export function SetMeeting({ setting, close }: {
  /** The room, and the message the meeting is set from (null to write its words here); null while it is closed. */
  setting: { roomId: string; message: MessageView | null } | null;
  close: () => void;
}) {
  const scope = useScope();
  const meeting = setting?.message?.peopleMeeting ?? null;
  const [words, setWords] = useState('');
  const [when, setWhen] = useState('');
  const [minutes, setMinutes] = useState<number>(30);
  const [attendees, setAttendees] = useState<string[]>([]);
  const [link, setLink] = useState('');
  const [choices, setChoices] = useState<Person[]>([]);
  const [posted, setPosted] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Started afresh when it opens on a room and a message, and only then: the room read again behind it keeps a
  // refusal and what was typed. Who may be asked is read from the room as it was when the dialog opened.
  const opening = setting ? `${setting.roomId}~${setting.message?.id ?? ''}` : null;
  useEffect(() => {
    if (!setting) return;
    const room = scope.room?.id === setting.roomId ? scope.room : null;
    const open = !room || room.kind === 'company' || room.kind === 'division' || (room.kind === 'topic' && !room.private);
    const members = new Set((room?.members ?? []).map((one) => one.principal));
    if (room?.kind === 'topic') members.add('owner');
    const seeing = open ? scope.people : scope.people.filter((person) => members.has(person.principal));
    setChoices(seeing);
    setError(null);
    setPosted(null);
    setClientId(newClientId());
    setWords('');
    if (meeting) {
      setWhen(localInput(new Date(meeting.startsAt)));
      setMinutes(meeting.minutes);
      setAttendees(meeting.attendees.map((person) => person.principal));
      setLink(meeting.callUrl ?? '');
    } else {
      setWhen(localInput(nextHour()));
      setMinutes(30);
      // A direct conversation's meeting is for its people; elsewhere the setter starts with themselves.
      setAttendees(room?.kind === 'direct' ? [...members] : [scope.me]);
      setLink('');
    }
  }, [opening]);

  const data = useMemo(() => choices.map((person) => ({
    value: person.principal,
    label: person.handle ? `${nameOf(person)} (@${person.handle})` : nameOf(person),
  })), [choices]);

  const startsAt = when ? new Date(when) : null;
  const linkTyped = link.trim();
  const linkWrong = linkTyped !== '' && (!/^https:\/\/\S+$/.test(linkTyped) || linkTyped.length > CALL_URL_MOST);
  const needsWords = setting !== null && setting.message === null && posted === null;
  const ready = startsAt !== null && !Number.isNaN(startsAt.getTime()) && attendees.length > 0 && !linkWrong
    && minutes >= MINUTES.least && minutes <= MINUTES.most && (!needsWords || words.trim().length > 0);

  const submit = async () => {
    if (!setting || !ready || !startsAt) return;
    if (startsAt.getTime() <= Date.now()) {
      setError(t('A meeting starts in the future.'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (meeting) {
        await api('POST', `/api/companies/${scope.companyId}/rooms/${setting.roomId}/people-meetings/${meeting.id}`, {
          startsAt: startsAt.toISOString(), minutes, attendees, callUrl: linkTyped || null,
        });
        notifications.show({ color: 'teal', message: t('The meeting is changed. The people asked are reminded ten minutes before it starts.') });
      } else {
        // Words written here are the person's own message, posted once however often Set is pressed.
        let messageId = setting.message?.id ?? posted;
        if (!messageId) {
          const answer: { message: MessageView } = await api('POST', `/api/companies/${scope.companyId}/rooms/${setting.roomId}/messages`, {
            body: words.trim(), clientId,
          });
          messageId = answer.message.id;
          setPosted(messageId);
        }
        await api('POST', `/api/companies/${scope.companyId}/rooms/${setting.roomId}/people-meetings`, {
          messageId, startsAt: startsAt.toISOString(), minutes, attendees, ...(linkTyped ? { callUrl: linkTyped } : {}),
        });
        notifications.show({ color: 'teal', message: t('The meeting is set. The people asked are reminded ten minutes before it starts.') });
      }
      close();
      scope.changed();
    } catch (failure) {
      setError(explain(failure));
      scope.changed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={setting !== null} onClose={close} title={meeting ? t('Change the meeting') : t('Set a meeting')} centered>
      <Stack data-set-meeting>
        <Text size="sm" c="dimmed">
          {t('Its title and agenda are the message, and its thread is the notes. The people asked are reminded ten minutes before it starts.')}
        </Text>
        {needsWords && (
          <Textarea label={t('Title and agenda')} autosize minRows={2} maxRows={8} maxLength={BODY_MAX} dir="auto" required
            value={words} onChange={(event) => setWords(event.currentTarget.value)} data-autofocus />
        )}
        <TextInput type="datetime-local" label={t('When')} required value={when} onChange={(event) => setWhen(event.currentTarget.value)} />
        <NumberInput label={t('How long, in minutes')} min={MINUTES.least} max={MINUTES.most} step={5} required allowDecimal={false}
          value={minutes} onChange={(value) => setMinutes(typeof value === 'number' ? value : Number(value) || 0)} />
        <MultiSelect label={t('Who is asked')} description={t('Only people who can see this room can be asked.')} data={data}
          value={attendees} onChange={setAttendees} searchable maxValues={ATTENDEES_MOST} required />
        <TextInput label={t('Call link')} description={t('Optional. Paste a link that starts with https://. PALUGADA never opens it.')}
          value={link} onChange={(event) => setLink(event.currentTarget.value)} dir="ltr" data-call-link
          error={linkWrong ? t('A call link starts with https://, has no spaces and is at most 2,000 characters.') : undefined} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Anchor component="button" type="button" size="sm" onClick={close}>{t('Cancel')}</Anchor>
          <Button data-set loading={busy} disabled={!ready} onClick={() => void submit()}>{meeting ? t('Save') : t('Set the meeting')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
