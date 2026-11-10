/**
 * What was said, found (F19.14; STATUS 2.212): the rail's search, drawn in
 * the room's place.
 *
 * The server searches as the person, so what is listed is what they may see
 * and nothing else; this draws it, twenty at a time, newest first, and opens
 * a hit in its thread, where a reply is read and a message is shown with
 * what was said under it. The words of a hit are a person's, shown as text.
 * Nothing is kept in the browser: the words searched for live in the page's
 * memory, and go with it.
 */
import { useEffect, useState } from 'react';
import { Avatar, Box, Button, Checkbox, Group, Highlight, Loader, Stack, Text, TextInput, UnstyledButton } from '@mantine/core';
import { IconFile, IconSearch } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, roomName, useScope } from './scope.ts';
import type { RoomListItem, SearchHit } from './types.ts';

export function SearchPanel({ query, setQuery, rooms, open }: {
  query: string;
  setQuery: (query: string) => void;
  rooms: RoomListItem[];
  /** Opens a hit: its room and thread. */
  open: (hit: SearchHit) => void;
}) {
  const scope = useScope();
  const [typed, setTyped] = useState(query);
  const [files, setFiles] = useState(false);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setTyped(query); }, [query]);

  const page = async (from: number | null) => {
    const text = query.trim();
    if (text.length < 2) {
      setHits(null);
      return;
    }
    setLoading(true);
    try {
      const asked = `q=${encodeURIComponent(text)}${files ? '&files=1' : ''}${from !== null ? `&before=${from}` : ''}`;
      const answer: { hits: SearchHit[]; before: number | null } = await api('GET', `/api/companies/${scope.companyId}/room-search?${asked}`);
      setHits((now) => (from === null ? answer.hits : [...(now ?? []), ...answer.hits]));
      setBefore(answer.before);
      setError(null);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void page(null); }, [query, files, scope.companyId]);

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
                {hit.excerpt && <Highlight size="sm" highlight={query.trim()} dir="auto" lineClamp={3}>{hit.excerpt}</Highlight>}
                {hit.file && (
                  <Group gap={4} wrap="nowrap">
                    <IconFile size={14} />
                    <Highlight size="xs" highlight={query.trim()} truncate dir="auto">{hit.file.name}</Highlight>
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
