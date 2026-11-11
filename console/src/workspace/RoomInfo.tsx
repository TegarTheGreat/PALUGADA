/**
 * A room's details (F19.1, F19.4, F19.10): who is in it, what is pinned and
 * the files it keeps (STATUS 2.212), how
 * loudly it tells the reader things and until when it is quiet, which work
 * a division's room shows, its name, and archiving or leaving it. Each
 * control is offered only where the server says the reader may use it
 * (`Room.may`), and refused there anyway if not. A direct conversation's
 * people are fixed: adding someone opens the conversation of the new set,
 * with none of what was said before. What cannot be undone from here is
 * asked about first: archiving, after which nobody writes in the room
 * again, and a member of staff leaving a private room, which they come
 * back to only when someone in it adds them.
 */
import { useEffect, useState } from 'react';
import {
  ActionIcon, Alert, Avatar, Badge, Button, Divider, Drawer, Group, Modal, MultiSelect, Select, Stack, Text, TextInput, Textarea,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPin, IconUserMinus } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { N, t, tp } from '../i18n.ts';
import { disclosureOf } from './disclosure.ts';
import { personPicture } from '../images.ts';
import { Saved } from './RoomFiles.tsx';
import { nameOf, useScope } from './scope.ts';
import type { FileView, MessageView, PersonRef, Room } from './types.ts';

/** A file a room keeps, as its details list it. */
type Kept = FileView & { messageId: string; threadOf: string | null; author: PersonRef; at: string };

const NOTIFY: Record<Room['notify'], string> = {
  all: N('Every message'), mentions: N('Mentions and direct messages'), none: N('Nothing'),
};
const SHOWS_WORK: Record<Room['showsWork'], string> = {
  asked_here: N('Only work asked for here'), needs_people: N('Work that needs a person'), all: N('All of the division\'s work'),
};
/** How long a room may be made quiet for, in hours. */
const QUIET_FOR = [1, 8, 24, 24 * 7];

export function RoomInfo({ opened, close, addPeople }: {
  opened: boolean;
  close: () => void;
  /** A direct room's "Add people": the new conversation of these people and more. */
  addPeople: (people: string[]) => void;
}) {
  const scope = useScope();
  const room = scope.room;
  const [name, setName] = useState(room?.name ?? '');
  const [about, setAbout] = useState(room?.about ?? '');
  const [adding, setAdding] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<'archive' | 'leave' | null>(null);
  const [pinned, setPinned] = useState<MessageView[]>([]);
  const [kept, setKept] = useState<Kept[]>([]);
  useEffect(() => {
    setName(room?.name ?? '');
    setAbout(room?.about ?? '');
    setAdding([]);
  }, [room?.id, opened]);
  // What the room keeps at hand, read each time the details open: its pinned messages with their words, and its files.
  useEffect(() => {
    if (!opened || !room) return;
    let live = true;
    api('GET', `/api/companies/${scope.companyId}/rooms/${room.id}/pins`)
      .then((answer: { messages: MessageView[] }) => { if (live) setPinned(answer.messages); }, () => { if (live) setPinned([]); });
    api('GET', `/api/companies/${scope.companyId}/rooms/${room.id}/files`)
      .then((answer: { files: Kept[] }) => { if (live) setKept(answer.files); }, () => { if (live) setKept([]); });
    return () => { live = false; };
  }, [room?.id, opened, room?.pins.length]);
  if (!room) return null;
  // A pinned message opened where it was said: the room around it, or its thread at it (STATUS 2.218).
  const openAt = (message: MessageView) => {
    close();
    scope.openAt({ roomId: message.roomId, threadOf: message.threadOf, position: message.position });
  };

  const done = (failure?: unknown) => {
    if (failure !== undefined) notifications.show({ color: 'red', message: explain(failure) });
    else scope.changed();
  };
  const settings = (body: { notify?: Room['notify']; mutedUntil?: string | null }) =>
    api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}/settings`, body).then(() => done(), done);
  const change = (body: { name?: string; about?: string; showsWork?: Room['showsWork'] }) =>
    api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}`, body).then(() => done(), done);
  const members = (body: { add?: string[]; remove?: string[] }) =>
    api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}/members`, body).then(() => { setAdding([]); done(); }, done);
  const archive = () =>
    api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}/archive`, {}).then(() => { setConfirming(null); close(); done(); }, done);
  const leave = () =>
    api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}/leave`, {})
      .then(() => { setConfirming(null); close(); done(); scope.ctx.open('rooms', { item: null }); }, done);
  // The owner joins any private room again; anyone else is added back by someone in it.
  const leavingForGood = room.private && scope.kind !== 'owner';

  const muted = room.mutedUntil !== null && new Date(room.mutedUntil).getTime() > Date.now();
  const inRoom = new Set(room.members.map((member) => member.principal));
  const runs = room.createdBy === scope.me || scope.kind === 'owner' || room.members.some((member) => member.principal === scope.me && member.role === 'admin');
  const outside = scope.people.filter((person) => !inRoom.has(person.principal));

  return (
    <Drawer opened={opened} onClose={close} position="right" size="md" title={t('About this room')}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">{disclosureOf(room)}</Text>

        {room.may.rename ? (
          <Stack gap="xs">
            <TextInput label={t('Name')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} />
            <Textarea label={t('What it is for')} value={about} onChange={(event) => setAbout(event.currentTarget.value)} autosize minRows={1} maxLength={500} />
            <Group justify="flex-end">
              <Button size="xs" variant="light" disabled={!name.trim() || (name === room.name && about === (room.about ?? ''))}
                onClick={() => void change({ name: name.trim(), about })}>{t('Save')}</Button>
            </Group>
          </Stack>
        ) : room.about && <Text size="sm">{room.about}</Text>}

        {room.joined && (
          <Stack gap="xs">
            <Select label={t('Tell me about')} value={room.notify} allowDeselect={false}
              data={(Object.keys(NOTIFY) as Array<Room['notify']>).map((value) => ({ value, label: t(NOTIFY[value]) }))}
              onChange={(value) => { if (value) void settings({ notify: value as Room['notify'] }); }} />
            <Group gap="xs">
              {muted ? (
                <Button size="xs" variant="light" onClick={() => void settings({ mutedUntil: null })}>{t('Hear this room again')}</Button>
              ) : QUIET_FOR.map((hours) => (
                <Button key={hours} size="xs" variant="default" onClick={() => void settings({ mutedUntil: new Date(Date.now() + hours * 3_600_000).toISOString() })}>
                  {hours < 24 ? tp('Quiet for {count} hour', 'Quiet for {count} hours', hours) : tp('Quiet for {count} day', 'Quiet for {count} days', hours / 24)}
                </Button>
              ))}
            </Group>
          </Stack>
        )}

        {room.may.showsWork && room.kind === 'division' && (
          <Select label={t('Work shown here')} value={room.showsWork} allowDeselect={false}
            data={(Object.keys(SHOWS_WORK) as Array<Room['showsWork']>).map((value) => ({ value, label: t(SHOWS_WORK[value]) }))}
            onChange={(value) => { if (value) void change({ showsWork: value as Room['showsWork'] }); }} />
        )}

        <Divider label={tp('{count} person', '{count} people', room.members.length)} labelPosition="left" />
        <Stack gap={6}>
          {room.members.map((member) => (
            <Group key={member.principal} gap="sm" wrap="nowrap" justify="space-between">
              <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <Avatar size={28} radius="xl" src={personPicture(member.principal, member.picture)} alt="" />
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} truncate>{nameOf(member)}</Text>
                    {member.handle && <Text size="xs" c="dimmed" dir="ltr">@{member.handle}</Text>}
                  </Group>
                  {member.role === 'admin' && <Badge size="xs" variant="light" radius="sm">{t('Runs this room')}</Badge>}
                </div>
              </Group>
              {room.kind === 'topic' && room.private && runs && member.principal !== scope.me && (
                <ActionIcon variant="subtle" color="red" aria-label={t('Take {name} out of this room', { name: nameOf(member) })}
                  onClick={() => void members({ remove: [member.principal] })}>
                  <IconUserMinus size={16} />
                </ActionIcon>
              )}
            </Group>
          ))}
        </Stack>

        {room.may.addPeople && outside.length > 0 && (
          <Stack gap="xs">
            <MultiSelect
              label={room.kind === 'direct' ? t('Start a conversation with these people as well') : t('Add people')}
              description={room.kind === 'direct' ? t('A new conversation opens, without what was said here.') : undefined}
              data={outside.map((person) => ({ value: person.principal, label: person.handle ? `${nameOf(person)} @${person.handle}` : nameOf(person) }))}
              value={adding}
              onChange={setAdding}
              searchable
            />
            <Group justify="flex-end">
              <Button size="xs" variant="light" disabled={adding.length === 0}
                onClick={() => (room.kind === 'direct'
                  ? addPeople([...room.members.map((member) => member.principal), ...adding])
                  : void members({ add: adding }))}>
                {room.kind === 'direct' ? t('Open that conversation') : t('Add them')}
              </Button>
            </Group>
          </Stack>
        )}

        {room.pins.length > 0 && (
          <>
            <Divider label={tp('{count} message is pinned here.', '{count} messages are pinned here.', room.pins.length)} labelPosition="left" />
            <Stack gap={6} data-pinned>
              {pinned.map((message) => (
                <UnstyledButton key={message.id} className="pinned-message" onClick={() => openAt(message)}>
                  <Group gap={6} wrap="nowrap" align="flex-start">
                    <IconPin size={14} style={{ flexShrink: 0, marginTop: 3 }} />
                    <div style={{ minWidth: 0 }}>
                      <Text size="xs" fw={600}>{'name' in message.author ? nameOf(message.author) : 'PALUGADA'}</Text>
                      <Text size="sm" lineClamp={2} dir="auto">
                        {message.deleted ? t('This message was removed.') : message.body || message.files.map((file) => file.name).join(', ')}
                      </Text>
                    </div>
                  </Group>
                </UnstyledButton>
              ))}
            </Stack>
          </>
        )}
        {kept.length > 0 && (
          <>
            <Divider label={t('Files')} labelPosition="left" />
            <Stack gap={6} data-room-files>
              {kept.map((file) => <Saved key={file.id} roomId={room.id} file={file} />)}
            </Stack>
          </>
        )}

        {(room.may.archive || (room.joined && room.kind !== 'company' && room.kind !== 'direct')) && <Divider />}
        {room.joined && room.kind !== 'company' && room.kind !== 'direct' && (
          <Button variant="default" onClick={() => (leavingForGood ? setConfirming('leave') : void leave())}>{t('Leave this room')}</Button>
        )}
        {room.may.archive && (
          <Alert variant="light" color="gray">
            <Text size="sm" mb="xs">{t('An archived room is kept, with everything said in it, and nobody can write in it.')}</Text>
            <Button size="xs" color="red" variant="light" onClick={() => setConfirming('archive')}>{t('Archive this room')}</Button>
          </Alert>
        )}
      </Stack>

      <Modal opened={confirming === 'archive'} onClose={() => setConfirming(null)} title={t('Archive this room?')} centered>
        <Text size="sm">{t('Nobody can write in it again: this cannot be undone. What was said in it is kept.')}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirming(null)}>{t('Keep it')}</Button>
          <Button color="red" onClick={() => void archive()}>{t('Archive it')}</Button>
        </Group>
      </Modal>
      <Modal opened={confirming === 'leave'} onClose={() => setConfirming(null)} title={t('Leave this private room?')} centered>
        <Text size="sm">{t('You can come back only if someone in it adds you again.')}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setConfirming(null)}>{t('Stay')}</Button>
          <Button color="red" onClick={() => void leave()}>{t('Leave it')}</Button>
        </Group>
      </Modal>
    </Drawer>
  );
}
