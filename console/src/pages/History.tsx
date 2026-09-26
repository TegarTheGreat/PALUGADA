/**
 * What was decided, and what closed without a decision (F10.8).
 *
 * The inbox is a queue, so an answered item leaves the only screen there is.
 * The search reads the owner's own note as well as the item, because the note
 * is where the reason was written and the reason is what is looked for a
 * month later.
 */
import { useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Table, Text, TextInput } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { ClosedDecision } from '../types.ts';
import { dateTime, humanize } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { N, t } from '../i18n.ts';
import { EmptyState, KindBadge, LoadFailed, Loading, PageHeader, TierBadge } from '../components/ui.tsx';

const DECISIONS: Record<string, string> = { approve: N('Approved'), deny: N('Denied'), ask: N('Asked a question') };

function outcome(item: ClosedDecision): { label: string; color: string } {
  if (item.status === 'decided') {
    const decision = item.decision ?? '';
    const label = DECISIONS[decision];
    return { label: label ? t(label) : t('Decided'), color: decision === 'approve' ? 'teal' : decision === 'deny' ? 'gray' : 'blue' };
  }
  if (item.status === 'expired') return { label: t('expired unanswered'), color: 'orange' };
  return { label: item.closedReason ? t('withdrawn · {reason}', { reason: humanize(item.closedReason) }) : t('withdrawn'), color: 'gray' };
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
      <PageHeader
        crumbs={[ctx.company.name]}
        title={t('History')}
        description={t('Every decision you made, and every item that closed without one. Your notes are searched too: that is where the reasons are.')}
      />
      <form onSubmit={(event) => { event.preventDefault(); setBefore(null); setSearch(query.trim()); }}>
        <Group gap="xs" align="flex-end">
          <TextInput
            style={{ flex: 1, maxWidth: 520 }}
            leftSection={<IconSearch size={16} />}
            placeholder={t('Search titles, summaries and your notes')}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Button type="submit">{t('Search')}</Button>
        </Group>
      </form>
      {page.error ? <LoadFailed message={page.error} retry={page.reload} /> : !page.data ? <Loading /> : (
        <Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
          {page.data.items.length === 0 ? (
            <EmptyState title={search ? t('Nothing matches') : t('Nothing decided yet')} description={search ? t('Try other words; your notes are searched too.') : t('Decided items land here with your note.')} />
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr><Table.Th>{t('When')}</Table.Th><Table.Th>{t('What')}</Table.Th><Table.Th>{t('Outcome')}</Table.Th><Table.Th>{t('Via')}</Table.Th><Table.Th>{t('Your note')}</Table.Th></Table.Tr>
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
        {before && <Button variant="default" onClick={() => setBefore(null)}>{t('Newest')}</Button>}
        {page.data?.next && <Button variant="default" onClick={() => setBefore(page.data!.next)}>{t('Older')}</Button>}
      </Group>
    </Stack>
  );
}
