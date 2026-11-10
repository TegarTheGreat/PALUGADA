/**
 * The rooms a person may join (F19.1): every division's room and every open
 * topic room of the company, with whether they are in it. A private room is
 * listed only to its members and the owner, as the server says; joining an
 * open room is one press.
 */
import { useState } from 'react';
import { Badge, Box, Button, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconHash, IconLock } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { t } from '../i18n.ts';
import { useScope } from './scope.ts';
import type { Room, RoomListItem } from './types.ts';

export function Browse({ open }: { open: (roomId: string) => void }) {
  const scope = useScope();
  const [joining, setJoining] = useState<string | null>(null);
  const rooms = useLoad<RoomListItem[]>(async () => {
    const answer: { rooms: RoomListItem[] } = await api('GET', `/api/companies/${scope.companyId}/rooms?browse=1`);
    return answer.rooms.filter((room) => room.kind !== 'direct' && !room.archived);
  }, [scope.companyId, scope.tick]);

  const join = async (room: RoomListItem) => {
    setJoining(room.id);
    try {
      const answer: { room: Room } = await api('POST', `/api/companies/${scope.companyId}/rooms/${room.id}/join`, {});
      scope.changed();
      open(answer.room.id);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setJoining(null);
    }
  };

  return (
    <Box className="pane-scroll" p={{ base: 'xs', sm: 'md' }}>
      {!rooms.data && !rooms.error && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {rooms.error && <Text c="red" size="sm">{rooms.error}</Text>}
      <Stack gap="xs">
        {(rooms.data ?? []).map((room) => (
          <Group key={room.id} justify="space-between" wrap="nowrap" className="browse-row" data-browse={room.id}>
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              {room.private ? <IconLock size={16} /> : <IconHash size={16} />}
              <Text size="sm" fw={600} truncate>{room.name}</Text>
              {room.kind === 'division' && <Badge size="xs" variant="light" color="gray" radius="sm">{t('Division')}</Badge>}
            </Group>
            {room.joined
              ? <Button size="compact-sm" variant="subtle" onClick={() => open(room.id)}>{t('Open')}</Button>
              : <Button size="compact-sm" variant="light" loading={joining === room.id} onClick={() => void join(room)}>{t('Join')}</Button>}
          </Group>
        ))}
      </Stack>
    </Box>
  );
}
