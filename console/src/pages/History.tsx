/**
 * What was decided, and what closed without a decision (F10.8).
 *
 * The inbox is a queue, so an answered item leaves the only screen there is.
 * The search reads the owner's own note as well as the item, because the note
 * is where the reason was written and the reason is what is looked for a
 * month later.
 */
import { useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { ClosedDecision } from '../types.ts';
import { dateTime, humanize } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, KindBadge, LoadFailed, Loading, TierBadge } from '../components/ui.tsx';

function outcome(item: ClosedDecision): { label: string; color: string } {
  if (item.status === 'decided') {
    const decision = item.decision ?? 'decided';
    return { label: decision, color: decision === 'approve' ? 'teal' : decision === 'deny' ? 'gray' : 'blue' };
  }
  if (item.status === 'expired') return { label: 'expired unanswered', color: 'orange' };
  return { label: `withdrawn · ${humanize(item.closedReason ?? 'no reason')}`, color: 'gray' };
}

export function History({ ctx }: PageProps) {
  const { companyId } = ctx;
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  // The page marker the API hands back, per company: switching companies
  // remounts this page, so a marker from one is never sent to another.
  const [before, setBefore] = useState<string | null>(null);
  const page = useLoad(async () => {
    const params = new URLSearchParams();
    if (search) params.set('q', search);
    if (before) params.set('before', before);
    const answer: { items: ClosedDecision[]; next: string | null } =
      await api('GET', `/api/companies/${companyId}/decisions?${params.toString()}`);
    return answer;
  }, [companyId, search, before]);

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>History</Title>
      </div>
      <form onSubmit={(event) => { event.preventDefault(); setBefore(null); setSearch(query.trim()); }}>
        <Group gap="xs" align="flex-end">
          <TextInput
            style={{ flex: 1, maxWidth: 520 }}
            leftSection={<IconSearch size={16} />}
            placeholder="Search titles, summaries and your notes"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Button type="submit">Search</Button>
        </Group>
      </form>
      {page.error ? <LoadFailed message={page.error} retry={page.reload} /> : !page.data ? <Loading /> : (
        <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
          {page.data.items.length === 0 ? (
            <EmptyState title={search ? 'Nothing matches' : 'Nothing decided yet'} description={search ? 'Try other words; your notes are searched too.' : 'Decided items land here with your note.'} />
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr><Table.Th>When</Table.Th><Table.Th>What</Table.Th><Table.Th>Outcome</Table.Th><Table.Th>Via</Table.Th><Table.Th>Your note</Table.Th></Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {page.data.items.map((item) => {
                    const result = outcome(item);
                    return (
                      <Table.Tr key={item.id}>
                        <Table.Td><Text size="sm" c="dimmed" style={{ whiteSpace: 'nowrap' }}>{dateTime(item.decidedAt ?? item.createdAt)}</Text></Table.Td>
                        <Table.Td maw={340}>
                          <Text size="sm" fw={600} lineClamp={2}>{item.title}</Text>
                          <Group gap={6} mt={4}><KindBadge kind={item.kind} /><TierBadge tier={item.tier} /></Group>
                        </Table.Td>
                        <Table.Td><Badge color={result.color} variant="light">{result.label}</Badge></Table.Td>
                        <Table.Td><Text size="sm" c="dimmed">{item.via ?? '—'}</Text></Table.Td>
                        <Table.Td maw={280}><Text size="sm" lineClamp={3}>{item.note ?? ''}</Text></Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>
      )}
      <Group>
        {before && <Button variant="default" onClick={() => setBefore(null)}>Newest</Button>}
        {page.data?.next && <Button variant="default" onClick={() => setBefore(page.data!.next)}>Older</Button>}
      </Group>
    </Stack>
  );
}
