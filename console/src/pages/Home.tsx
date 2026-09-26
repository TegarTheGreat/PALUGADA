/**
 * Home: every company at once, and the three things an owner opening the
 * console wants to know before anything else -- does anything need me, is
 * everything moving, is anything going wrong.
 *
 * It answers in that order. A sentence first ("two decisions are waiting"),
 * then the decisions themselves across every company, then each company's
 * state in a card, then what is running right now. A portfolio of companies
 * is only manageable by one person if the first screen says where to look.
 */
import {
  Anchor, Avatar, Badge, Button, Grid, Group, Paper, Progress, SimpleGrid, Stack, Text, Title,
  UnstyledButton,
} from '@mantine/core';
import { IconArrowRight, IconChecklist, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { CompanyPage } from '../router.ts';
import type { Company, Digest, InboxItem, Spend, WorkGroup, WorkItem } from '../types.ts';
import { money, relative } from '../format.ts';
import { locale, t, tp } from '../i18n.ts';
import { EmptyState, KindBadge, LiveIndicator, Loading, LoadFailed, Section, StatusBadge, TierBadge } from '../components/ui.tsx';
import { TaskProgress } from './Work.tsx';

interface CompanyState {
  company: Company;
  inbox: InboxItem[];
  digest: Digest;
  running: WorkItem[];
  counts: Record<WorkGroup, number>;
  spend: Spend;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 11) return t('Good morning');
  if (hour < 15) return t('Good afternoon');
  if (hour < 19) return t('Good evening');
  return t('Good night');
}

export function Home({
  companies, openCompany, startCompany, setup,
}: {
  companies: Company[];
  openCompany: (id: string, page: CompanyPage, item?: string | null) => void;
  startCompany: () => void;
  setup: { notes: string[]; todo: string[] };
}) {
  const view = useLoad(async () => Promise.all(companies.map(async (company): Promise<CompanyState> => {
    const [{ items }, digest, work, spend]: [
      { items: InboxItem[] }, Digest, { items: WorkItem[]; counts: Record<WorkGroup, number> }, Spend,
    ] = await Promise.all([
      api('GET', `/api/companies/${company.id}/inbox`),
      api('GET', `/api/companies/${company.id}/digest`),
      api('GET', `/api/companies/${company.id}/work?group=active&limit=6`),
      api('GET', `/api/companies/${company.id}/spend`),
    ]);
    return { company, inbox: items, digest, running: work.items, counts: work.counts, spend };
  })), [companies.map((company) => company.id).join(',')], { every: 20_000 });

  const today = new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });

  if (companies.length === 0) {
    return (
      <Paper withBorder radius="lg" mt="xl">
        <EmptyState
          image="/illustrations/owner-and-agents.webp"
          title={t('Start your first company')}
          description={t('A company is a set of divisions and roles that work towards goals you set, within a budget you set. It starts from a template and you shape it from there.')}
          action={<Button leftSection={<IconPlus size={16} />} onClick={startCompany}>{t('Start a company')}</Button>}
        />
      </Paper>
    );
  }

  const states = view.data ?? [];
  const waiting = states.flatMap((state) => state.inbox.map((item) => ({ item, company: state.company })))
    .sort((a, b) => (a.item.tier === 3 ? 0 : a.item.kind === 'incident' ? 1 : 2) - (b.item.tier === 3 ? 0 : b.item.kind === 'incident' ? 1 : 2)
      || a.item.createdAt.localeCompare(b.item.createdAt));
  const running = states.flatMap((state) => state.running.map((item) => ({ item, company: state.company })));
  const stopped = states.reduce((total, state) => total + state.digest.tasksFailed + state.digest.tasksHalted, 0);
  const incidents = states.reduce((total, state) => total + state.digest.openIncidents, 0);

  const summary = !view.data ? '' : waiting.length > 0
    ? tp('{count} decision is waiting for you.', '{count} decisions are waiting for you.', waiting.length)
    : t('Nothing needs you right now.');
  const detail = !view.data ? '' : [
    tp('{count} task running', '{count} tasks running', running.length),
    incidents > 0 ? tp('{count} open incident', '{count} open incidents', incidents) : null,
    stopped > 0 ? tp('{count} stopped today', '{count} stopped today', stopped) : null,
  ].filter(Boolean).join(' · ');

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed" fw={500} tt="capitalize">{today}</Text>
          <Title order={1} fz={{ base: 26, sm: 30 }} fw={750} mt={4}>{greeting()}</Title>
          {view.data && (
            <Text size="lg" mt={6}>
              <Text span fw={650} c={waiting.length > 0 ? 'orange.7' : 'teal.7'}>{summary}</Text>{' '}
              <Text span c="dimmed" size="md">{detail}</Text>
            </Text>
          )}
        </div>
        <LiveIndicator at={view.updatedAt} />
      </Group>

      {view.error && !view.data ? <LoadFailed message={view.error} retry={view.reload} /> : !view.data ? <Loading rows={4} /> : (
        <>
          {setup.todo.length > 0 && (
            <Paper withBorder radius="lg" p="md" bg="var(--mantine-color-yellow-light)">
              <Group gap="sm" wrap="nowrap">
                <IconChecklist size={20} color="var(--mantine-color-yellow-8)" />
                <Text size="sm" fw={600}>
                  {tp('This deployment has {count} thing switched off until it is configured.', 'This deployment has {count} things switched off until they are configured.', setup.todo.length)}
                </Text>
                <Text size="sm" c="dimmed" visibleFrom="sm">{t('The checklist is at the foot of the sidebar.')}</Text>
              </Group>
            </Paper>
          )}

          <Grid gap="lg">
            <Grid.Col span={{ base: 12, lg: 7 }}>
              <Section title={t('Needs you')} description={t('Across every company, most urgent first.')} padding={0}>
                {waiting.length === 0 ? (
                  <Text size="sm" c="dimmed" px="lg" pb="lg">{t('Every approval, incident and question has been answered.')}</Text>
                ) : (
                  <Stack gap={0}>
                    {waiting.slice(0, 7).map(({ item, company }) => (
                      <UnstyledButton key={item.id} className="list-row" onClick={() => openCompany(company.id, 'inbox', item.id)}>
                        <Group justify="space-between" wrap="nowrap" gap="sm">
                          <div style={{ minWidth: 0 }}>
                            <Text size="sm" fw={600} lineClamp={1}>{item.title}</Text>
                            <Group gap={6} mt={4}>
                              <TierBadge tier={item.tier} />
                              <KindBadge kind={item.kind} />
                              <Text size="xs" c="dimmed">{company.name} · {relative(item.createdAt)}</Text>
                            </Group>
                          </div>
                          <IconArrowRight size={16} color="var(--mantine-color-dimmed)" />
                        </Group>
                      </UnstyledButton>
                    ))}
                    {waiting.length > 7 && (
                      <Text size="sm" c="dimmed" px="lg" py="sm">{t('And {count} more in the inboxes.', { count: waiting.length - 7 })}</Text>
                    )}
                  </Stack>
                )}
              </Section>
            </Grid.Col>
            <Grid.Col span={{ base: 12, lg: 5 }}>
              <Section title={t('Happening now')} description={t('Tasks being worked on, with how far they have got.')} padding={0}>
                {running.length === 0 ? (
                  <Text size="sm" c="dimmed" px="lg" pb="lg">{t('Nothing is running right now.')}</Text>
                ) : (
                  <Stack gap={0}>
                    {running.slice(0, 6).map(({ item, company }) => (
                      <UnstyledButton key={item.id} className="list-row" onClick={() => openCompany(company.id, 'work', item.id)}>
                        <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                        <Group gap={6} mt={2} mb={6}>
                          <StatusBadge status={item.status} />
                          <Text size="xs" c="dimmed">{company.name} · {item.roleSlug}</Text>
                        </Group>
                        <TaskProgress item={item} />
                      </UnstyledButton>
                    ))}
                  </Stack>
                )}
              </Section>
            </Grid.Col>
          </Grid>

          <div>
            <Group justify="space-between" mb="sm">
              <Text fw={700}>{t('Your companies')}</Text>
              <Button variant="subtle" size="xs" leftSection={<IconPlus size={14} />} onClick={startCompany}>{t('Start a company')}</Button>
            </Group>
            <SimpleGrid cols={{ base: 1, sm: 2, xl: 3 }} spacing="lg">
              {states.map((state) => <CompanyCard key={state.company.id} state={state} open={(page) => openCompany(state.company.id, page)} />)}
            </SimpleGrid>
          </div>
        </>
      )}
    </Stack>
  );
}

function CompanyCard({ state, open }: { state: CompanyState; open: (page: CompanyPage) => void }) {
  const { company, inbox, digest, counts, spend } = state;
  const used = spend.limitCents > 0 ? Math.min(100, (spend.spentCents / spend.limitCents) * 100) : 0;
  const health = company.frozen
    ? { label: t('Frozen'), color: 'gray' }
    : spend.pausedAt ? { label: t('Spending paused'), color: 'red' }
      : digest.openIncidents > 0 ? { label: t('Incident open'), color: 'red' }
        : inbox.length > 0 ? { label: t('Waiting on you'), color: 'orange' }
          : { label: t('Running smoothly'), color: 'teal' };

  return (
    <Paper withBorder radius="lg" p="lg" shadow="xs" className="company-card">
      <UnstyledButton w="100%" onClick={() => open('overview')}>
        <Group justify="space-between" wrap="nowrap" mb="md">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <Avatar color="brand" radius="md" size={40}>{company.name.slice(0, 1).toUpperCase()}</Avatar>
            <div style={{ minWidth: 0 }}>
              <Text fw={700} truncate>{company.name}</Text>
              <Badge size="sm" variant="dot" color={health.color}>{health.label}</Badge>
            </div>
          </Group>
          <IconArrowRight size={18} color="var(--mantine-color-dimmed)" />
        </Group>
      </UnstyledButton>
      <SimpleGrid cols={3} spacing="xs">
        <Figure label={t('Needs you')} value={inbox.length} alert={inbox.length > 0} onClick={() => open('inbox')} />
        <Figure label={t('Running')} value={counts.active} onClick={() => open('work')} />
        <Figure label={t('Done today')} value={digest.tasksCompleted} onClick={() => open('work')} />
      </SimpleGrid>
      <div style={{ marginTop: 16 }}>
        <Group justify="space-between">
          <Text size="xs" c="dimmed">{t('Budget this period')}</Text>
          <Text size="xs" c="dimmed" className="tabular">{money(spend.spentCents)} / {money(spend.limitCents)}</Text>
        </Group>
        <Progress value={used} size="sm" mt={6} radius="xl" color={used >= 100 ? 'red' : used >= 80 ? 'orange' : 'brand'} />
      </div>
      <Group justify="space-between" mt="md">
        <Text size="xs" c="dimmed">{t('Spent today: {amount}', { amount: money(digest.moneySpentCents) })}</Text>
        <Anchor size="xs" onClick={() => open('inbox')}>{t('Open the inbox')}</Anchor>
      </Group>
    </Paper>
  );
}

function Figure({ label, value, alert = false, onClick }: { label: string; value: number; alert?: boolean; onClick: () => void }) {
  return (
    <UnstyledButton onClick={onClick} className="figure">
      <Text size="xs" c="dimmed">{label}</Text>
      <Text fz={22} fw={750} c={alert ? 'orange.7' : undefined} className="tabular">{value}</Text>
    </UnstyledButton>
  );
}
