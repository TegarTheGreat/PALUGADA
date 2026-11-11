/**
 * A people's meeting under its message (F19.26; STATUS 2.215).
 *
 * The message above it is the meeting's title and agenda, and its thread is
 * the notes; this draws the rest: when it starts, in the reader's own time
 * zone, how long it is, the people asked, with their own pictures, who set
 * it, and the call link someone pasted, as "Join call", opened in a new tab
 * with neither an opener nor a referrer. The server never fetches the link,
 * and nothing here draws anything from it: it is a plain link.
 *
 * Its setter and the owner change it, through the dialog the Rooms page
 * holds, and cancel it, which is asked about first, since a cancelled
 * meeting stays cancelled and reminds nobody. A cancelled one says who
 * cancelled it. It is no agent's: no role, no badge, no money.
 */
import { useState } from 'react';
import { Anchor, Avatar, Badge, Button, Group, Modal, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCalendarEvent, IconVideo } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { count, dateTime, relative } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, useScope } from './scope.ts';
import type { MessageView, PeopleMeetingView } from './types.ts';

/** How many of the people asked are drawn by picture before the rest are counted. */
const PICTURES_SHOWN = 6;

export function MeetingPanel({ meeting, message }: { meeting: PeopleMeetingView; message: MessageView }) {
  const scope = useScope();
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);
  const begun = new Date(meeting.startsAt).getTime() <= Date.now();

  const cancel = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/people-meetings/${meeting.id}`, { cancel: true });
      notifications.show({ color: 'teal', message: t('The meeting is cancelled. Nobody is reminded of it.') });
      setCancelling(false);
      scope.changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  const shown = meeting.attendees.slice(0, PICTURES_SHOWN);
  const more = meeting.attendees.length - shown.length;
  return (
    <Paper withBorder radius="md" p="sm" mt={6} className="people-meeting" data-people-meeting={meeting.id} data-cancelled={meeting.cancelled || undefined}>
      <Stack gap={6}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          <IconCalendarEvent size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={600} td={meeting.cancelled ? 'line-through' : undefined}>
              {t('Meeting, {time}', { time: dateTime(meeting.startsAt) })}
            </Text>
            <Text size="xs" c="dimmed">
              {tp('{count} minute', '{count} minutes', meeting.minutes)}
              {!meeting.cancelled && !begun ? ` · ${relative(meeting.startsAt, 'long')}` : ''}
            </Text>
          </Stack>
        </Group>
        <Group gap={6} wrap="wrap" align="center">
          <Group gap={2} wrap="nowrap">
            {shown.map((person) => (
              <Tooltip key={person.principal} label={nameOf(person)} openDelay={300}>
                <Avatar size={24} radius="xl" src={personPicture(person.principal, person.picture)} alt={nameOf(person)} />
              </Tooltip>
            ))}
            {more > 0 && <Text size="xs" c="dimmed">+{count(more)}</Text>}
          </Group>
          <Text size="xs" c="dimmed" style={{ minWidth: 0 }}>
            {t('Asked: {people}', { people: meeting.attendees.map((person) => nameOf(person)).join(', ') })}
          </Text>
        </Group>
        <Text size="xs" c="dimmed">{t('Set by {name}', { name: nameOf(meeting.setBy) })}</Text>
        {meeting.cancelled ? (
          <Badge color="gray" variant="light" radius="sm" tt="none" w="fit-content">
            {t('Cancelled by {name}', { name: meeting.cancelledBy ? nameOf(meeting.cancelledBy) : t('Someone') })}
          </Badge>
        ) : (
          <Group gap="xs" wrap="wrap">
            {meeting.callUrl && (
              // A plain link, opened in a new tab that knows neither this page nor where it came from.
              <Button component="a" href={meeting.callUrl} target="_blank" rel="noopener noreferrer" size="compact-sm"
                leftSection={<IconVideo size={14} />} data-join-call>
                {t('Join call')}
              </Button>
            )}
            {meeting.may.change && (
              <>
                <Button size="compact-sm" variant="default" onClick={() => scope.setMeeting(message.roomId, message)}>{t('Change')}</Button>
                <Anchor component="button" type="button" size="sm" c="red" onClick={() => setCancelling(true)}>{t('Cancel the meeting')}</Anchor>
              </>
            )}
          </Group>
        )}
      </Stack>
      <Modal opened={cancelling} onClose={() => setCancelling(false)} title={t('Cancel this meeting?')} centered>
        <Text size="sm">{t('Nobody asked is reminded of it, and it cannot be set again. The message and its notes stay.')}</Text>
        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={() => setCancelling(false)}>{t('Keep it')}</Button>
          <Button color="red" loading={busy} onClick={() => void cancel()}>{t('Cancel the meeting')}</Button>
        </Group>
      </Modal>
    </Paper>
  );
}
