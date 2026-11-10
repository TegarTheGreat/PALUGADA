/**
 * What asks for the person's attention, newest first (F19.10): where they
 * were mentioned, replies in threads they follow, cards about work they
 * asked for, questions put to them, the team's cards an approver may
 * decide, and work they asked for that ended this week. Read from the
 * server; an approver is told of a team card by the item alone, never of
 * a room they cannot see.
 */
import { Box, Group, Loader, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAt, IconCheck, IconInbox, IconMessageCircle, IconMessageQuestion, IconSparkles } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { api } from '../api.ts';
import { relative, statusLabel } from '../format.ts';
import { useLoad } from '../hooks.ts';
import { t } from '../i18n.ts';
import { roomName, useScope } from './scope.ts';
import type { ActivityItem, RoomListItem } from './types.ts';

export function Activity({ rooms, open }: { rooms: RoomListItem[]; open: (item: string) => void }) {
  const scope = useScope();
  const items = useLoad<ActivityItem[]>(async () => {
    const answer: { items: ActivityItem[] } = await api('GET', `/api/companies/${scope.companyId}/me/activity`);
    return answer.items;
  }, [scope.companyId, scope.tick], { every: 30_000 });
  const where = (roomId: string) => {
    const room = rooms.find((one) => one.id === roomId);
    return room ? roomName(room, scope.me) : t('a room');
  };

  const line = (key: string, icon: ReactNode, said: string, at: string, press: () => void, unseen = false) => (
    <UnstyledButton key={key} className="activity-row" data-unseen={unseen || undefined} onClick={press}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box mt={2}>{icon}</Box>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={unseen ? 700 : 400}>{said}</Text>
          <Text size="xs" c="dimmed">{relative(at)}</Text>
        </Box>
      </Group>
    </UnstyledButton>
  );

  return (
    <Box className="pane-scroll" p={{ base: 'xs', sm: 'md' }}>
      {!items.data && !items.error && <Group justify="center" py="xl"><Loader size="sm" /></Group>}
      {items.error && <Text c="red" size="sm">{items.error}</Text>}
      {items.data?.length === 0 && <Text c="dimmed" size="sm" ta="center" py="xl">{t('Nothing asks for you now.')}</Text>}
      <Stack gap={2}>
        {(items.data ?? []).map((item, index) => {
          switch (item.kind) {
            case 'mention':
              return line(`${index}`, <IconAt size={18} />, t('You were mentioned in {room}', { room: where(item.roomId) }), item.at, () => open(item.roomId), !item.seen);
            case 'reply':
              return line(`${index}`, <IconMessageCircle size={18} />, t('A reply in a thread you follow, in {room}', { room: where(item.roomId) }), item.at, () => open(item.roomId), !item.seen);
            case 'card':
              return line(`${index}`, <IconSparkles size={18} />, t('Work you asked for needs you, in {room}', { room: where(item.roomId) }), item.at, () => open(item.roomId), !item.seen);
            case 'question':
              return line(`${index}`, <IconMessageQuestion size={18} />, t('A question for you'), item.at, () => scope.ctx.open('inbox', { item: item.itemId }), true);
            case 'team_item':
              return line(`${index}`, <IconInbox size={18} />, t('Your team\'s work waits for an approver'), item.at, () => scope.ctx.open('inbox', { item: item.itemId }), true);
            case 'work_done':
              return line(`${index}`, <IconCheck size={18} />, t('Work you asked for ended: {state}', { state: statusLabel(item.state) }), item.at, () => scope.ctx.open('work', { item: item.taskId }));
          }
          return null;
        })}
      </Stack>
    </Box>
  );
}
