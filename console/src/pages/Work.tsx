/**
 * The work: what is running, what is waiting and on whom, what finished and
 * what stopped -- and, for any one task, what it did, step by step.
 */
import { useState } from 'react';
import {
  Badge, Button, Code, Drawer, Group, Modal, Paper, SegmentedControl, SimpleGrid, Stack, Table,
  Text, Timeline, Title,
} from '@mantine/core';
import { IconPlayerPlay, IconPlus, IconRefresh } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Structure, WorkGroup, WorkItem } from '../types.ts';
import { dateTime, eventSentence, humanize, money, relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, LoadFailed, Loading, StatusBadge } from '../components/ui.tsx';
import { AssignWork } from '../components/AssignWork.tsx';

type Filter = WorkGroup | 'all';

export function Work({ ctx }: PageProps) {
  const { companyId } = ctx;
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<WorkItem | null>(null);
  const [assigning, setAssigning] = useState(false);
  const work = useLoad(async () => {
    const answer: { items: WorkItem[]; counts: Record<WorkGroup, number> } = filter === 'all'
      ? await api('GET', `/api/companies/${companyId}/work?limit=100`)
      : await api('GET', `/api/companies/${companyId}/work?group=${filter}&limit=100`);
    return answer;
  }, [companyId, filter]);
  const structure = useLoad(async () => {
    const answer: Structure = await api('GET', `/api/companies/${companyId}/structure`);
    return answer;
  }, [companyId]);

  const counts = work.data?.counts;
  const label = (group: WorkGroup, text: string) => (counts ? `${text} · ${counts[group]}` : text);

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
          <Title order={2}>Work</Title>
        </div>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={work.reload}>Refresh</Button>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setAssigning(true)} disabled={!structure.data}>Give work</Button>
        </Group>
      </Group>

      <SegmentedControl
        value={filter}
        onChange={(value) => setFilter(value as Filter)}
        data={[
          { value: 'all', label: 'All' },
          { value: 'active', label: label('active', 'Running') },
          { value: 'waiting', label: label('waiting', 'Waiting') },
          { value: 'done', label: label('done', 'Done') },
          { value: 'stopped', label: label('stopped', 'Stopped') },
        ]}
        style={{ alignSelf: 'flex-start', maxWidth: '100%', overflowX: 'auto' }}
      />

      {work.error ? <LoadFailed message={work.error} retry={work.reload} /> : !work.data ? <Loading /> : (
        <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
          {work.data.items.length === 0 ? (
            <EmptyState title="Nothing here" description="No task is in this state right now." />
          ) : (
            <Table.ScrollContainer minWidth={760}>
              <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Task</Table.Th>
                    <Table.Th>Status</Table.Th>
                    <Table.Th>Serves</Table.Th>
                    <Table.Th ta="right">Cost</Table.Th>
                    <Table.Th>Started</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {work.data.items.map((item) => (
                    <Table.Tr key={item.id} className="clickable-row" onClick={() => setOpen(item)}>
                      <Table.Td maw={360}>
                        <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                        <Group gap={6}>
                          <Text size="xs" c="dimmed">{item.roleSlug} · {item.divisionName}</Text>
                          {item.schedule && <Badge size="xs" variant="outline" color="gray">{item.schedule}</Badge>}
                          {item.parentTaskId && <Badge size="xs" variant="outline" color="gray">sub-task</Badge>}
                        </Group>
                      </Table.Td>
                      <Table.Td>
                        <StatusBadge status={item.status} />
                        {item.haltReason && <Text size="xs" c="red" mt={4}>{humanize(item.haltReason)}</Text>}
                      </Table.Td>
                      <Table.Td maw={260}><Text size="sm" c="dimmed" lineClamp={1}>{item.goal ?? '—'}</Text></Table.Td>
                      <Table.Td ta="right"><Text size="sm">{money(item.costCents)}</Text></Table.Td>
                      <Table.Td><Text size="sm" c="dimmed">{relative(item.startedAt ?? item.createdAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Paper>
      )}

      <TaskDrawer companyId={companyId} task={open} close={() => setOpen(null)} />

      <Modal opened={assigning} onClose={() => setAssigning(false)} title="Give a role something to do" size="lg" centered>
        {structure.data && (
          <AssignWork companyId={companyId} structure={structure.data} done={() => { setAssigning(false); work.reload(); }} />
        )}
      </Modal>
    </Stack>
  );
}

/** One task: what it is, and every event it left, with a dry replay (F11.2, F5.9). */
export function TaskDrawer({ companyId, task, close }: { companyId: string; task: WorkItem | null; close: () => void }) {
  const events = useLoad(async () => {
    if (!task) return [];
    const answer: { events: Array<{ type: string; actor: string; payload: Record<string, unknown>; occurredAt: string }> } =
      await api('GET', `/api/companies/${companyId}/tasks/${task.id}/events`);
    return answer.events;
  }, [companyId, task?.id]);
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
      setReplay((failure as Error).message);
    } finally {
      setReplaying(false);
    }
  };

  return (
    <Drawer opened={task !== null} onClose={() => { setReplay(null); close(); }} position="right" size="lg" title={<Text fw={700}>Task</Text>}>
      {task && (
        <Stack gap="lg">
          <div>
            <Group gap="xs" mb={6}><StatusBadge status={task.status} />{task.haltReason && <Badge color="red" variant="light">{humanize(task.haltReason)}</Badge>}</Group>
            <Text fw={700} size="lg">{task.summary}</Text>
            <Text size="sm" c="dimmed">{task.roleSlug} · {task.divisionName}</Text>
          </div>
          <SimpleGrid cols={2} spacing="sm">
            <Fact label="Serves" value={task.goal ?? '—'} />
            <Fact label="Cost so far" value={money(task.costCents)} />
            <Fact label="Attempt" value={`${task.attempt} of ${task.attemptMax}`} />
            <Fact label="Priority" value={`P${task.priority}`} />
            <Fact label="Created" value={dateTime(task.createdAt)} />
            <Fact label="Finished" value={dateTime(task.finishedAt)} />
          </SimpleGrid>
          <div>
            <Text fw={700} mb="sm">What it did</Text>
            {events.error ? <Text c="red" size="sm">{events.error}</Text> : !events.data ? <Loading rows={2} /> : events.data.length === 0 ? (
              <Text size="sm" c="dimmed">No events yet.</Text>
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
              Replay against the journal
            </Button>
            <Text size="xs" c="dimmed" mt={6}>Runs the handler again with every side effect answered from the record. Nothing leaves.</Text>
            {replay && <Code block mt="sm" style={{ maxHeight: 280, overflow: 'auto' }}>{replay}</Code>}
          </div>
          <Text size="xs" c="dimmed">Task {task.id}</Text>
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
