/**
 * The vision and plan page (F18.10, with F18.11's channel rings).
 *
 * The owner's vision is the company charter, which every run reads first,
 * and the plan that serves it was spread over four pages: the goals and the
 * scorecard on Team, the issues on Work's board, the meeting under Work. This
 * puts them on one page, read from the rows by the server (`planOf`), so the
 * owner sees what the company is for beside what it is doing about it this
 * year and this quarter. Nothing is edited here: each part links to where it
 * is changed, so there is one place for each.
 *
 * The names are plain ones (STATUS 2.189): this year's goals, quarterly
 * priorities, the weekly scorecard, long-term issues, channels, core
 * processes, the weekly operating meeting.
 */
import type { ReactNode } from 'react';
import { Anchor, Badge, Button, Group, Paper, Progress, SimpleGrid, Stack, Text, Tooltip } from '@mantine/core';
import { IconArrowRight, IconStar } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { PageProps } from '../App.tsx';
import type { Plan as PlanView, PlanChannel, PlanSeat, Structure, WeekState } from '../types.ts';
import { dateTime, relative, roleLabel } from '../format.ts';
import { N, locale, t } from '../i18n.ts';
import { ISSUES_ITEM } from '../router.ts';
import { channelName } from '../channels.ts';
import { COMMITMENT, goalStatus, periodSaid } from '../goals.ts';
import { LoadFailed, Loading, PageHeader, Section, StatusBadge } from '../components/ui.tsx';
import { Prose } from '../components/Prose.tsx';
import { metricValue } from '../components/Metrics.tsx';
import { CoreProcessesPanel } from '../components/CoreProcesses.tsx';

const WEEK: Record<WeekState, { label: string; color: string }> = {
  on_track: { label: N('On track'), color: 'teal' },
  off_track: { label: N('Off track'), color: 'red' },
  claimed: { label: N('Claimed'), color: 'orange' },
  not_reported: { label: N('Not reported'), color: 'gray' },
};

const percent = (share: number) => share.toLocaleString(locale(), { style: 'percent', maximumFractionDigits: 0 });

/** A link to where a part of the plan is changed. */
function OpenLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <Button size="compact-sm" variant="subtle" rightSection={<IconArrowRight size={14} />} onClick={onClick}>{children}</Button>;
}

function Seat({ seat }: { seat: PlanSeat | null }) {
  return seat ? <Badge variant="light" color="blue" size="sm">{t('Owned by {seat}', { seat: roleLabel(seat) })}</Badge> : null;
}

export function Plan({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [plan, structure]: [PlanView, Structure] = await Promise.all([
      api('GET', `/api/companies/${companyId}/plan`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { plan, structure };
  }, [companyId]);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Vision and plan')}
      description={t('The vision you wrote in the charter, beside the plan that serves it: this year\'s goals, this quarter\'s priorities, the numbers, the channels and the issues kept for later.')}
    />
  );
  if (view.error && !view.data) return <Stack gap="lg">{header}<LoadFailed message={view.error} retry={view.reload} /></Stack>;
  if (!view.data) return <Stack gap="lg">{header}<Loading rows={4} /></Stack>;
  const { plan, structure } = view.data;
  const team = (item: string) => ctx.open('team', { item });

  return (
    <Stack gap="lg">
      {header}

      <Section
        title={t('Vision')}
        description={plan.vision.charterVersion === null ? undefined
          : t('From the company charter, version {version}. Every run reads it first.', { version: plan.vision.charterVersion })}
        actions={<OpenLink onClick={() => team('charter')}>{t('Edit the vision')}</OpenLink>}
      >
        {plan.vision.charterVersion === null ? (
          <Text size="sm" c="dimmed">{t('No charter yet. Write the vision in the company charter, where every run reads it first: Start from the vision outline gives you the headings.')}</Text>
        ) : plan.vision.whole !== null ? (
          <Stack gap="sm">
            <Text size="sm" c="dimmed">{t('The charter has none of the vision outline\'s headings, so all of it is shown. Start from the vision outline in the charter to mark which part is the vision.')}</Text>
            <Prose text={plan.vision.whole} />
          </Stack>
        ) : (
          <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
            {plan.vision.sections.map((section, index) => (
              <Paper key={`${section.part}:${index}`} withBorder radius="md" p="md">
                <Text fw={700} size="sm" mb={6}>{section.heading}</Text>
                {section.text ? <Prose text={section.text} /> : <Text size="sm" c="dimmed">{t('Not written yet.')}</Text>}
              </Paper>
            ))}
          </SimpleGrid>
        )}
      </Section>

      <Section title={t('This year\'s goals')} actions={<OpenLink onClick={() => team('goals')}>{t('Open the goals')}</OpenLink>}>
        {plan.yearGoals.length === 0 ? (
          <Text size="sm" c="dimmed">{t('No goal for this year yet: an objective whose period is about a year, with today in it.')}</Text>
        ) : (
          <Stack gap="sm">
            {plan.yearGoals.map((goal) => (
              <Paper key={goal.id} withBorder radius="md" p="sm">
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Text size="sm" fw={600}>{goal.statement}</Text>
                  <Badge color={goal.status === 'active' ? 'brand' : goal.status === 'met' ? 'teal' : 'gray'} variant="light">{goalStatus(goal.status)}</Badge>
                </Group>
                <Group gap={6} mt={6}>
                  <Badge variant="outline" color="gray" size="sm">{periodSaid(goal.startsOn, goal.dueOn)}</Badge>
                  {goal.commitment && <Badge variant="light" color="grape" size="sm">{t(COMMITMENT[goal.commitment] ?? goal.commitment)}</Badge>}
                  <Seat seat={goal.seat} />
                  <Badge variant="light" color="gray" size="sm">{t('Priorities this quarter: {count}', { count: goal.priorities })}</Badge>
                </Group>
                {goal.doneWhen && <Text size="xs" c="dimmed" mt={4}>{t('Done when: {done}', { done: goal.doneWhen })}</Text>}
              </Paper>
            ))}
          </Stack>
        )}
      </Section>

      <Section title={t('Quarterly priorities')} description={t('On pace when its measures have come as far as the quarter has gone, or, with no measure, when work under it finished this week: the rule the weekly operating meeting uses.')}>
        {plan.priorities.items.length === 0 ? (
          <Text size="sm" c="dimmed">{t('No quarterly priority yet: a key result whose period is a quarter, with today in it.')}</Text>
        ) : (
          <Stack gap="sm">
            {plan.priorities.items.map((priority) => (
              <Paper key={priority.goalId} withBorder radius="md" p="sm">
                <Group justify="space-between" wrap="nowrap" gap="sm">
                  <Text size="sm" fw={600}>{priority.statement}</Text>
                  <Badge color={priority.pace === 'on_pace' ? 'teal' : 'red'} variant="light">
                    {priority.pace === 'on_pace' ? t('On pace') : t('Off pace')}
                  </Badge>
                </Group>
                <Group gap={6} mt={6}>
                  <Badge variant="outline" color="gray" size="sm">{periodSaid(priority.startsOn, priority.dueOn)}</Badge>
                  {priority.commitment && <Badge variant="light" color="grape" size="sm">{t(COMMITMENT[priority.commitment] ?? priority.commitment)}</Badge>}
                  <Seat seat={priority.seatRole} />
                  {priority.channel && <Badge variant="light" color="orange" size="sm">{t('Tests the channel {channel}', { channel: channelName(priority.channel) })}</Badge>}
                </Group>
                <Text size="xs" c={priority.pace === 'on_pace' ? 'dimmed' : 'red'} mt={4}>{paceSaid(priority)}</Text>
                {priority.progress !== null && (
                  <Tooltip label={t('{progress} of the way there, with {elapsed} of the quarter gone.', { progress: percent(priority.progress), elapsed: percent(priority.elapsed) })}>
                    <Progress value={priority.progress * 100} size="sm" mt={6} radius="xl" color={priority.pace === 'on_pace' ? 'teal' : 'red'} />
                  </Tooltip>
                )}
              </Paper>
            ))}
            {plan.priorities.leftOut > 0 && <Text size="xs" c="dimmed">{t('More not shown: {count}', { count: plan.priorities.leftOut })}</Text>}
          </Stack>
        )}
      </Section>

      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Section title={t('Weekly scorecard')} description={t('Each line as it stood last week, the week the weekly operating meeting judges it by.')}
          actions={<OpenLink onClick={() => team('scorecard')}>{t('Open the scorecard')}</OpenLink>}>
          <Stack gap="sm">
            {plan.headline && (
              <Paper withBorder radius="md" p="sm">
                <Group gap={6} wrap="nowrap">
                  <IconStar size={14} color="var(--mantine-color-yellow-6)" />
                  <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{t('Headline')}</Text>
                  {!plan.headline.chosen && <Badge size="xs" variant="light" color="gray">{t('Inferred from the goals')}</Badge>}
                  {plan.headline.chosen && !plan.headline.pair && <Badge size="xs" variant="light" color="orange">{t('Not paired')}</Badge>}
                </Group>
                <Text size="sm" fw={600} mt={4}>{plan.headline.name}</Text>
                <Text size="sm" className="tabular">
                  {plan.headline.value === null ? t('No value yet') : metricValue(plan.headline, plan.headline.value)}
                  <Text span c="dimmed" size="xs"> / {metricValue(plan.headline, plan.headline.target)}</Text>
                </Text>
              </Paper>
            )}
            {plan.scorecard.lines.length === 0 ? (
              <Text size="sm" c="dimmed">{t('No line on the weekly scorecard yet.')}</Text>
            ) : (
              <>
                <Group gap={6}>
                  {(Object.keys(WEEK) as WeekState[]).filter((state) => plan.scorecard.lastWeek[state] > 0).map((state) => (
                    <Badge key={state} color={WEEK[state].color} variant="light">{t(WEEK[state].label)}: {plan.scorecard.lastWeek[state]}</Badge>
                  ))}
                </Group>
                {plan.scorecard.lines.map((line) => (
                  <Group key={line.metricId} justify="space-between" wrap="nowrap" gap="xs">
                    <div style={{ minWidth: 0 }}>
                      <Text size="sm" truncate>{line.name}</Text>
                      {line.seat && <Text size="xs" c="dimmed" truncate>{roleLabel(line.seat)}</Text>}
                    </div>
                    <Group gap={6} wrap="nowrap">
                      {line.lastValue !== null && <Text size="xs" c="dimmed" className="tabular">{metricValue(line, line.lastValue)} / {metricValue(line, line.target)}</Text>}
                      <Badge size="sm" color={WEEK[line.lastWeek].color} variant="light">{t(WEEK[line.lastWeek].label)}</Badge>
                    </Group>
                  </Group>
                ))}
              </>
            )}
          </Stack>
        </Section>

        <Section title={t('Long-term issues')}
          actions={<OpenLink onClick={() => ctx.open('work', { item: ISSUES_ITEM })}>{t('Open the issues list')}</OpenLink>}>
          {plan.longTermIssues.items.length === 0 ? (
            <Text size="sm" c="dimmed">{t('No long-term issue. One filed for the long-term list waits here for quarterly planning.')}</Text>
          ) : (
            <Stack gap="xs">
              {plan.longTermIssues.items.map((issue) => (
                <Group key={issue.id} justify="space-between" wrap="nowrap" gap="xs">
                  <Text size="sm" style={{ minWidth: 0 }} truncate>{issue.title}</Text>
                  <Badge size="sm" variant="outline" color="gray">P{issue.priority}</Badge>
                </Group>
              ))}
              {plan.longTermIssues.leftOut > 0 && <Text size="xs" c="dimmed">{t('More not shown: {count}', { count: plan.longTermIssues.leftOut })}</Text>}
            </Stack>
          )}
        </Section>
      </SimpleGrid>

      <Section title={t('Channels by ring')}
        description={t('Where the company looks for customers: a channel is probable while a learning priority tests it, and working once a committed priority does. Neither is stored; both are read from the goals.')}>
        {plan.channels.working.length === 0 && plan.channels.probable.length === 0 && !plan.channels.possible ? (
          <Text size="sm" c="dimmed">{t('No channel is being tested yet. A learning priority that names a channel puts it here.')}</Text>
        ) : (
          <SimpleGrid cols={{ base: 1, md: plan.channels.possible ? 3 : 2 }} spacing="md">
            <Ring title={t('Working: the core channel')} rings={plan.channels.working} color="teal" />
            <Ring title={t('Probable: being tested')} rings={plan.channels.probable} color="orange" />
            {plan.channels.possible && (
              <Paper withBorder radius="md" p="sm">
                <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={6}>{t('Possible: every channel considered')}</Text>
                <Text size="sm" fw={600}>{plan.channels.possible.title}</Text>
                <Text size="xs" c="dimmed">{t('Written by {role}, {when}', { role: roleLabel(plan.channels.possible.role), when: relative(plan.channels.possible.at) })}</Text>
                {plan.channels.possible.excerpt && <Text size="sm" mt={4} lineClamp={4}>{plan.channels.possible.excerpt}</Text>}
                <Anchor size="sm" mt={6} display="block" onClick={() => ctx.open('work', { item: plan.channels.possible!.taskId })}>{t('Open the task')}</Anchor>
              </Paper>
            )}
          </SimpleGrid>
        )}
      </Section>

      <Section title={t('Core processes')}>
        {plan.coreProcesses.processes.length === 0
          ? <Text size="sm" c="dimmed">{t('No core process yet. A switched-on skill is made one on the Skills page.')}</Text>
          : <CoreProcessesPanel report={plan.coreProcesses} roles={structure.roles} openRole={() => ctx.open('team')} />}
      </Section>

      <Section title={plan.lastMeeting ? t('Last weekly operating meeting: {week}', { week: plan.lastMeeting.week }) : t('Weekly operating meeting')}
        actions={plan.lastMeeting && <OpenLink onClick={() => ctx.open('work', { item: plan.lastMeeting!.taskId })}>{t('Open the task')}</OpenLink>}>
        {!plan.lastMeeting ? (
          <Text size="sm" c="dimmed">{t('No weekly operating meeting yet.')}</Text>
        ) : (
          <Stack gap="sm">
            <Group gap="xs">
              <StatusBadge status={plan.lastMeeting.status} />
              {plan.lastMeeting.finishedAt && <Text size="xs" c="dimmed">{dateTime(plan.lastMeeting.finishedAt)}</Text>}
            </Group>
            {plan.lastMeeting.summary && <Prose text={plan.lastMeeting.summary} />}
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

/** Why a priority is on or off pace, in a line. */
function paceSaid(priority: PlanView['priorities']['items'][number]): string {
  if (priority.why === 'no_reading') return t('No verified reading of its measure yet.');
  if (priority.why === 'no_recent_work') return t('No work under it finished in the last seven days.');
  if (priority.progress !== null) {
    return t('{progress} of the way there, with {elapsed} of the quarter gone.', { progress: percent(priority.progress), elapsed: percent(priority.elapsed) });
  }
  return t('Work under it finished in the last seven days.');
}

/** One ring of channels, each with the priorities that put it there. */
function Ring({ title, rings, color }: { title: string; rings: PlanChannel[]; color: string }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700} mb={6}>{title}</Text>
      {rings.length === 0 ? <Text size="sm" c="dimmed">{t('None yet')}</Text> : (
        <Stack gap="xs">
          {rings.map((ring) => (
            <div key={ring.channel}>
              <Badge color={color} variant="light">{channelName(ring.channel)}</Badge>
              {ring.goals.map((goal) => (
                <Text key={goal.id} size="xs" c="dimmed" mt={2}>
                  {goal.statement}{goal.commitment ? ` · ${t(COMMITMENT[goal.commitment] ?? goal.commitment)}` : ''}
                </Text>
              ))}
            </div>
          ))}
        </Stack>
      )}
    </Paper>
  );
}
