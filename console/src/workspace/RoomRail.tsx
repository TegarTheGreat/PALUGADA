/**
 * The list of a person's rooms (F19.1, F19.10): Activity, the direct
 * conversations, the company room, the divisions' rooms and the topic rooms
 * they joined. What has something new is bold, what names them carries a red
 * count (up to 99), and a quiet room a glyph; every number is the server's. The owner's
 * conversations with the company's CEO and with PALUGADA are pinned among
 * the direct messages, since they are the owner's own.
 */
import type { ReactNode } from 'react';
import { Avatar, Badge, Box, Button, Group, ScrollArea, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconBellOff, IconBolt, IconCompass, IconHash, IconLock, IconMessagePlus, IconPlus, IconSparkles } from '@tabler/icons-react';
import { t } from '../i18n.ts';
import { companyEmblem, personPicture, rolePicture } from '../images.ts';
import { roomName, useScope } from './scope.ts';
import type { RoomListItem } from './types.ts';

/** A count as the rail draws it: past 99 it says only that there are more. */
export function capped(count: number): string {
  return count > 99 ? '99+' : String(count);
}

/** Whether the room is quiet now: muted until a time still ahead, or told nothing. */
export function quiet(room: RoomListItem): boolean {
  return room.notify === 'none' || (room.mutedUntil !== null && new Date(room.mutedUntil).getTime() > Date.now());
}

export function RoomRail({ rooms, selected, select, attention, newRoom, newMessage }: {
  rooms: RoomListItem[];
  /** The item open now: a room's id, `activity`, `browse`, `ceo` or `palugada`. */
  selected: string | null;
  select: (item: string) => void;
  /** Unseen mentions across the company, Activity's count. */
  attention: number;
  newRoom: () => void;
  newMessage: () => void;
}) {
  const scope = useScope();
  const owner = scope.kind === 'owner';
  const ceo = scope.ctx.company.ceo;
  const direct = rooms.filter((room) => room.kind === 'direct' && room.joined);
  const shared = rooms.filter((room) => room.kind !== 'direct' && room.joined);
  const me = scope.ctx.me;

  const row = (item: string, label: string, icon: ReactNode, options: { room?: RoomListItem; count?: number } = {}) => {
    const room = options.room;
    const fresh = room ? room.unread > 0 && !quiet(room) : false;
    return (
      <UnstyledButton
        key={item}
        className="rail-row"
        data-room={room ? room.id : undefined}
        data-item={room ? undefined : item}
        data-active={selected === item || undefined}
        data-unread={fresh || undefined}
        onClick={() => select(item)}
      >
        <Group gap={8} wrap="nowrap">
          <Box className="rail-icon">{icon}</Box>
          <Text size="sm" fw={fresh ? 700 : 500} truncate style={{ flex: 1, minWidth: 0 }}>{label}</Text>
          {room && quiet(room) && <IconBellOff size={14} color="var(--mantine-color-dimmed)" aria-label={t('Quiet')} />}
          {(room ? room.mentions : options.count ?? 0) > 0 && (
            <Badge size="sm" color="red" circle={(room ? room.mentions : options.count ?? 0) < 10}>{capped(room ? room.mentions : options.count ?? 0)}</Badge>
          )}
          {room && room.kind === 'direct' && room.unread > 0 && room.mentions === 0 && !quiet(room) && (
            <Badge size="sm" color="red" variant="light" circle={room.unread < 10}>{capped(room.unread)}</Badge>
          )}
        </Group>
      </UnstyledButton>
    );
  };

  return (
    <Box className="rooms-rail" data-pane="rail" component="nav" aria-label={t('Rooms')}>
      <Group justify="space-between" px="sm" pt="sm" pb={6} wrap="nowrap">
        <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
          <Avatar size={24} radius="sm" src={companyEmblem(scope.ctx.company)} alt="" />
          <Text fw={700} truncate>{scope.ctx.company.name}</Text>
        </Group>
      </Group>
      {/* The search box (section 2.212) goes here. */}
      <ScrollArea style={{ flex: 1 }} type="auto" offsetScrollbars="y">
        <Stack gap={1} px={6} pb="sm">
          {row('activity', t('Activity'), <IconBolt size={18} />, { count: attention })}

          <Text className="rail-label">{t('Direct messages')}</Text>
          {owner && ceo && row('ceo', t('{name}, CEO', { name: ceo.displayName ?? ceo.slug }),
            <Avatar size={20} radius="xl" src={rolePicture(ceo.slug, 'CEO')} alt="" />)}
          {owner && row('palugada', 'PALUGADA', <IconSparkles size={18} />)}
          {direct.map((room) => {
            const others = (room.people ?? []).filter((person) => person.principal !== scope.me);
            const first = others[0];
            return row(room.id, roomName(room, scope.me),
              first ? <Avatar size={20} radius="xl" src={personPicture(first.principal, first.picture)} alt="" /> : <IconMessagePlus size={18} />, { room });
          })}

          <Text className="rail-label">{t('Rooms')}</Text>
          {shared.map((room) => row(room.id, room.name ?? '',
            room.kind === 'company' ? <Avatar size={20} radius="sm" src={companyEmblem(scope.ctx.company)} alt="" />
              : room.private ? <IconLock size={18} /> : <IconHash size={18} />, { room }))}

          <Stack gap={4} mt="sm">
            <Button size="compact-sm" variant="subtle" justify="flex-start" leftSection={<IconCompass size={16} />} data-item="browse" onClick={() => select('browse')}>
              {t('Browse rooms')}
            </Button>
            <Button size="compact-sm" variant="subtle" justify="flex-start" leftSection={<IconPlus size={16} />} onClick={newRoom}>{t('New room')}</Button>
            <Button size="compact-sm" variant="subtle" justify="flex-start" leftSection={<IconMessagePlus size={16} />} onClick={newMessage}>{t('New message')}</Button>
          </Stack>
        </Stack>
      </ScrollArea>
      <UnstyledButton className="rail-foot" onClick={scope.ctx.openProfile}>
        <Group gap="sm" wrap="nowrap">
          <Avatar size={28} radius="xl" src={personPicture(scope.me, me?.picture ?? null)} alt="" />
          <div style={{ minWidth: 0 }}>
            <Text size="sm" fw={600} truncate>{owner ? t('Owner') : me?.name ?? scope.ctx.staff?.name}</Text>
            {me?.handle && <Text size="xs" c="dimmed" truncate>@{me.handle}</Text>}
          </div>
        </Group>
      </UnstyledButton>
    </Box>
  );
}
