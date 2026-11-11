/**
 * Rooms: where the owner and the staff talk, and ask the company for work
 * or call a meeting of its agents where they talk (F19.1, F19.3 to F19.8,
 * F19.10, F19.16, F19.18, F19.21; STATUS 2.207, 2.211).
 *
 * Three panes on a wide screen -- the rail, the room, and a thread beside
 * it -- after the inbox's list and detail. Between a tablet's width and a
 * desktop's the thread takes the room's place; on a phone the Rooms tab is
 * the rail, a room is the whole screen with its composer above the
 * keyboard and no tab bar, and a thread is a sheet over the room.
 *
 * What is open is in the address (`?item=<room>`, `<room>~<message>` for a
 * thread, or `activity`, `browse`, `search`, and for the owner `ceo` and
 * `palugada`),
 * so a reload, the back button and a notice's link land where the person
 * was. Agents are never in a room: the company appears only as cards, and a
 * message becomes work only when someone presses for it. Nothing is kept in
 * the browser; the server holds every read mark and setting.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActionIcon, Box, Button, Group, Text, Tooltip } from '@mantine/core';
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconBellOff, IconHash, IconInfoCircle, IconLock } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import type { PageProps } from '../App.tsx';
import { AssistantThread, AssistantTitle } from '../components/Assistant.tsx';
import { useLoad } from '../hooks.ts';
import { t, tp } from '../i18n.ts';
import { go } from '../router.ts';
import { Activity } from '../workspace/Activity.tsx';
import { AskWork } from '../workspace/AskWork.tsx';
import { Browse } from '../workspace/Browse.tsx';
import { Composer, type Sent } from '../workspace/Composer.tsx';
import { disclosureOf } from '../workspace/disclosure.ts';
import { CallMeeting } from '../workspace/MeetingCard.tsx';
import { NewMessage } from '../workspace/NewMessage.tsx';
import { NewRoom } from '../workspace/NewRoom.tsx';
import { RoomInfo } from '../workspace/RoomInfo.tsx';
import { SearchPanel } from '../workspace/SearchPanel.tsx';
import { quiet, RoomRail } from '../workspace/RoomRail.tsx';
import { roomName, ScopeContext, useScope, type Scope } from '../workspace/scope.ts';
import { ThreadPanel } from '../workspace/ThreadPanel.tsx';
import { Timeline, usePosting, type Pending } from '../workspace/Timeline.tsx';
import type { MessageView, Person, Room, RoomListItem } from '../workspace/types.ts';
import { useKeyboardInset } from '../workspace/useKeyboardInset.ts';
import { useRoomPulse } from '../workspace/useRoomStream.ts';

/** What is open, read from the address. */
type Open =
  | { kind: 'none' }
  | { kind: 'room'; roomId: string; threadId: string | null }
  | { kind: 'activity' } | { kind: 'browse' } | { kind: 'search' } | { kind: 'ceo' } | { kind: 'palugada' };

function openOf(item: string | null, owner: boolean): Open {
  if (!item) return { kind: 'none' };
  if (item === 'activity' || item === 'browse' || item === 'search') return { kind: item };
  // The owner's own conversations; a seat has none here.
  if (item === 'ceo' || item === 'palugada') return owner ? { kind: item } : { kind: 'none' };
  const [roomId = '', threadId] = item.split('~');
  return { kind: 'room', roomId, threadId: threadId || null };
}

/** How often the rail is read again while the room stream is not heard: refused for five tabs open already, or down. */
const RAIL_EVERY_MS = 30_000;

export function Rooms({ ctx, route }: PageProps) {
  const companyId = ctx.companyId;
  const owner = ctx.staff === null;
  const me = owner ? 'owner' : ctx.me?.principal ?? null;
  const wide = useMediaQuery('(min-width: 62em)') ?? true;
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const open = openOf(route.item, owner);
  const [tick, setTick] = useState(0);
  // What Ask the team is open for: a message, or nothing yet; null while it is closed.
  const [asking, setAsking] = useState<{ message: MessageView | null } | null>(null);
  // What a meeting is being called about; null while the dialog is closed. Held here, above the room that is read
  // again and the composer that is drawn again with it, so a refusal and the topic typed stay while the room moves.
  const [calling, setCalling] = useState<{ message: MessageView } | null>(null);
  const [making, setMaking] = useState(false);
  const [writing, setWriting] = useState<string[] | null>(null);
  // What the rail's search asked for: the page's memory only, never the browser's.
  const [query, setQuery] = useState('');

  const select = useCallback((item: string | null, replace = false) => {
    go({ ...route, item }, { replace });
  }, [route]);

  // The rail and the room on screen are read again when the room stream says they changed (STATUS 2.210), and on
  // a clock only while the stream is not heard.
  const roomId = open.kind === 'room' ? open.roomId : null;
  const railPulse = useRoomPulse(companyId, (frame) => 'room' in frame && frame.kind !== 'reaction' && frame.kind !== 'pin');
  const roomPulse = useRoomPulse(companyId, (frame) => 'room' in frame && frame.room === roomId && ['member', 'room', 'pin'].includes(frame.kind));
  const rooms = useLoad<RoomListItem[]>(async () => {
    const answer: { rooms: RoomListItem[] } = await api('GET', `/api/companies/${companyId}/rooms`);
    return answer.rooms;
  }, [companyId, tick], railPulse.live ? { pulse: railPulse.pulse } : { every: RAIL_EVERY_MS });
  const people = useLoad<Person[]>(async () => {
    const answer: { people: Person[] } = await api('GET', `/api/companies/${companyId}/people`);
    return answer.people;
  }, [companyId]);
  const room = useLoad<Room | null>(async () => {
    if (!roomId) return null;
    const answer: { room: Room } = await api('GET', `/api/companies/${companyId}/rooms/${roomId}`);
    return answer.room;
  }, [companyId, roomId, tick], { pulse: roomPulse.pulse });
  // The same room read again keeps its place on screen; another room starts empty.
  const shownRoom = room.data && room.data.id === roomId ? room.data : null;

  // A desktop opens on the company room; a phone opens on the rail, which is the Rooms tab.
  useEffect(() => {
    if (phone || open.kind !== 'none' || !rooms.data) return;
    const company = rooms.data.find((one) => one.kind === 'company');
    if (company) select(company.id, true);
  }, [phone, open.kind, rooms.data]);

  // A room or a thread open on a phone has the whole screen: no shell header, no tabs, the keyboard allowed for.
  const immersive = phone && open.kind !== 'none';
  useEffect(() => {
    ctx.setImmersive(immersive);
    return () => ctx.setImmersive(false);
  }, [immersive]);
  useKeyboardInset(immersive);

  const changed = useCallback(() => {
    setTick((now) => now + 1);
    ctx.refreshUnread();
  }, [ctx]);

  const scope = useMemo<Scope | null>(() => (me ? {
    ctx,
    companyId,
    me,
    kind: owner ? 'owner' : ctx.staff!.kind,
    room: shownRoom,
    people: people.data ?? [],
    phone,
    openThread: (messageId) => { if (roomId) select(`${roomId}~${messageId}`); },
    askWork: (message) => setAsking({ message }),
    callMeeting: (message) => setCalling({ message }),
    changed,
    tick,
  } : null), [ctx, companyId, me, owner, shownRoom, people.data, phone, roomId, select, changed, tick]);

  // Alt+↑/↓ the room above or below in the rail, as the rail lists them; with Shift, the one above or below that has
  // something new. They work from the composer too, where the cursor usually is. Esc closes the thread, or marks the
  // room read when none is open (Timeline.tsx). Nothing here sends, asks or decides: those are pressed.
  const listed = [
    ...(rooms.data ?? []).filter((one) => one.joined && one.kind === 'direct'),
    ...(rooms.data ?? []).filter((one) => one.joined && one.kind !== 'direct'),
  ];
  const step = (by: number, fresh: boolean) => {
    const at = listed.findIndex((one) => one.id === roomId);
    for (let index = at + by; index >= 0 && index < listed.length; index += by) {
      const next = listed[index]!;
      if (!fresh || (next.unread > 0 && !quiet(next)) || next.mentions > 0) { select(next.id); return; }
    }
  };
  useHotkeys([
    ['alt+ArrowUp', () => step(-1, false)],
    ['alt+ArrowDown', () => step(1, false)],
    ['alt+shift+ArrowUp', () => step(-1, true)],
    ['alt+shift+ArrowDown', () => step(1, true)],
  ], []);
  useHotkeys([
    ['Escape', () => { if (open.kind === 'room' && open.threadId) select(open.roomId); }],
  ]);

  if (!scope) return null;
  const attention = ctx.unread.find((one) => one.companyId === companyId)?.mentions ?? 0;
  const threadOpen = open.kind === 'room' && open.threadId !== null;
  // Which panes are drawn: a phone shows one, with a thread as a sheet over the room; a middling screen gives the
  // thread the room's place; a wide one shows all three.
  const showRail = !phone || open.kind === 'none';
  const showMain = open.kind !== 'none' && (phone || wide || !threadOpen);

  return (
    <ScopeContext.Provider value={scope}>
      <Box className="rooms" data-rooms>
        {showRail && (
          <RoomRail
            rooms={rooms.data ?? []}
            selected={open.kind === 'room' ? open.roomId : open.kind === 'none' ? null : open.kind}
            select={(item) => select(item)}
            attention={attention}
            newRoom={() => setMaking(true)}
            newMessage={() => setWriting([])}
            search={(text) => { setQuery(text); select('search'); }}
          />
        )}
        {showMain && (
          <Box className="rooms-main" data-pane="room" component="section">
            {open.kind === 'room' && (
              <RoomPane key={open.roomId} roomId={open.roomId} threadOpen={threadOpen} back={() => select(null)} addPeople={(principals) => setWriting(principals)} />
            )}
            {open.kind === 'activity' && (
              <>
                <PaneHead back={phone ? () => select(null) : null} title={t('Activity')} />
                <Activity rooms={rooms.data ?? []} open={(id) => select(id)} />
              </>
            )}
            {open.kind === 'search' && (
              <>
                <PaneHead back={phone ? () => select(null) : null} title={t('Search messages')} />
                <SearchPanel query={query} setQuery={setQuery} rooms={rooms.data ?? []}
                  open={(hit) => select(`${hit.roomId}~${hit.threadOf ?? hit.messageId}`)} />
              </>
            )}
            {open.kind === 'browse' && (
              <>
                <PaneHead back={phone ? () => select(null) : null} title={t('Browse rooms')} />
                <Browse open={(id) => select(id)} />
              </>
            )}
            {(open.kind === 'ceo' || open.kind === 'palugada') && (
              <>
                <PaneHead back={phone ? () => select(null) : null} title={<AssistantTitle company={open.kind === 'ceo' ? ctx.company : null} />} />
                <Box className="assistant-inline">
                  <AssistantThread key={open.kind} company={open.kind === 'ceo' ? ctx.company : null} />
                </Box>
              </>
            )}
          </Box>
        )}
        {threadOpen && open.kind === 'room' && (
          <ThreadPanel key={open.threadId} roomId={open.roomId} rootId={open.threadId!} close={() => select(open.roomId)} alone={!wide && !phone} />
        )}
      </Box>
      <AskWork asking={asking} close={() => setAsking(null)} />
      <CallMeeting calling={calling} close={() => setCalling(null)} />
      <NewRoom opened={making} close={() => setMaking(false)} made={(id) => select(id)} />
      <NewMessage opened={writing !== null} chosen={writing ?? []} close={() => setWriting(null)} made={(id) => select(id)} />
    </ScopeContext.Provider>
  );
}

/** The top of the main pane: on a phone, the way back to the rail. */
function PaneHead({ back, title, children }: { back: (() => void) | null; title: ReactNode; children?: ReactNode }) {
  return (
    <Group className="pane-head" justify="space-between" wrap="nowrap" px={{ base: 'xs', sm: 'md' }} py="xs">
      <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {back && <ActionIcon variant="subtle" color="gray" onClick={back} aria-label={t('Back to the rooms')} data-back><IconArrowLeft size={18} /></ActionIcon>}
        {typeof title === 'string' ? <Text fw={700} truncate>{title}</Text> : title}
      </Group>
      {children}
    </Group>
  );
}

/** One room: its header, its messages, and the composer, or the press that joins it. */
function RoomPane({ roomId, threadOpen, back, addPeople }: {
  roomId: string;
  /** A thread is open beside or over the room: Esc closes it rather than marking the room read. */
  threadOpen: boolean;
  back: () => void;
  addPeople: (people: string[]) => void;
}) {
  const scope = useScope();
  const room = scope.room;
  const [info, setInfo] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [lastMine, setLastMine] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  // Once a message is kept: asked about, when "Ask the team" posted it; a meeting called about it, when "Call a
  // meeting about this" did; read again either way.
  const kept = useCallback((message: MessageView, pending: Pending) => {
    if (pending.then === 'ask') scope.askWork(message);
    if (pending.then === 'meeting') scope.callMeeting(message);
    scope.changed();
  }, [scope.askWork, scope.callMeeting, scope.changed]);
  const posting = usePosting(scope.companyId, roomId, kept);
  const failed = (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) });
  const send = (sent: Sent) => {
    void posting.start({
      body: sent.body, mentions: sent.mentions, mentionsRoom: sent.mentionsRoom, alsoInRoom: false, threadOf: null, then: null, files: sent.files,
    })
      .then((answer) => {
        if (answer.mentionsDropped.length > 0) {
          notifications.show({ color: 'yellow', message: tp('{count} person you named was not told: they are not in this room, or their name is no longer in the words.',
            '{count} people you named were not told: they are not in this room, or their names are no longer in the words.', answer.mentionsDropped.length) });
        }
      }, failed);
  };
  // Words to ask about are posted first, and the drawer opens on the message once it is kept; `/task` alone opens
  // the drawer with nothing asked yet.
  const ask = (body: string) => {
    if (!body) {
      scope.askWork(null);
      return;
    }
    void posting.start({ body, mentions: [], mentionsRoom: false, alsoInRoom: false, threadOf: null, then: 'ask' }).catch(failed);
  };
  // Words to call a meeting about are posted the same way, and the dialog opens on the message once it is kept: the
  // words are the person's, and stay in the room whether or not the meeting is called.
  const meet = (body: string) => {
    void posting.start({ body, mentions: [], mentionsRoom: false, alsoInRoom: false, threadOf: null, then: 'meeting' }).catch(failed);
  };
  const shown = useCallback((messages: MessageView[]) => {
    const mine = [...messages].reverse().find((one) => one.author.principal === scope.me && one.may.edit);
    setLastMine(mine?.id ?? null);
  }, [scope.me]);

  const join = async () => {
    setJoining(true);
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${roomId}/join`, {});
      scope.changed();
    } catch (failure) {
      failed(failure);
    } finally {
      setJoining(false);
    }
  };

  const title = room ? roomName(room, scope.me) : '';
  const quietNow = room ? quiet(room) : false;
  return (
    <>
      <PaneHead back={scope.phone ? back : null} title={
        <Box style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            {room && room.kind !== 'direct' && (room.private ? <IconLock size={16} /> : <IconHash size={16} />)}
            <Text fw={700} truncate>{title}</Text>
            {quietNow && <IconBellOff size={14} color="var(--mantine-color-dimmed)" aria-label={t('Quiet')} />}
          </Group>
          {room?.about && <Text size="xs" c="dimmed" truncate>{room.about}</Text>}
        </Box>
      }>
        {room && (
          <Group gap={4} wrap="nowrap">
            <Text size="xs" c="dimmed" visibleFrom="sm">{tp('{count} person', '{count} people', room.members.length)}</Text>
            <Tooltip label={t('About this room')}>
              <ActionIcon variant="subtle" color="gray" onClick={() => setInfo(true)} aria-label={t('About this room')}><IconInfoCircle size={18} /></ActionIcon>
            </Tooltip>
          </Group>
        )}
      </PaneHead>
      {room && (room.private || room.kind === 'direct') && (
        <Text size="xs" c="dimmed" px={{ base: 'xs', sm: 'md' }} pb={6} className="room-disclosure">{disclosureOf(room)}</Text>
      )}
      <Timeline roomId={roomId} escapeReads={!threadOpen} pending={posting.pending} retry={(one) => void posting.post(one).catch(failed)}
        editing={editing} setEditing={setEditing} shown={shown} />
      {room && room.archived && (
        <Text size="sm" c="dimmed" ta="center" p="md">{t('This room is archived: what was said is kept, and nobody can write in it.')}</Text>
      )}
      {room && !room.archived && !room.joined && (
        <Group justify="center" p="md">
          <Button loading={joining} onClick={() => void join()}>{t('Join this room')}</Button>
        </Group>
      )}
      {room && !room.archived && room.joined && (
        <Composer
          roomId={roomId}
          placeholder={room.kind === 'direct' ? t('Write to {people}', { people: title }) : t('Write in {room}', { room: title })}
          send={send}
          ask={ask}
          meet={meet}
          {...(lastMine ? { editLast: () => setEditing(lastMine) } : {})}
        />
      )}
      <RoomInfo opened={info} close={() => setInfo(false)} addPeople={(people) => { setInfo(false); addPeople(people); }} />
    </>
  );
}
