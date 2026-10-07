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
  Tooltip, UnstyledButton,
} from '@mantine/core';
import { IconAlertTriangle, IconArrowRight, IconChecklist, IconPlus, IconUpload } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { go, type CompanyPage } from '../router.ts';
import type { Company, Digest, InboxItem, SetupReport, Spend, WorkGroup, WorkItem } from '../types.ts';
import { money, relative } from '../format.ts';
import { locale, t, tp } from '../i18n.ts';
import { EmptyState, KindBadge, LiveIndicator, Loading, LoadFailed, Section, StatusBadge, TierBadge } from '../components/ui.tsx';
import { TaskProgress } from './Work.tsx';
import { metricValue } from '../components/Metrics.tsx';
import { companyEmblem, rolePicture } from '../images.ts';

interface CompanyState {
  company: Company;
  inbox: InboxItem[];
  digest: Digest;
  running: WorkItem[];
  delivered: WorkItem[];
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

/**
 * What a new deployment needs, in the order it matters. A missing model stops
 * every role, so it is said first and alone, with the button that fixes it; the
 * rest of what the deployment reported is mostly optional channels, so it is a
 * count and a way to the list -- not the same button for every one of them.
 */
function SetupNotice({ setup, checklist }: { setup: SetupReport; checklist: () => void }) {
  if (setup.modelMissing) {
    return (
      <Paper withBorder radius="lg" p="md" bg="var(--mantine-color-red-light)">
        <Group gap="sm" wrap="wrap">
          <IconAlertTriangle size={20} color="var(--mantine-color-red-8)" style={{ flexShrink: 0 }} />
          <Text size="sm" fw={600} style={{ flex: '1 1 14rem' }}>
            {t('No model is set, so no role can do any work yet. Choose one before you start a company.')}
          </Text>
          <Button size="compact-sm" color="red" ms="auto" style={{ flexShrink: 0 }} onClick={() => go({ kind: 'deployment', section: 'model' })}>
            {t('Set the model')}
          </Button>
        </Group>
      </Paper>
    );
  }
  if (setup.todo.length === 0) return null;
  return (
    <Paper withBorder radius="lg" p="md" bg="var(--mantine-color-yellow-light)">
      {/* Wraps rather than squeezes: in Russian or Hindi the sentence is long
          enough on a phone to push the button's own label out. */}
      <Group gap="sm" wrap="wrap">
        <IconChecklist size={20} color="var(--mantine-color-yellow-8)" style={{ flexShrink: 0 }} />
        <Text size="sm" fw={600} style={{ flex: '1 1 14rem' }}>
          {tp('This deployment has {count} thing switched off until it is configured.', 'This deployment has {count} things switched off until they are configured.', setup.todo.length)}
        </Text>
        <Button size="compact-sm" variant="light" color="yellow" ms="auto" style={{ flexShrink: 0 }} onClick={checklist}>
          {t('Review the checklist')}
        </Button>
      </Group>
    </Paper>
  );
}

export function Home({
  companies, openCompany, startCompany, restoreCompany, setup, checklist,
}: {
  companies: Company[];
  openCompany: (id: string, page: CompanyPage, item?: string | null) => void;
  /** Null for a staff seat, which neither starts nor restores a company (0110). */
  startCompany: (() => void) | null;
  restoreCompany: (() => void) | null;
  setup: SetupReport;
  /** Opens the list of what the deployment reported when it started. */
  checklist: () => void;
}) {
  const view = useLoad(async () => Promise.all(companies.map(async (company): Promise<CompanyState> => {
    const [{ items }, digest, work, done, spend]: [
      { items: InboxItem[] }, Digest, { items: WorkItem[]; counts: Record<WorkGroup, number> }, { items: WorkItem[] }, Spend,
    ] = await Promise.all([
      api('GET', `/api/companies/${company.id}/inbox`),
      api('GET', `/api/companies/${company.id}/digest`),
      api('GET', `/api/companies/${company.id}/work?group=active&limit=6`),
      api('GET', `/api/companies/${company.id}/work?group=done&limit=4`),
      api('GET', `/api/companies/${company.id}/spend`),
    ]);
    return { company, inbox: items, digest, running: work.items, delivered: done.items, counts: work.counts, spend };
  })), [companies.map((company) => company.id).join(',')], { every: 20_000 });

  // Only the first letter is raised, as a sentence starts: Portuguese and
  // Russian write days and months in lower case ("quarta-feira, 30 de
  // setembro"), which capitalising every word made "Quarta-Feira, 30 De".
  const date = new Date().toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  const today = date.charAt(0).toLocaleUpperCase(locale()) + date.slice(1);

  if (companies.length === 0) {
    return (
      <Stack gap="md" mt="xl">
      <SetupNotice setup={setup} checklist={checklist} />
      <Paper withBorder radius="lg">
        <EmptyState
          image="/illustrations/owner-and-agents.webp"
          title={t('Start your first company')}
          description={t('A company starts with a CEO and what you say it is for. The CEO builds the team as the work needs it, within a budget you set.')}
          action={startCompany && restoreCompany ? (
            <Group justify="center">
              <Button leftSection={<IconPlus size={16} />} onClick={startCompany}>{t('Start a company')}</Button>
              <Button variant="default" leftSection={<IconUpload size={16} />} onClick={restoreCompany}>{t('Restore from an export')}</Button>
            </Group>
          ) : undefined}
        />
      </Paper>
      </Stack>
    );
  }

  const states = view.data ?? [];
  const waiting = states.flatMap((state) => state.inbox.map((item) => ({ item, company: state.company })))
    .sort((a, b) => (a.item.tier === 3 ? 0 : a.item.kind === 'incident' ? 1 : 2) - (b.item.tier === 3 ? 0 : b.item.kind === 'incident' ? 1 : 2)
      || a.item.createdAt.localeCompare(b.item.createdAt));
  const running = states.flatMap((state) => state.running.map((item) => ({ item, company: state.company })));
  const delivered = states.flatMap((state) => state.delivered.map((item) => ({ item, company: state.company })))
    .sort((a, b) => (b.item.finishedAt ?? '').localeCompare(a.item.finishedAt ?? ''));
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
          <Text size="sm" c="dimmed" fw={500}>{today}</Text>
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
          <SetupNotice setup={setup} checklist={checklist} />

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
                          <Avatar size={32} radius="md" src={companyEmblem(company)} alt="" />
                          <div style={{ minWidth: 0, flex: 1 }}>
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
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                          <Avatar size={36} radius="xl" src={rolePicture(item.roleSlug)} alt="" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                            <Group gap={6} mt={2} mb={6}>
                              <StatusBadge status={item.status} />
                              <Text size="xs" c="dimmed">{company.name} · {item.roleName ?? item.roleSlug}</Text>
                            </Group>
                            <TaskProgress item={item} />
                          </div>
                        </Group>
                      </UnstyledButton>
                    ))}
                  </Stack>
                )}
              </Section>
              {delivered.length > 0 && (
                <div style={{ marginTop: 'var(--mantine-spacing-lg)' }}>
                <Section title={t('Just delivered')} description={t('Finished work, and what came of it.')} padding={0}>
                  <Stack gap={0}>
                    {delivered.slice(0, 5).map(({ item, company }) => (
                      <UnstyledButton key={item.id} className="list-row" onClick={() => openCompany(company.id, 'work', item.id)}>
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                          <Avatar size={36} radius="xl" src={rolePicture(item.roleSlug)} alt="" />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Text size="sm" fw={600} lineClamp={1}>{item.summary}</Text>
                            {item.result && <Text size="xs" c="teal.8" lineClamp={2} mt={2}>{item.result}</Text>}
                            <Text size="xs" c="dimmed" mt={4}>{company.name} · {item.roleName ?? item.roleSlug} · {relative(item.finishedAt ?? item.createdAt)}</Text>
                          </div>
                        </Group>
                      </UnstyledButton>
                    ))}
                  </Stack>
                </Section>
                </div>
              )}
            </Grid.Col>
          </Grid>

          <div>
            <Group justify="space-between" mb="sm">
              <Text fw={700}>{t('Your companies')}</Text>
              {startCompany && restoreCompany && (
                <Group gap="xs">
                  <Button variant="subtle" size="xs" color="gray" leftSection={<IconUpload size={14} />} onClick={restoreCompany}>{t('Restore from an export')}</Button>
                  <Button variant="subtle" size="xs" leftSection={<IconPlus size={14} />} onClick={startCompany}>{t('Start a company')}</Button>
                </Group>
              )}
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
            <Avatar radius="md" size={40} src={companyEmblem(company)} alt="" />
            <div style={{ minWidth: 0 }}>
              <Text fw={700} truncate>{company.name}</Text>
              <Badge size="sm" variant="dot" color={health.color}>{health.label}</Badge>
            </div>
          </Group>
          <IconArrowRight size={18} color="var(--mantine-color-dimmed)" />
        </Group>
      </UnstyledButton>
      {company.headline && <Headline headline={company.headline} onClick={() => open('team')} />}
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

/** The number the company is judged by, and whether anyone checked it. */
function Headline({ headline, onClick }: { headline: NonNullable<Company['headline']>; onClick: () => void }) {
  const percent = headline.progress === null ? 0 : headline.progress * 100;
  return (
    <UnstyledButton w="100%" onClick={onClick} mb="md">
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text size="xs" c="dimmed" truncate>{headline.name}</Text>
        <Group gap={4} wrap="nowrap">
          {headline.verified === false && (
            <Tooltip label={t('An agent reported this and did not read it from the source')}>
              <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
            </Tooltip>
          )}
          <Text size="xs" className="tabular" style={{ whiteSpace: 'nowrap' }}>
            {headline.value === null ? t('No value yet') : metricValue(headline, headline.value)}
            <Text span c="dimmed" size="xs"> / {metricValue(headline, headline.target)}</Text>
          </Text>
        </Group>
      </Group>
      <Progress value={percent} size="sm" mt={6} radius="xl" color={percent >= 100 ? 'teal' : headline.verified === false ? 'orange' : 'brand'} />
    </UnstyledButton>
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
