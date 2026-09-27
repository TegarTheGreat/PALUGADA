/**
 * What the company knows (F4), as its agents will be told it.
 *
 * Four kinds, because they are four different promises: a fact is something
 * the company believes, a procedure is how it does something, an episode is
 * something that happened, and a working note is a task's scratch pad. Each
 * carries where it applies and how sure the platform is of it, and a fact
 * under the line a run is told to check (LOW_CONFIDENCE in the context
 * builder) says UNVERIFIED here exactly as it does there.
 *
 * Nothing is deleted from here. A wrong fact is replaced, and the old one
 * keeps pointing at what replaced it (F4.3); confirming an unverified fact is
 * replacing it with itself, said by the owner, at full confidence.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Group, Modal, Paper, SegmentedControl, Select, Stack, Switch, Tabs, Text, Textarea,
  TextInput, Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBrain, IconCheck, IconFileText, IconPencil, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { MemoryItem, MemoryKind, Structure } from '../types.ts';
import { relative } from '../format.ts';
import { N, t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, LoadFailed, Loading, PageHeader } from '../components/ui.tsx';
import { Documents } from '../components/Documents.tsx';

const KINDS: Array<{ kind: MemoryKind; label: string; hint: string }> = [
  { kind: 'semantic', label: N('Facts'), hint: N('What the company believes to be true. Agents are given the most relevant ones in every run.') },
  { kind: 'procedural', label: N('Procedures'), hint: N('How the company does things. Given to every run in the division they belong to.') },
  { kind: 'episodic', label: N('Episodes'), hint: N('What happened. Distilled into facts and procedures once a pattern repeats.') },
  { kind: 'working', label: N('Working notes'), hint: N("A task's own notes while it runs. Kept for the record.") },
];

const SOURCES: Record<string, string> = {
  owner: N('you'), distillation: N('learned from work'), adversarial_review: N('a review'),
  vendor: N('a vendor'), grant: N('a grant'), unspecified: N('not recorded'), agent: N('a run, from its own work'),
  template: N('the template'),
};

/** Where a memory came from, in words: a pattern learned from one capability reads as that. */
function sourceOf(source: string): string {
  if (source.startsWith('pattern:')) return t('a pattern in {capability}', { capability: source.slice('pattern:'.length) });
  const known = SOURCES[source];
  return known ? t(known) : source;
}

interface MemoryAnswer {
  items: MemoryItem[];
  counts: Record<MemoryKind, number>;
  candidates: number;
  next: string | null;
}

export function Memory({ ctx }: PageProps) {
  const { companyId } = ctx;
  const [kind, setKind] = useState<MemoryKind>('semantic');
  const [search, setSearch] = useState('');
  const [query] = useDebouncedValue(search, 300);
  const [replaced, setReplaced] = useState(false);
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [adding, setAdding] = useState(false);
  const [division, setDivision] = useState<string | null>(null);
  const [view, setView] = useState<'memory' | 'documents'>('memory');
  // Older pages, fetched on request and kept until the filters change.
  const [older, setOlder] = useState<MemoryItem[]>([]);
  // The page marker the server gave with the last page; null when that was all.
  const [next, setNext] = useState<string | null>(null);
  const PAGE = 100;

  const filters = (before?: string) => {
    const params = new URLSearchParams({ kind, limit: String(PAGE) });
    if (query.trim()) params.set('q', query.trim());
    if (replaced) params.set('superseded', 'include');
    if (division) params.set('division', division);
    if (before) params.set('before', before);
    return params.toString();
  };
  const memory = useLoad(async () => {
    setOlder([]);
    const answer: MemoryAnswer = await api('GET', `/api/companies/${companyId}/memories?${filters()}`);
    setNext(answer.next);
    return answer;
  }, [companyId, kind, query, replaced, division]);
  const structure = useLoad(async (): Promise<Structure> => api('GET', `/api/companies/${companyId}/structure`), [companyId]);
  const shown = [...(memory.data?.items ?? []), ...older];
  const loadOlder = async () => {
    if (!next) return;
    try {
      const answer: MemoryAnswer = await api('GET', `/api/companies/${companyId}/memories?${filters(next)}`);
      setOlder((now) => [...now, ...answer.items]);
      setNext(answer.next);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };
  const retract = async (item: MemoryItem) => {
    try {
      await api('POST', `/api/companies/${companyId}/memories/${item.id}/retract`, {});
      notifications.show({ color: 'teal', message: t('Taken back. No run is told it any more; it stays in the record.') });
      memory.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const current = KINDS.find((one) => one.kind === kind)!;
  const counts = memory.data?.counts;

  const confirm = async (item: MemoryItem) => {
    try {
      await api('POST', `/api/companies/${companyId}/memories/${item.id}/supersede`, { body: item.body, confidence: 1 });
      notifications.show({ color: 'teal', message: t('Confirmed. Agents will now treat it as known.') });
      memory.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  return (
    <Stack gap="lg">
      <PageHeader
        crumbs={[ctx.company.name]}
        title={t('Memory')}
        description={t('What this company knows and tells its agents. Correct anything wrong here; the old version is kept, marked as replaced.')}
        actions={view === 'memory' ? <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>{t('Tell the company something')}</Button> : undefined}
      />

      <Tabs value={view} onChange={(value) => setView(value === 'documents' ? 'documents' : 'memory')}>
        <Tabs.List>
          <Tabs.Tab value="memory" leftSection={<IconBrain size={16} />}>{t('Facts and ways to work')}</Tabs.Tab>
          <Tabs.Tab value="documents" leftSection={<IconFileText size={16} />}>{t('Documents')}</Tabs.Tab>
        </Tabs.List>
      </Tabs>

      {view === 'documents' ? <Documents companyId={companyId} structure={structure.data ?? null} /> : (<>
      <SegmentedControl
        value={kind}
        onChange={(value) => setKind(value as MemoryKind)}
        data={KINDS.map((one) => ({ value: one.kind, label: counts ? `${t(one.label)} · ${counts[one.kind]}` : t(one.label) }))}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}
      />

      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text size="sm" c="dimmed" maw={620}>{t(current.hint)}</Text>
        <Group gap="md">
          <TextInput
            leftSection={<IconSearch size={16} />}
            placeholder={t('Search what it knows')}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
            w={260}
          />
          <Select placeholder={t('Every division')} clearable w={200} value={division} onChange={setDivision}
            data={(structure.data?.divisions ?? []).map((one) => ({ value: one.id, label: one.name }))} />
          <Switch label={t('Show replaced')} checked={replaced} onChange={(event) => setReplaced(event.currentTarget.checked)} />
        </Group>
      </Group>

      {memory.data && memory.data.candidates > 0 && (
        <Alert color="blue" variant="light" title={t('Waiting for you')}>
          <Group justify="space-between" gap="sm">
            <Text size="sm">{t('{count} things the agents learned are waiting for your yes before they are used.', { count: memory.data.candidates })}</Text>
            <Button size="xs" variant="light" onClick={() => ctx.open('inbox')}>{t('Open the inbox')}</Button>
          </Group>
        </Alert>
      )}

      {memory.error && !memory.data ? <LoadFailed message={memory.error} retry={memory.reload} /> : !memory.data ? <Loading rows={4} /> : (
        shown.length === 0 ? (
          <Paper withBorder radius="lg">
            <EmptyState
              title={query ? t('Nothing matches') : t('Nothing here yet')}
              description={query ? t('Try other words, or another kind.') : t('The company learns as it works. You can also tell it something yourself.')}
            />
          </Paper>
        ) : (
          <Stack gap="sm">
            {shown.map((item) => (
              <Paper key={item.id} withBorder radius="lg" p="md" style={item.supersededBy ? { opacity: 0.6 } : undefined}>
                <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} mb={8}>
                      {item.approval === 'rejected' ? <Badge color="gray" variant="outline">{t('Taken back')}</Badge>
                        : item.supersededBy ? <Badge color="gray" variant="outline">{t('Replaced')}</Badge>
                        : item.unverified ? (
                          <Tooltip label={t('Agents are told to check this before relying on it.')}>
                            <Badge color="orange" variant="light" leftSection={<IconAlertTriangle size={12} />}>{t('Unverified')}</Badge>
                          </Tooltip>
                        ) : <Badge color="teal" variant="light">{t('Known')}</Badge>}
                      <Badge color="gray" variant="light">{item.scopeName ?? t('Whole company')}</Badge>
                      {item.approval === 'candidate' && <Badge color="blue" variant="light">{t('Waiting for you')}</Badge>}
                      {item.outside && (
                        <Tooltip label={t('Learned from content the company did not write, such as an email or a web page. Runs are shown it as data, never as a known fact.')}>
                          <Badge color="grape" variant="light">{t('From outside content')}</Badge>
                        </Tooltip>
                      )}
                      {item.reinforcedCount > 0 && <Badge color="gray" variant="light">{t('learned {count} more times', { count: item.reinforcedCount })}</Badge>}
                    </Group>
                    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{item.body}</Text>
                    <Group gap={6} mt={8}>
                      <Text size="xs" c="dimmed">
                        {t('From {source} · {when} · confidence {confidence}', {
                          source: sourceOf(item.source),
                          when: relative(item.createdAt),
                          confidence: `${Math.round(item.confidence * 100)}%`,
                        })}
                      </Text>
                      {item.sourceTaskId && (
                        <Button size="compact-xs" variant="subtle" onClick={() => ctx.open('work', { item: item.sourceTaskId })}>{t('The work that taught it')}</Button>
                      )}
                    </Group>
                  </div>
                  {!item.supersededBy && item.approval !== 'rejected' && (
                    <Group gap={6} wrap="nowrap">
                      {item.unverified && (
                        <Button size="xs" variant="light" color="teal" leftSection={<IconCheck size={14} />} onClick={() => void confirm(item)}>
                          {t('It is true')}
                        </Button>
                      )}
                      <Button size="xs" variant="default" leftSection={<IconPencil size={14} />} onClick={() => setEditing(item)}>
                        {t('Correct')}
                      </Button>
                      {item.approval === 'active' && (
                        <Tooltip label={t('For something the company should not believe at all. It leaves every run and stays in the record.')}>
                          <Button size="xs" variant="subtle" color="red" leftSection={<IconX size={14} />} onClick={() => void retract(item)}>
                            {t('Take back')}
                          </Button>
                        </Tooltip>
                      )}
                    </Group>
                  )}
                </Group>
              </Paper>
            ))}
            {next && (
              <Group justify="center">
                <Button variant="subtle" onClick={() => void loadOlder()}>{t('Show older')}</Button>
              </Group>
            )}
          </Stack>
        )
      )}
      </>)}

      <Correct key={editing?.id ?? 'none'} companyId={companyId} item={editing} close={() => setEditing(null)} done={memory.reload} />
      <Tell companyId={companyId} opened={adding} close={() => setAdding(false)} done={() => { setAdding(false); memory.reload(); }} />
    </Stack>
  );
}

function Correct({ companyId, item, close, done }: { companyId: string; item: MemoryItem | null; close: () => void; done: () => void }) {
  const [body, setBody] = useState(item?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/memories/${item.id}/supersede`, { body, confidence: 1 });
      notifications.show({ color: 'teal', message: t('Replaced. The old version is kept, marked as replaced.') });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={item !== null} onClose={close} title={t('Correct what the company knows')} size="lg" centered>
      <Stack>
        <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-default-hover)">
          <Text size="xs" c="dimmed" mb={4}>{t('Now')}</Text>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{item?.body}</Text>
        </Paper>
        <Textarea label={t('What it should say')} autosize minRows={3} value={body} onChange={(event) => setBody(event.currentTarget.value)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button loading={busy} disabled={!body.trim() || body === item?.body} onClick={() => void submit()}>{t('Replace it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * The owner telling the company something directly: a fact it should know or
 * a procedure it should follow, company-wide or for one division. Said by the
 * owner, so it goes in at full confidence and needs no one's review.
 */
function Tell({ companyId, opened, close, done }: { companyId: string; opened: boolean; close: () => void; done: () => void }) {
  const structure = useLoad(async () => {
    if (!opened) return null;
    const answer: Structure = await api('GET', `/api/companies/${companyId}/structure`);
    return answer;
  }, [companyId, opened]);
  const [kind, setKind] = useState<'semantic' | 'procedural'>('semantic');
  const [divisionId, setDivisionId] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/memories`, { kind, body, ...(divisionId ? { divisionId } : {}) });
      notifications.show({ color: 'teal', message: t('Saved. Agents will be told from their next run.') });
      setBody('');
      done();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Tell the company something')} size="lg" centered>
      <Stack>
        <SegmentedControl
          value={kind}
          onChange={(value) => setKind(value as 'semantic' | 'procedural')}
          data={[{ value: 'semantic', label: t('A fact to know') }, { value: 'procedural', label: t('A way to work') }]}
        />
        <Select
          label={t('For')}
          placeholder={t('Whole company')}
          clearable
          data={(structure.data?.divisions ?? []).map((division) => ({ value: division.id, label: division.name }))}
          value={divisionId}
          onChange={setDivisionId}
        />
        <Textarea
          label={kind === 'semantic' ? t('The fact') : t('The procedure')}
          description={kind === 'semantic'
            ? t('One fact, stated plainly. For example: our prices include tax.')
            : t('How to do it, as steps or rules. For example: always quote in rupiah; never promise delivery dates.')}
          autosize
          minRows={3}
          value={body}
          onChange={(event) => setBody(event.currentTarget.value)}
        />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button loading={busy} disabled={!body.trim()} onClick={() => void submit()}>{t('Save it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
