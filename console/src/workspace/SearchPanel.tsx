/**
 * What was said, found (F19.14; STATUS 2.212): the rail's search, drawn in
 * the room's place.
 *
 * The server searches as the person, so what is listed is what they may see
 * and nothing else; this draws it, twenty at a time, newest first, and opens
 * a hit where it was said: the room around it, or its thread when it is a
 * reply (STATUS 2.218). The words of a hit are a person's, shown as text.
 *
 * A search looks in the room that was open first, as a person in a room
 * usually means, and can look in every room; it narrows to one person too,
 * chosen or typed as Slack's are: `in:#room` and `from:@handle` (or
 * `from:@owner`) in the words (STATUS 2.218).
 *
 * Nothing is kept in the browser: the words searched for live in the page's
 * memory, and go with it.
 */
import { useEffect, useState } from 'react';
import { Avatar, Box, Button, Checkbox, Group, Highlight, Loader, Select, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconFile, IconSearch } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, roomName, useScope } from './scope.ts';
import type { Person, RoomListItem, SearchHit } from './types.ts';

/** What was typed, with `in:#room` and `from:@person` taken out as filters; each left undefined when not typed. */
export function narrowed(text: string, rooms: RoomListItem[], people: Person[], me: string): { words: string; roomId?: string; from?: string } {
  let roomId: string | undefined;
  let from: string | undefined;
  const words = text.replace(/(^|\s)(in|from):([#@]?)(\S+)/giu, (whole, space: string, kind: string, _mark: string, name: string) => {
    const wanted = name.toLowerCase();
    if (kind.toLowerCase() === 'in') {
      const room = rooms.find((one) => (one.name ?? '').toLowerCase() === wanted || roomName(one, me).toLowerCase() === wanted);
      if (!room) return whole;
      roomId = room.id;
      return space;
    }
    const person = wanted === 'owner' ? people.find((one) => one.principal === 'owner')
      : people.find((one) => (one.handle ?? '').toLowerCase() === wanted);
    if (!person) return whole;
    from = person.principal;
    return space;
  }).replace(/\s+/g, ' ').trim();
  return { words, ...(roomId ? { roomId } : {}), ...(from ? { from } : {}) };
}

export function SearchPanel({ query, setQuery, rooms, from: lastRoom, open }: {
  query: string;
  setQuery: (query: string) => void;
  rooms: RoomListItem[];
  /** The room that was open when the search began, where it looks first. */
  from: string | null;
  /** Opens a hit where it was said. */
  open: (hit: SearchHit) => void;
}) {
  const scope = useScope();
  const [typed, setTyped] = useState(query);
  const [files, setFiles] = useState(false);
  // Where to look and who said it; '' is every room, and anyone.
  const [inRoom, setInRoom] = useState(lastRoom ?? '');
  const [byPerson, setByPerson] = useState('');
  const EVERY = 'every';
  const ANYONE = 'anyone';
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setTyped(query); }, [query]);
  // Filters typed in the words are the choices drawn too, so the two never disagree.
  const asked = narrowed(query, rooms, scope.people, scope.me);
  useEffect(() => {
    if (asked.roomId !== undefined) setInRoom(asked.roomId);
    if (asked.from !== undefined) setByPerson(asked.from);
  }, [asked.roomId, asked.from]);
  const room = asked.roomId ?? inRoom;
  const person = asked.from ?? byPerson;

  const page = async (from: number | null) => {
    const text = asked.words;
    if (text.length < 2) {
      setHits(null);
      return;
    }
    setLoading(true);
    try {
      const narrowing = `${room ? `&room=${room}` : ''}${person ? `&from=${encodeURIComponent(person)}` : ''}`;
      const wanted = `q=${encodeURIComponent(text)}${narrowing}${files ? '&files=1' : ''}${from !== null ? `&before=${from}` : ''}`;
      const answer: { hits: SearchHit[]; before: number | null } = await api('GET', `/api/companies/${scope.companyId}/room-search?${wanted}`);
      setHits((now) => (from === null ? answer.hits : [...(now ?? []), ...answer.hits]));
      setBefore(answer.before);
      setError(null);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void page(null); }, [query, files, room, person, scope.companyId]);

  const roomOf = (id: string) => rooms.find((room) => room.id === id);
  return (
    <Stack gap="sm" p={{ base: 'xs', sm: 'md' }} className="search-panel" style={{ overflowY: 'auto', flex: 1 }}>
      <form onSubmit={(event) => { event.preventDefault(); setQuery(typed.trim()); }}>
        <TextInput
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
          placeholder={t('Search messages')}
          aria-label={t('Search messages')}
          leftSection={<IconSearch size={16} />}
          maxLength={200}
          autoFocus
          dir="auto"
        />
      </form>
      <Group gap="xs" wrap="wrap" align="flex-end">
        <Select size="xs" data-search-room aria-label={t('Where to look')} value={room || EVERY} allowDeselect={false} style={{ flex: '1 1 160px', minWidth: 0 }}
          data={[{ value: EVERY, label: t('Every room') }, ...rooms.filter((one) => one.joined).map((one) => ({ value: one.id, label: roomName(one, scope.me) }))]}
          onChange={(value) => {
            setInRoom(value && value !== EVERY ? value : '');
            if (asked.roomId !== undefined) setQuery(query.replace(/(^|\s)in:\S+/giu, ' ').trim());
          }} />
        <Select size="xs" data-search-from aria-label={t('Said by')} value={person || ANYONE} allowDeselect={false} searchable style={{ flex: '1 1 160px', minWidth: 0 }}
          data={[{ value: ANYONE, label: t('Anyone') }, ...scope.people.map((one) => ({ value: one.principal, label: one.handle ? `${nameOf(one)} @${one.handle}` : nameOf(one) }))]}
          onChange={(value) => {
            setByPerson(value && value !== ANYONE ? value : '');
            if (asked.from !== undefined) setQuery(query.replace(/(^|\s)from:\S+/giu, ' ').trim());
          }} />
      </Group>
      <Checkbox size="xs" label={t("Files' names too")} checked={files} onChange={(event) => setFiles(event.currentTarget.checked)} />
      {error && <Text c="red" size="sm">{error}</Text>}
      {hits === null && !loading && <Text size="sm" c="dimmed">{t('Type two letters or more, then press Enter.')}</Text>}
      {hits !== null && hits.length === 0 && !loading && <Text size="sm" c="dimmed">{t('Nothing said here matches.')}</Text>}
      {(hits ?? []).map((hit) => {
        const room = roomOf(hit.roomId);
        return (
          <UnstyledButton key={hit.messageId} className="search-hit" data-hit={hit.messageId} onClick={() => open(hit)}>
            <Group gap="sm" wrap="nowrap" align="flex-start">
              <Avatar size={28} radius="xl" src={personPicture(hit.author.principal, hit.author.picture)} alt="" />
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="wrap">
                  <Text size="sm" fw={600}>{nameOf(hit.author)}</Text>
                  {hit.author.handle && <Text size="xs" c="dimmed" dir="ltr">@{hit.author.handle}</Text>}
                  <Text size="xs" c="dimmed">{room ? roomName(room, scope.me) : t('A room')}</Text>
                  <Text size="xs" c="dimmed">{relative(hit.at)}</Text>
                </Group>
                {hit.excerpt && <Highlight size="sm" highlight={asked.words} dir="auto" lineClamp={3}>{hit.excerpt}</Highlight>}
                {hit.file && (
                  <Group gap={4} wrap="nowrap">
                    <IconFile size={14} />
                    <Highlight size="xs" highlight={asked.words} truncate dir="auto">{hit.file.name}</Highlight>
                  </Group>
                )}
              </Box>
            </Group>
          </UnstyledButton>
        );
      })}
      {loading && <Group justify="center"><Loader size="sm" /></Group>}
      {before !== null && !loading && (
        <Group justify="center">
          <Button size="compact-sm" variant="subtle" onClick={() => void page(before)}>{t('Earlier messages')}</Button>
        </Group>
      )}
    </Stack>
  );
}
