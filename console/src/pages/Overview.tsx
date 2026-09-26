/**
 * One company at a glance, read top to bottom in the order an owner asks:
 * is anything waiting on me, is work moving, are the goals getting closer,
 * what is it costing, and what happened lately.
 *
 * The pipeline is the centre of it. A company's work is a flow -- queued,
 * running, waiting on someone, done -- and a count per stage says where it is
 * stuck better than any list: a pile in "needs you" is the owner's to clear,
 * a pile in "queued" is capacity, a pile in "in review" is the reviewer.
 */
import {
  Anchor, Badge, Grid, Group, Paper, Progress, RingProgress, SimpleGrid, Stack, Table, Text,
  Timeline, UnstyledButton,
} from '@mantine/core';
import { AreaChart } from '@mantine/charts';
import { IconArrowRight, IconTarget } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type {
  ActivityItem, CostPeriod, InboxItem, Retro, Spend, Structure, WorkGroup, WorkItem,
} from '../types.ts';
import { day, eventSentence, goalKind, money, relative } from '../format.ts';
import { N, t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import { KpiStrip, LoadFailed, Loading, PageHeader, Section, StatusBadge } from '../components/ui.tsx';
import { TaskProgress } from './Work.tsx';

const STAGES: Array<{ id: string; label: string; statuses: string[]; color: string; page: 'work' | 'inbox' }> = [
  { id: 'queued', label: N('Queued'), statuses: ['pending'], color: 'var(--mantine-color-gray-5)', page: 'work' },
  { id: 'running', label: N('Running'), statuses: ['checked_out', 'running'], color: 'var(--mantine-color-brand-6)', page: 'work' },
  { id: 'you', label: N('Needs you'), statuses: ['waiting_approval'], color: 'var(--mantine-color-orange-6)', page: 'inbox' },
  { id: 'review', label: N('In review'), statuses: ['waiting_review'], color: 'var(--mantine-color-grape-6)', page: 'work' },
  { id: 'window', label: N('Scheduled'), statuses: ['waiting_window'], color: 'var(--mantine-color-cyan-6)', page: 'work' },
];

export function Overview({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [work, activity, spend, cost, inbox, retro, structure]: [
      { items: WorkItem[]; counts: Record<WorkGroup, number> }, { items: ActivityItem[] }, Spend,
      { timeline: CostPeriod[] }, { items: InboxItem[] }, Retro, Structure,
    ] = await Promise.all([
      api('GET', `/api/companies/${companyId}/work?limit=100`),
      api('GET', `/api/companies/${companyId}/activity?limit=12`),
      api('GET', `/api/companies/${companyId}/spend`),
      api('GET', `/api/companies/${companyId}/cost`),
      api('GET', `/api/companies/${companyId}/inbox`),
      api('GET', `/api/companies/${companyId}/retro`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { work, activity, spend, cost, inbox, retro, structure };
  }, [companyId], { every: 15_000 });

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Overview')}
      description={t('Whether anything is waiting on you, whether work is moving, and what it costs.')}
      live={view.updatedAt}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={5} /></>;
  const { work, activity, spend, cost, inbox, retro, structure } = view.data;

  const used = spend.limitCents > 0 ? Math.min(100, (spend.spentCents / spend.limitCents) * 100) : 0;
  const tone = used >= 100 ? 'red' : used >= 80 ? 'orange' : 'brand';
  const chart = cost.timeline.map((row) => ({ day: day(row.period), cost: row.costCents / 100 }));
  const inFlight = work.items.filter((item) => ['checked_out', 'running', 'pending'].includes(item.status));
  const objectives = structure.goals.filter((goal) => goal.kind === 'objective' && goal.status === 'active');

  return (
    <Stack gap="lg">
      {header}

      <KpiStrip items={[
        { label: t('Needs you'), value: inbox.items.length, alert: inbox.items.length > 0, hint: t('Open the inbox'), onClick: () => ctx.open('inbox') },
        { label: t('Running'), value: work.counts.active, hint: t('Queued or in progress'), onClick: () => ctx.open('work') },
        { label: t('Done this week'), value: retro.tasksCompleted, hint: t('Week ending {day}', { day: day(retro.weekEnding) }) },
        { label: t('Spent this period'), value: money(spend.spentCents), hint: t('of {limit}', { limit: money(spend.limitCents) }), alert: used >= 100, onClick: () => ctx.open('money') },
      ]} />

      <Section title={t('Where the work is')} description={t('Tasks by stage, right now. A pile in one stage is where things are stuck.')}>
        <SimpleGrid cols={{ base: 2, sm: 3, md: 5 }} spacing="sm">
          {STAGES.map((stage) => {
            const n = work.items.filter((item) => stage.statuses.includes(item.status)).length;
            return (
              <UnstyledButton key={stage.id} className="pipeline-stage" style={{ ['--stage-color' as string]: stage.color }} onClick={() => ctx.open(stage.page)}>
                <Text size="xs" c="dimmed" fw={600}>{t(stage.label)}</Text>
                <Text fz={26} fw={750} className="tabular">{n}</Text>
              </UnstyledButton>
            );
          })}
        </SimpleGrid>
        <Group gap="lg" mt="md">
          <Text size="sm" c="dimmed">{t('Done: {count}', { count: work.counts.done })}</Text>
          <Text size="sm" c={work.counts.stopped > 0 ? 'red' : 'dimmed'}>{t('Stopped: {count}', { count: work.counts.stopped })}</Text>
        </Group>
      </Section>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Section
            title={t('Running now')}
            actions={<Anchor size="sm" onClick={() => ctx.open('work')}>{t('All work')}</Anchor>}
            padding={0}
          >
            {inFlight.length === 0 ? (
              <Text size="sm" c="dimmed" p="lg">{t('Nothing is running right now.')}</Text>
            ) : (
              <Table verticalSpacing="sm" horizontalSpacing="lg" highlightOnHover>
                <Table.Tbody>
                  {inFlight.slice(0, 6).map((item) => (
                    <Table.Tr key={item.id} className="clickable-row" onClick={() => ctx.open('work', { item: item.id })}>
                      <Table.Td>
                        <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                        <Group gap={6}>
                          <StatusBadge status={item.status} />
                          <Text size="xs" c="dimmed">{item.roleSlug} · {relative(item.startedAt ?? item.createdAt)}</Text>
                        </Group>
                      </Table.Td>
                      <Table.Td w={200}><TaskProgress item={item} /></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Section
            title={t('Goals')}
            description={t('Tasks finished under each objective.')}
            actions={<Anchor size="sm" onClick={() => ctx.open('team')}>{t('Goal ladder')}</Anchor>}
          >
            {objectives.length === 0 ? (
              <Text size="sm" c="dimmed">{t('No objective has been set yet.')}</Text>
            ) : (
              <Stack gap="md">
                {objectives.slice(0, 5).map((goal) => {
                  const percent = goal.tasksTotal > 0 ? (goal.tasksDone / goal.tasksTotal) * 100 : 0;
                  return (
                    <div key={goal.id}>
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                          <IconTarget size={14} style={{ flexShrink: 0 }} />
                          <Text size="sm" fw={600} truncate>{goal.statement}</Text>
                        </Group>
                        <Text size="xs" c="dimmed" className="tabular" style={{ whiteSpace: 'nowrap' }}>
                          {goal.tasksDone}/{goal.tasksTotal}
                        </Text>
                      </Group>
                      <Progress value={percent} size="sm" mt={6} radius="xl" color={percent >= 100 ? 'teal' : 'brand'} />
                      <Text size="xs" c="dimmed" mt={2}>{goalKind(goal.kind)}</Text>
                    </div>
                  );
                })}
              </Stack>
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Section title={t('This period')}>
            <Group justify="center">
              <RingProgress
                size={170}
                thickness={14}
                roundCaps
                sections={[{ value: used, color: tone }]}
                label={(
                  <Stack gap={0} align="center">
                    <Text fw={800} fz={22} className="tabular">{money(spend.spentCents)}</Text>
                    <Text size="xs" c="dimmed">{t('of {limit}', { limit: money(spend.limitCents) })}</Text>
                  </Stack>
                )}
              />
            </Group>
            <Stack gap={6} mt="md">
              <Group justify="space-between"><Text size="sm" c="dimmed">{t('Left to spend')}</Text><Text size="sm" fw={600} className="tabular">{money(Math.max(0, spend.limitCents - spend.spentCents))}</Text></Group>
              <Group justify="space-between"><Text size="sm" c="dimmed">{t('Period')}</Text><Text size="sm">{day(spend.periodStart)} – {day(spend.periodEnd)}</Text></Group>
              <Group justify="space-between"><Text size="sm" c="dimmed">{t('Spending')}</Text>{spend.pausedAt ? <Badge color="red">{t('Paused')}</Badge> : <Badge color="teal" variant="light">{t('Allowed')}</Badge>}</Group>
            </Stack>
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Section title={t('Cost per day')} description={t("Last thirty days, everything this company's agents spent.")}>
            {chart.length === 0 ? (
              <Text size="sm" c="dimmed">{t('Nothing spent yet.')}</Text>
            ) : (
              <AreaChart
                h={220}
                data={chart}
                dataKey="day"
                series={[{ name: 'cost', label: t('Cost'), color: 'brand.6' }]}
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
          <Section title={t('This week')} description={t('Week ending {day}', { day: day(retro.weekEnding) })}>
            <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
              <Mini label={t('Completed')} value={String(retro.tasksCompleted)} />
              <Mini label={t('Stopped')} value={String(retro.tasksStopped)} />
              <Mini label={t('Spent')} value={money(retro.moneySpentCents)} />
              <Mini label={t('Review decisions')} value={String(retro.decisionsRecorded)} />
            </SimpleGrid>
            {retro.costliestDivisions.length > 0 && (
              <Stack gap="xs" mt="lg">
                <Text size="sm" fw={600}>{t('Where the money went')}</Text>
                {retro.costliestDivisions.map((row) => {
                  const top = retro.costliestDivisions[0]?.costCents || 1;
                  return (
                    <div key={row.label}>
                      <Group justify="space-between"><Text size="sm">{row.label}</Text><Text size="sm" c="dimmed" className="tabular">{money(row.costCents)}</Text></Group>
                      <Progress value={(row.costCents / top) * 100} size="sm" mt={4} radius="xl" />
                    </div>
                  );
                })}
              </Stack>
            )}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Section title={t('Lately')} actions={<Anchor size="sm" onClick={() => ctx.open('history')}><Group gap={4}>{t('History')}<IconArrowRight size={14} /></Group></Anchor>}>
            {activity.items.length === 0 ? (
              <Text size="sm" c="dimmed">{t('Nothing has happened yet.')}</Text>
            ) : (
              <Timeline bulletSize={12} lineWidth={2} active={activity.items.length}>
                {activity.items.map((event) => (
                  <Timeline.Item
                    key={event.id}
                    color={/refused|denied|failed|incident|halt/.test(event.type) ? 'red' : event.actor === 'owner' ? 'teal' : 'brand'}
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
    </Stack>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fw={700} fz="lg" mt={4} className="tabular">{value}</Text>
    </Paper>
  );
}
