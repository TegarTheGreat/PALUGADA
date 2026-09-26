/**
 * The company at a glance: what needs the owner, what is running, what it is
 * costing, and what happened lately -- the screen an owner opens between
 * decisions to see whether anything is wrong.
 */
import { useState } from 'react';
import {
  Anchor, Badge, Button, Grid, Group, List, Paper, Progress, RingProgress, SimpleGrid, Stack, Table,
  Text, ThemeIcon, Timeline, Title,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import {
  IconActivity, IconAlertTriangle, IconCheck, IconChecklist, IconCircleDashed, IconClockPause, IconCoin,
  IconGavel, IconInbox,
} from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type {
  ActivityItem, CostPeriod, InboxItem, Retro, Spend, WorkGroup, WorkItem,
} from '../types.ts';
import { day, eventSentence, money, relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { LoadFailed, Loading, Section, StatCard, StatusBadge } from '../components/ui.tsx';

export function Overview({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [setup, work, activity, spend, cost, inbox, retro]: [
      { notes: string[]; todo: string[] }, { items: WorkItem[]; counts: Record<WorkGroup, number> },
      { items: ActivityItem[] }, Spend, { timeline: CostPeriod[] }, { items: InboxItem[] }, Retro,
    ] = await Promise.all([
      api('GET', '/api/control/setup'),
      api('GET', `/api/companies/${companyId}/work?limit=8`),
      api('GET', `/api/companies/${companyId}/activity?limit=12`),
      api('GET', `/api/companies/${companyId}/spend`),
      api('GET', `/api/companies/${companyId}/cost`),
      api('GET', `/api/companies/${companyId}/inbox`),
      api('GET', `/api/companies/${companyId}/retro`),
    ]);
    return { setup, work, activity, spend, cost, inbox, retro };
  }, [companyId]);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={5} />;
  const { setup, work, activity, spend, cost, inbox, retro } = view.data;

  const used = spend.limitCents > 0 ? Math.min(100, (spend.spentCents / spend.limitCents) * 100) : 0;
  const tone = used >= 100 ? 'red' : used >= 80 ? 'orange' : 'blue';
  const chart = cost.timeline.map((row) => ({ day: day(row.period), cost: row.costCents / 100 }));
  const inFlight = work.items.filter((item) => !['completed', 'failed', 'halted', 'cancelled'].includes(item.status));

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>Overview</Title>
      </div>

      {setup.todo.length > 0 && <SetupChecklist todo={setup.todo} />}

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard label="Needs you" value={inbox.items.length} icon={<IconInbox size={20} />} color="red"
          hint={<Anchor size="xs" onClick={() => ctx.go('decisions')}>Open the queue</Anchor>} />
        <StatCard label="Running" value={work.counts.active} icon={<IconActivity size={20} />} color="blue" hint="Picked up or in progress" />
        <StatCard label="Waiting" value={work.counts.waiting} icon={<IconClockPause size={20} />} color="orange" hint="On you, a reviewer or a window" />
        <StatCard label="Stopped" value={work.counts.stopped} alert={work.counts.stopped > 0} icon={<IconAlertTriangle size={20} />} color="gray" hint="Failed, halted or cancelled" />
      </SimpleGrid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Section title="This period">
            <Group justify="center">
              <RingProgress
                size={170}
                thickness={14}
                roundCaps
                sections={[{ value: used, color: tone }]}
                label={(
                  <Stack gap={0} align="center">
                    <Text fw={800} fz={22}>{money(spend.spentCents)}</Text>
                    <Text size="xs" c="dimmed">of {money(spend.limitCents)}</Text>
                  </Stack>
                )}
              />
            </Group>
            <Stack gap={6} mt="md">
              <Group justify="space-between"><Text size="sm" c="dimmed">Left to spend</Text><Text size="sm" fw={600}>{money(Math.max(0, spend.limitCents - spend.spentCents))}</Text></Group>
              <Group justify="space-between"><Text size="sm" c="dimmed">Period</Text><Text size="sm">{day(spend.periodStart)} – {day(spend.periodEnd)}</Text></Group>
              <Group justify="space-between"><Text size="sm" c="dimmed">Paused</Text>{spend.pausedAt ? <Badge color="red">Paused</Badge> : <Text size="sm">No</Text>}</Group>
            </Stack>
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Section title="Cost per day" description="Last thirty days, everything this company's agents spent.">
            {chart.length === 0 ? (
              <Text size="sm" c="dimmed">Nothing spent yet.</Text>
            ) : (
              <AreaChart
                h={240}
                data={chart}
                dataKey="day"
                series={[{ name: 'cost', label: 'Cost', color: 'blue.6' }]}
                curveType="monotone"
                withGradient
                gridAxis="y"
                valueFormatter={(value) => value.toFixed(2)}
              />
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Section
            title="Work in progress"
            actions={<Anchor size="sm" onClick={() => ctx.go('work')}>All work</Anchor>}
            padding={0}
          >
            {inFlight.length === 0 ? (
              <Text size="sm" c="dimmed" p="lg">Nothing is running right now.</Text>
            ) : (
              <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
                <Table.Tbody>
                  {inFlight.slice(0, 6).map((item) => (
                    <Table.Tr key={item.id}>
                      <Table.Td>
                        <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                        <Text size="xs" c="dimmed">{item.roleSlug} · {item.divisionName}</Text>
                      </Table.Td>
                      <Table.Td w={150}><StatusBadge status={item.status} /></Table.Td>
                      <Table.Td w={90}><Text size="xs" c="dimmed">{relative(item.createdAt)}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Section title="Lately">
            {activity.items.length === 0 ? (
              <Text size="sm" c="dimmed">Nothing has happened yet.</Text>
            ) : (
              <Timeline bulletSize={12} lineWidth={2} active={activity.items.length}>
                {activity.items.map((event) => (
                  <Timeline.Item
                    key={event.id}
                    color={/refused|denied|failed|incident|halt/.test(event.type) ? 'red' : event.actor === 'owner' ? 'teal' : 'blue'}
                    title={<Text size="sm" fw={600}>{eventSentence(event.type)}</Text>}
                  >
                    <Text size="xs" c="dimmed">{event.actor} · {relative(event.occurredAt)}</Text>
                  </Timeline.Item>
                ))}
              </Timeline>
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Section title="This week" description={`Week ending ${day(retro.weekEnding)}`}>
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
          <Mini label="Completed" value={String(retro.tasksCompleted)} icon={<IconCheck size={12} />} color="teal" />
          <Mini label="Stopped" value={String(retro.tasksStopped)} icon={<IconAlertTriangle size={12} />} color="orange" />
          <Mini label="Spent" value={money(retro.moneySpentCents)} icon={<IconCoin size={12} />} color="blue" />
          <Mini label="Review decisions" value={String(retro.decisionsRecorded)} icon={<IconGavel size={12} />} color="grape" />
        </SimpleGrid>
        {retro.costliestDivisions.length > 0 && (
          <Stack gap="xs" mt="lg">
            <Text size="sm" fw={600}>Where the money went</Text>
            {retro.costliestDivisions.map((row) => {
              const top = retro.costliestDivisions[0]?.costCents || 1;
              return (
                <div key={row.label}>
                  <Group justify="space-between"><Text size="sm">{row.label}</Text><Text size="sm" c="dimmed">{money(row.costCents)}</Text></Group>
                  <Progress value={(row.costCents / top) * 100} size="sm" mt={4} />
                </div>
              );
            })}
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

/**
 * What the deployment is missing, as a checklist rather than a log: each line
 * is something switched off until the operator sets it, said at boot and
 * otherwise only in a service log nobody running the company will read.
 */
function SetupChecklist({ todo }: { todo: string[] }) {
  const [open, setOpen] = useState(false);
  const shown = open ? todo : todo.slice(0, 3);
  return (
    <Paper withBorder radius="md" p="md" shadow="xs">
      <Group justify="space-between" mb="sm" wrap="nowrap">
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon variant="light" color="yellow" radius="md" size="lg"><IconChecklist size={20} /></ThemeIcon>
          <div>
            <Text fw={700}>Finish setting up</Text>
            <Text size="xs" c="dimmed">{todo.length} thing{todo.length === 1 ? '' : 's'} this deployment has switched off until they are configured</Text>
          </div>
        </Group>
        {todo.length > 3 && <Button variant="subtle" size="xs" onClick={() => setOpen(!open)}>{open ? 'Show fewer' : `Show all ${todo.length}`}</Button>}
      </Group>
      <List size="sm" spacing={6} icon={<ThemeIcon size={18} radius="xl" color="yellow" variant="light"><IconCircleDashed size={12} /></ThemeIcon>}>
        {shown.map((line) => <List.Item key={line}><Text size="sm" lineClamp={2}>{line}</Text></List.Item>)}
      </List>
    </Paper>
  );
}

function Mini({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Group gap="xs" wrap="nowrap">
        <ThemeIcon variant="light" size="sm" radius="xl" color={color}>{icon}</ThemeIcon>
        <Text size="xs" c="dimmed">{label}</Text>
      </Group>
      <Text fw={700} fz="lg" mt={4}>{value}</Text>
    </Paper>
  );
}
