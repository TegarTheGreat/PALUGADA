/**
 * The work: what is running, what is waiting and on whom, what finished and
 * what stopped -- and, for any one task, how far it has got and what it did,
 * step by step.
 *
 * A task that has said "running" for an hour tells the owner nothing. So every
 * live row carries its progress from the task's own journal -- steps done
 * against the plan, the step it is on, and when its worker last said it was
 * alive -- and the page refreshes itself while it is open.
 */
import { useState } from 'react';
import {
  Badge, Button, Code, Drawer, Group, Paper, Progress, SegmentedControl, SimpleGrid, Stack, Table,
  Text, Timeline, Tooltip,
} from '@mantine/core';
import { IconHeartbeat, IconPlayerPlay, IconPlus } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad, useNow } from '../hooks.ts';
import { go } from '../router.ts';
import type { WorkGroup, WorkItem } from '../types.ts';
import { dateTime, eventSentence, haltReason, humanize, money, relative } from '../format.ts';
import { t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, LoadFailed, Loading, PageHeader, StatusBadge } from '../components/ui.tsx';

type Filter = WorkGroup | 'all';

const LIVE = ['pending', 'checked_out', 'running'];

export function Work({ ctx, route }: PageProps) {
  const { companyId } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const work = useLoad(async () => {
    const answer: { items: WorkItem[]; counts: Record<WorkGroup, number> } = filter === 'all'
      ? await api('GET', `/api/companies/${companyId}/work?limit=100`)
      : await api('GET', `/api/companies/${companyId}/work?group=${filter}&limit=100`);
    return answer;
  }, [companyId, filter], { every: 10_000 });

  const counts = work.data?.counts;
  const label = (group: WorkGroup, text: string) => (counts ? `${text} · ${counts[group]}` : text);
  const open = work.data?.items.find((item) => item.id === route.item) ?? null;
  const openTask = (id: string | null) => go({ ...route, item: id });

  return (
    <Stack gap="lg">
      <PageHeader
        crumbs={[ctx.company.name]}
        title={t('Work')}
        description={t('Every task, with how far it has got. Running tasks show the step they are on and when their worker last checked in.')}
        live={work.updatedAt}
        actions={<Button leftSection={<IconPlus size={16} />} onClick={ctx.giveWork}>{t('Give work')}</Button>}
      />

      <SegmentedControl
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        data={[
          { value: 'all', label: t('All') },
          { value: 'active', label: label('active', t('Running')) },
          { value: 'waiting', label: label('waiting', t('Waiting')) },
          { value: 'done', label: label('done', t('Done')) },
          { value: 'stopped', label: label('stopped', t('Stopped')) },
        ]}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}
      />

      {work.error && !work.data ? <LoadFailed message={work.error} retry={work.reload} /> : !work.data ? <Loading /> : (
        <Paper withBorder radius="lg" style={{ overflow: 'hidden' }}>
          {work.data.items.length === 0 ? (
            <EmptyState
              title={t('Nothing here')}
              description={t('No task is in this state right now.')}
              action={<Button variant="light" onClick={ctx.giveWork}>{t('Give a role something to do')}</Button>}
            />
          ) : (
            <Table.ScrollContainer minWidth={820}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('Task')}</Table.Th>
                    <Table.Th>{t('Status')}</Table.Th>
                    <Table.Th w={220}>{t('Progress')}</Table.Th>
                    <Table.Th>{t('Serves')}</Table.Th>
                    <Table.Th ta="right">{t('Cost')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {work.data.items.map((item) => (
                    <Table.Tr key={item.id} className="clickable-row" onClick={() => openTask(item.id)}>
                      <Table.Td maw={340}>
                        <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                        <Group gap={6}>
                          <Text size="xs" c="dimmed">{item.roleSlug} · {item.divisionName} · {relative(item.startedAt ?? item.createdAt)}</Text>
                          {item.schedule && <Badge size="xs" variant="outline" color="gray">{item.schedule}</Badge>}
                          {item.parentTaskId && <Badge size="xs" variant="outline" color="gray">{t('sub-task')}</Badge>}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={item.status} />
                        {item.haltReason && <Text size="xs" c="red" mt={4}>{haltReason(item.haltReason)}</Text>}
                      </Table.Td>
                      <Table.Td><TaskProgress item={item} /></Table.Td>
                      <Table.Td maw={240}><Text size="sm" c="dimmed" lineClamp={1}>{item.goal ?? '—'}</Text></Table.Td>
                      <Table.Td ta="right"><Text size="sm" className="tabular">{money(item.costCents)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>
      )}

      <TaskDrawer companyId={companyId} task={open} close={() => openTask(null)} />
    </Stack>
  );
}

/**
 * How far one task has got, in a line: a bar when its plan named its steps,
 * the step it is on, and a heartbeat that goes amber when the worker has been
 * quiet for longer than a worker should be.
 */
export function TaskProgress({ item, wide = false }: { item: WorkItem; wide?: boolean }) {
  const now = useNow(5_000);
  const { progress } = item;
  const live = LIVE.includes(item.status);
  const finished = item.status === 'completed';
  const planned = progress.planSteps && progress.planSteps > 0 ? progress.planSteps : null;
  const percent = finished ? 100 : planned ? Math.min(100, (progress.stepsDone / planned) * 100) : null;
  const quiet = progress.heartbeatAt ? (now - new Date(progress.heartbeatAt).getTime()) / 1000 : null;
  const stale = live && quiet !== null && quiet > 120;

  return (
    <Stack gap={4}>
      {percent !== null ? (
        <Group gap={8} wrap="nowrap">
          <Progress
            value={percent}
            size={wide ? 'md' : 'sm'}
            radius="xl"
            color={finished ? 'teal' : item.haltReason ? 'red' : 'brand'}
            animated={live && !stale}
            style={{ flex: 1 }}
          />
          <Text size="xs" c="dimmed" className="tabular" style={{ whiteSpace: 'nowrap' }}>
            {planned ? `${Math.min(progress.stepsDone, planned)}/${planned}` : '✓'}
          </Text>
        </Group>
      ) : (
        <Text size="xs" c="dimmed">
          {progress.stepsDone > 0 ? t('{count} steps done', { count: progress.stepsDone }) : live ? t('Starting') : '—'}
        </Text>
      )}
      {live && progress.currentStep && (
        <Text size="xs" lineClamp={1}>
          {progress.currentStepStatus === 'committed' ? t('Last: {step}', { step: humanize(progress.currentStep) }) : t('Now: {step}', { step: humanize(progress.currentStep) })}
        </Text>
      )}
      {live && progress.heartbeatAt && (
        <Tooltip label={progress.worker ? t('Worker {worker}', { worker: progress.worker }) : t('No worker holds it')}>
          <Group gap={4} wrap="nowrap">
            <IconHeartbeat size={13} color={stale ? 'var(--mantine-color-orange-6)' : 'var(--mantine-color-teal-6)'} />
            <Text size="xs" c={stale ? 'orange' : 'dimmed'}>
              {stale ? t('Quiet since {when}', { when: relative(progress.heartbeatAt) }) : t('Alive {when}', { when: relative(progress.heartbeatAt) })}
            </Text>
          </Group>
        </Tooltip>
      )}
    </Stack>
  );
}

/** One task: where it is, and every event it left, with a dry replay (F11.2, F5.9). */
export function TaskDrawer({ companyId, task, close }: { companyId: string; task: WorkItem | null; close: () => void }) {
  const events = useLoad(async () => {
    if (!task) return [];
    const answer: { events: Array<{ type: string; actor: string; payload: Record<string, unknown>; occurredAt: string }> } =
      await api('GET', `/api/companies/${companyId}/tasks/${task.id}/events`);
    return answer.events;
  }, [companyId, task?.id], { every: task && LIVE.includes(task.status) ? 10_000 : undefined });
  const [replay, setReplay] = useState<string | null>(null);
  const [replaying, setReplaying] = useState(false);

  // Nothing is repeated: the replay has no broker, no model client and no
  // adapter wired in at all, so a task that bought a domain cannot buy it again.
  const runReplay = async () => {
    if (!task) return;
    setReplaying(true);
    try {
      const answer: { summary: string; report: unknown } = await api('POST', `/api/companies/${companyId}/tasks/${task.id}/replay`, {});
      setReplay(`${answer.summary}\n\n${JSON.stringify(answer.report, null, 2)}`);
    } catch (failure) {
      setReplay(explain(failure));
    } finally {
      setReplaying(false);
    }
  };

  return (
    <Drawer opened={task !== null} onClose={() => { setReplay(null); close(); }} position="right" size="lg" title={<Text fw={700}>{t('Task')}</Text>}>
      {task && (
        <Stack gap="lg">
          <div>
            <Group gap="xs" mb={6}><StatusBadge status={task.status} />{task.haltReason && <Badge color="red" variant="light">{haltReason(task.haltReason)}</Badge>}</Group>
            <Text fw={700} size="lg">{task.summary}</Text>
            <Text size="sm" c="dimmed">{task.roleSlug} · {task.divisionName}</Text>
          </div>
          <Paper withBorder radius="md" p="md">
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs">{t('Progress')}</Text>
            <TaskProgress item={task} wide />
            {task.progress.deadlineAt && (
              <Text size="xs" c="dimmed" mt="xs">{t('Deadline {when}', { when: dateTime(task.progress.deadlineAt) })}</Text>
            )}
          </Paper>
          <SimpleGrid cols={2} spacing="sm">
            <Fact label={t('Serves')} value={task.goal ?? '—'} />
            <Fact label={t('Cost so far')} value={money(task.costCents)} />
            <Fact label={t('Attempt')} value={t('{attempt} of {max}', { attempt: task.attempt, max: task.attemptMax })} />
            <Fact label={t('Priority')} value={`P${task.priority}`} />
            <Fact label={t('Created')} value={dateTime(task.createdAt)} />
            <Fact label={t('Finished')} value={dateTime(task.finishedAt)} />
          </SimpleGrid>
          <div>
            <Text fw={700} mb="sm">{t('What it did')}</Text>
            {events.error ? <Text c="red" size="sm">{events.error}</Text> : !events.data ? <Loading rows={2} /> : events.data.length === 0 ? (
              <Text size="sm" c="dimmed">{t('No events yet.')}</Text>
            ) : (
              <Timeline bulletSize={14} lineWidth={2} active={events.data.length}>
                {events.data.map((event, index) => (
                  <Timeline.Item key={`${event.type}-${index}`} title={<Text size="sm" fw={600}>{eventSentence(event.type)}</Text>}
                    color={/refused|denied|failed|halt/.test(event.type) ? 'red' : 'blue'}>
                    <Text size="xs" c="dimmed">{event.actor} · {dateTime(event.occurredAt)}</Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
          </div>
          <div>
            <Button variant="light" leftSection={<IconPlayerPlay size={16} />} loading={replaying} onClick={() => void runReplay()}>
              {t('Replay against the journal')}
            </Button>
            <Text size="xs" c="dimmed" mt={6}>{t('Runs the handler again with every side effect answered from the record. Nothing leaves.')}</Text>
            {replay && <Code block mt="sm" style={{ maxHeight: 280, overflow: 'auto' }}>{replay}</Code>}
          </div>
          <Text size="xs" c="dimmed">{t('Task {id}', { id: task.id })}</Text>
        </Stack>
      )}
    </Drawer>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" px="sm" py={8}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" fw={600} lineClamp={2}>{value}</Text>
    </Paper>
  );
}
