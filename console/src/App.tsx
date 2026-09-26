/**
 * The owner's console: the door, and the companies behind it.
 *
 * One human, one queue of decisions (PRD v2 §5 principle 1), many companies.
 * The sidebar is arranged by what the owner comes to do: see how things are
 * (Home), decide (Inbox), look at one company (its overview, work, team,
 * memory, money and history), and -- rarely -- change how it is set up
 * (Settings). The emergency stop is always one press away at the foot of it.
 *
 * The shell is keyed by the language, so choosing another redraws everything
 * in it (console/src/i18n.ts). The session lives above the key and survives.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, AppShell, Avatar, Badge, Box, Button, Divider, Drawer, Group, Menu, Modal,
  NavLink, Paper, Progress, ScrollArea, Stack, Text, TextInput, Tooltip, UnstyledButton,
  useMantineColorScheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Spotlight, spotlight, type SpotlightActionData } from '@mantine/spotlight';
import {
  IconActivity, IconAlertOctagon, IconBrain, IconBuildingStore, IconCheck, IconChecklist, IconChevronDown,
  IconCoin, IconDots, IconHistory, IconHome, IconInbox, IconLanguage, IconLayoutDashboard, IconLogout,
  IconMoon, IconPlayerPlay, IconPlayerStop, IconPlus, IconSearch, IconSettings, IconSitemap, IconSun,
} from '@tabler/icons-react';
import { api, explain, setToken, whenSignedOut } from './api.ts';
import { useFactor } from './factor.tsx';
import { useLoad } from './hooks.ts';
import { LANGUAGES, N, isLanguage, language, setLanguage, t, useLanguage, type Language } from './i18n.ts';
import { go, takeLinkedRoute, useRoute, type CompanyPage, type Route, type SettingsSection } from './router.ts';
import type { Company, Structure } from './types.ts';
import { SignIn } from './pages/SignIn.tsx';
import { Home } from './pages/Home.tsx';
import { Decisions } from './pages/Decisions.tsx';
import { Overview } from './pages/Overview.tsx';
import { Work } from './pages/Work.tsx';
import { Organization } from './pages/Organization.tsx';
import { Memory } from './pages/Memory.tsx';
import { Money } from './pages/Money.tsx';
import { History } from './pages/History.tsx';
import { SettingsHub } from './pages/SettingsHub.tsx';
import { AssignWork } from './components/AssignWork.tsx';

/** The pages of one company, as the sidebar offers them. */
const PAGES: Array<{ id: CompanyPage; label: string; icon: typeof IconInbox; group: 'decide' | 'company' | 'setup' }> = [
  { id: 'inbox', label: N('Inbox'), icon: IconInbox, group: 'decide' },
  { id: 'overview', label: N('Overview'), icon: IconLayoutDashboard, group: 'company' },
  { id: 'work', label: N('Work'), icon: IconActivity, group: 'company' },
  { id: 'team', label: N('Team'), icon: IconSitemap, group: 'company' },
  { id: 'memory', label: N('Memory'), icon: IconBrain, group: 'company' },
  { id: 'money', label: N('Money'), icon: IconCoin, group: 'company' },
  { id: 'history', label: N('History'), icon: IconHistory, group: 'company' },
  { id: 'settings', label: N('Settings'), icon: IconSettings, group: 'setup' },
];

export function App() {
  const [device, setDevice] = useState<string | null>(null);
  const lang = useLanguage();
  useEffect(() => { takeLinkedRoute(); }, []);
  useEffect(() => whenSignedOut(() => setDevice(null)), []);

  if (!device) {
    return <SignIn key={lang} onSignedIn={(session) => { setToken(session.token); setDevice(session.device); }} />;
  }
  return (
    <Console
      key={lang}
      device={device}
      signOut={async () => {
        await api('POST', '/api/auth/sign-out', {}).catch(() => undefined);
        setToken(null);
        setDevice(null);
      }}
    />
  );
}

export interface ConsoleContext {
  companyId: string;
  company: Company;
  companies: Company[];
  /** Open another page of this company. */
  open: (page: CompanyPage, options?: { section?: SettingsSection; item?: string | null }) => void;
  refreshCompanies: () => Promise<void>;
  /** The inbox tells the navigation how many decisions are waiting. */
  setOpenCount: (count: number) => void;
  giveWork: () => void;
}

export interface PageProps {
  ctx: ConsoleContext;
  route: Extract<Route, { kind: 'company' }>;
}

export interface Languages {
  console: string | null;
  agents: string;
  supported: Array<{ code: string; name: string; native: string }>;
}

/**
 * The panel's language is the deployment's, kept by the owner API. Chosen
 * here, it is saved there first and drawn second, so the next sign-in -- on
 * this device or another -- opens in it.
 */
export async function chooseLanguage(code: Language): Promise<void> {
  await api('POST', '/api/control/languages', { console: code });
  setLanguage(code);
}

function Console({ device, signOut }: { device: string; signOut: () => Promise<void> }) {
  const route = useRoute();
  const mobile = useMediaQuery('(max-width: 48em)') ?? false;
  const requireFactor = useFactor();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const [openCount, setOpenCount] = useState<Record<string, number>>({});
  const [lastCompany, setLastCompany] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [more, setMore] = useState(false);
  const [giving, setGiving] = useState(false);
  const [checklist, setChecklist] = useState(false);

  const base = useLoad(async () => {
    const [{ companies }, control, setup, languages]: [
      { companies: Company[] }, { stopAll: boolean }, { notes: string[]; todo: string[] }, Languages,
    ] = await Promise.all([
      api('GET', '/api/companies'),
      api('GET', '/api/control'),
      api('GET', '/api/control/setup'),
      api('GET', '/api/control/languages'),
    ]);
    return { companies, stopAll: control.stopAll, setup, languages };
  }, [], { every: 30_000 });

  // The deployment's choice wins over the browser's once the owner is in.
  useEffect(() => {
    const chosen = base.data?.languages.console;
    if (isLanguage(chosen) && chosen !== language()) setLanguage(chosen);
  }, [base.data]);

  const companies = base.data?.companies ?? [];
  const stopAll = base.data?.stopAll ?? false;
  const refreshCompanies = useCallback(async () => { base.reload(); }, [base]);

  const routed = route.kind === 'company' ? companies.find((one) => one.id === route.companyId) ?? null : null;
  useEffect(() => { if (routed) setLastCompany(routed.id); }, [routed]);
  const company = routed ?? companies.find((one) => one.id === lastCompany) ?? companies[0] ?? null;

  // A company in the address that no longer exists: back to the portfolio.
  useEffect(() => {
    if (base.data && route.kind === 'company' && !routed) go({ kind: 'home' }, { replace: true });
  }, [base.data, route, routed]);

  const open = useCallback((page: CompanyPage, options: { section?: SettingsSection; item?: string | null; companyId?: string } = {}) => {
    const target = options.companyId ?? company?.id;
    if (!target) return;
    setMore(false);
    go({ kind: 'company', companyId: target, page, section: options.section ?? 'company', item: options.item ?? null });
  }, [company]);

  const context = useMemo<ConsoleContext | null>(() => (company ? {
    companyId: company.id,
    company,
    companies,
    open: (page, options) => open(page, options),
    refreshCompanies,
    setOpenCount: (count: number) => setOpenCount((current) => (current[company.id] === count ? current : { ...current, [company.id]: count })),
    giveWork: () => setGiving(true),
  } : null), [company, companies, open, refreshCompanies]);

  // F10.7. Two controls, because they are two decisions: "stop" raises a flag
  // the engine reads at every step, so work stops cleanly and resumes when the
  // flag clears; "cancel everything" ends the tasks outright and cannot be
  // undone, which is why it asks for the authenticator. Stopping takes one
  // press; resuming takes the authenticator, so a stolen session cannot undo
  // the stop.
  const toggleStop = async () => {
    try {
      if (stopAll) {
        const done = await requireFactor(t('Resume everything'), (proof) => api('POST', '/api/control/stop-all', { on: false, proof }));
        if (!done) return;
      } else {
        await api('POST', '/api/control/stop-all', { on: true });
      }
      base.reload();
      notifications.show({ color: stopAll ? 'teal' : 'red', message: stopAll ? t('Everything is running again.') : t('Every company is halted. Nothing is running.') });
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const cancelEverything = async () => {
    setCancelling(false);
    const done = await requireFactor(t('Cancel every task in every company'), (proof) => api('POST', '/api/control/cancel-everything', { proof }));
    if (done) {
      notifications.show({ color: 'red', message: t('Every task was cancelled.') });
      base.reload();
    }
  };

  const pickLanguage = async (code: Language) => {
    try {
      await chooseLanguage(code);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const spotlightActions: SpotlightActionData[] = [
    { id: 'home', label: t('Home'), description: t('Every company at a glance'), leftSection: <IconHome size={18} />, onClick: () => go({ kind: 'home' }) },
    ...PAGES.map((page) => ({
      id: `page-${page.id}`,
      label: t(page.label),
      description: company ? company.name : '',
      leftSection: <page.icon size={18} />,
      onClick: () => open(page.id),
    })),
    ...companies.map((one) => ({
      id: `company-${one.id}`,
      label: t('Switch to {company}', { company: one.name }),
      description: t('Company'),
      leftSection: <Avatar size={20} radius="sm" color="brand">{one.name.slice(0, 1)}</Avatar>,
      onClick: () => open('inbox', { companyId: one.id }),
    })),
    { id: 'give-work', label: t('Give a role something to do'), description: t('Wakes the role now'), leftSection: <IconPlus size={18} />, onClick: () => setGiving(true) },
    { id: 'start-company', label: t('Start a company'), description: t('From the standard template'), leftSection: <IconBuildingStore size={18} />, onClick: () => setStarting(true) },
    { id: 'languages', label: t('Languages'), description: t('The panel, and what your agents write in'), leftSection: <IconLanguage size={18} />, onClick: () => open('settings', { section: 'language' }) },
    { id: 'stop', label: stopAll ? t('Resume everything') : t('Stop everything'), description: t('Every company'), leftSection: <IconPlayerStop size={18} />, onClick: () => void toggleStop() },
    { id: 'theme', label: colorScheme === 'dark' ? t('Light theme') : t('Dark theme'), description: t('Appearance'), leftSection: <IconMoon size={18} />, onClick: toggleColorScheme },
  ];

  const setup = base.data?.setup ?? { notes: [], todo: [] };
  const inboxCount = company ? openCount[company.id] ?? 0 : 0;
  const active = route.kind === 'home' ? 'home' : route.page;

  const navLink = (page: (typeof PAGES)[number]) => (
    <NavLink
      key={page.id}
      label={t(page.label)}
      leftSection={<page.icon size={18} stroke={1.7} />}
      rightSection={page.id === 'inbox' && inboxCount > 0 ? <Badge size="sm" color="red" circle>{inboxCount}</Badge> : null}
      active={active === page.id}
      onClick={() => open(page.id)}
      className="nav-link"
    />
  );

  const languageMenu = (
    <>
      <Menu.Label>{t('Panel language')}</Menu.Label>
      {LANGUAGES.map((one) => (
        <Menu.Item
          key={one.code}
          leftSection={<IconLanguage size={16} />}
          rightSection={one.code === language() ? <IconCheck size={14} /> : null}
          onClick={() => void pickLanguage(one.code)}
        >
          {one.name}
        </Menu.Item>
      ))}
    </>
  );

  return (
    <AppShell
      navbar={{ width: 264, breakpoint: 'sm', collapsed: { mobile: true } }}
      // The phone's own header and tab bar exist only on a phone: collapsed
      // rather than absent, they still sat just past the bottom of the screen.
      {...(mobile ? { header: { height: 56 }, footer: { height: 64 } } : {})}
      padding={0}
    >
      <Spotlight
        actions={spotlightActions}
        nothingFound={t('Nothing matches')}
        highlightQuery
        searchProps={{ leftSection: <IconSearch size={18} />, placeholder: t('Go to a page, switch company, or do something…') }}
        shortcut={['mod + K', '/']}
      />

      {mobile && <AppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <span className="brand-mark" aria-hidden="true">P</span>
            <CompanyMenu companies={companies} company={company} openCount={openCount} compact
              pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={() => setStarting(true)} />
          </Group>
          <Group gap={6} wrap="nowrap">
            <ActionIcon variant="subtle" size="lg" onClick={() => spotlight.open()} aria-label={t('Search')}><IconSearch size={18} /></ActionIcon>
            <ActionIcon variant={stopAll ? 'filled' : 'light'} color={stopAll ? 'teal' : 'red'} size="lg" onClick={() => void toggleStop()} aria-label={stopAll ? t('Resume everything') : t('Stop everything')}>
              {stopAll ? <IconPlayerPlay size={18} /> : <IconPlayerStop size={18} />}
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>}

      <AppShell.Navbar p="sm" style={{ background: 'var(--app-sidebar)' }}>
        <AppShell.Section>
          <Group justify="space-between" px={6} pt={4} pb="sm" wrap="nowrap">
            <Group gap={10} wrap="nowrap">
              <span className="brand-mark" aria-hidden="true">P</span>
              <Text fw={800} lts="0.1em" size="sm">PALUGADA</Text>
            </Group>
            <Tooltip label={t('Search and jump (⌘K)')}>
              <ActionIcon variant="subtle" color="gray" onClick={() => spotlight.open()} aria-label={t('Search')}><IconSearch size={18} /></ActionIcon>
            </Tooltip>
          </Group>
          <CompanyMenu companies={companies} company={company} openCount={openCount}
            pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={() => setStarting(true)} />
          <Menu position="bottom-start" width="target" shadow="md">
            <Menu.Target>
              <Button fullWidth mt="sm" leftSection={<IconPlus size={16} />} justify="flex-start">{t('New')}</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconActivity size={16} />} onClick={() => setGiving(true)} disabled={!company}>{t('Give a role work')}</Menu.Item>
              <Menu.Item leftSection={<IconSitemap size={16} />} onClick={() => open('team')} disabled={!company}>{t('Schedule, goal or policy')}</Menu.Item>
              <Menu.Item leftSection={<IconBuildingStore size={16} />} onClick={() => setStarting(true)}>{t('Start a company')}</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt="sm">
          <NavLink label={t('Home')} leftSection={<IconHome size={18} stroke={1.7} />} active={active === 'home'} onClick={() => go({ kind: 'home' })} className="nav-link" />
          {PAGES.filter((page) => page.group === 'decide').map(navLink)}
          {company && <div className="nav-section-label">{company.name}</div>}
          {PAGES.filter((page) => page.group === 'company').map(navLink)}
        </AppShell.Section>

        <AppShell.Section>
          {setup.todo.length > 0 && (
            <Paper withBorder radius="md" p="sm" mb="sm" className="clickable-row" onClick={() => setChecklist(true)}>
              <Group gap="xs" wrap="nowrap">
                <IconChecklist size={18} color="var(--mantine-color-yellow-7)" />
                <Text size="sm" fw={600}>{t('Finish setting up')}</Text>
                <Text size="xs" c="dimmed" ml="auto" className="tabular">{setup.notes.length - setup.todo.length}/{setup.notes.length}</Text>
              </Group>
              <Progress value={((setup.notes.length - setup.todo.length) / Math.max(1, setup.notes.length)) * 100} size="sm" mt={8} color="yellow" radius="xl" />
            </Paper>
          )}
          {PAGES.filter((page) => page.group === 'setup').map(navLink)}
          <Button
            fullWidth
            mt="xs"
            color={stopAll ? 'teal' : 'red'}
            variant={stopAll ? 'filled' : 'light'}
            leftSection={stopAll ? <IconPlayerPlay size={16} /> : <IconPlayerStop size={16} />}
            onClick={() => void toggleStop()}
          >
            {stopAll ? t('Resume everything') : t('Stop everything')}
          </Button>
          <Divider my="sm" />
          <Menu position="top-start" width={240} shadow="md">
            <Menu.Target>
              <UnstyledButton w="100%" px={6} py={4} style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                <Group gap="sm" wrap="nowrap">
                  <Avatar color="teal" radius="xl" size={32}>{device.slice(0, 1).toUpperCase()}</Avatar>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" fw={600}>{t('Owner')}</Text>
                    <Text size="xs" c="dimmed" truncate>{device}</Text>
                  </div>
                  <IconDots size={16} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              {languageMenu}
              <Menu.Divider />
              <Menu.Item leftSection={colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />} onClick={toggleColorScheme}>
                {colorScheme === 'dark' ? t('Light theme') : t('Dark theme')}
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconAlertOctagon size={16} />} onClick={() => setCancelling(true)}>{t('Cancel every task…')}</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>{t('Sign out')}</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main className="app-main">
        {stopAll && (
          <Box bg="red.6" c="white" py={8} px="lg">
            <Group justify="center" gap="sm">
              <IconAlertOctagon size={18} />
              <Text size="sm" fw={600}>{t('Everything is stopped. No company is doing any work.')}</Text>
              <Button size="compact-sm" variant="white" color="red" onClick={() => void toggleStop()}>{t('Resume')}</Button>
            </Group>
          </Box>
        )}
        <Box className="app-content" px={{ base: 'md', sm: 'xl' }} py={{ base: 'md', sm: 'xl' }}>
          {!base.data ? null : route.kind === 'home' || !context ? (
            <Home
              companies={companies}
              openCompany={(id, page, item) => open(page, { companyId: id, item: item ?? null })}
              startCompany={() => setStarting(true)}
              setup={setup}
            />
          ) : (
            <CompanyPageView key={`${context.companyId}:${route.page}:${route.section}`} ctx={context} route={route as Extract<Route, { kind: 'company' }>} />
          )}
        </Box>
      </AppShell.Main>

      {mobile && <AppShell.Footer>
        <Group h="100%" gap={0} wrap="nowrap">
          {[
            { id: 'home', label: t('Home'), icon: IconHome, press: () => go({ kind: 'home' }) },
            { id: 'inbox', label: t('Inbox'), icon: IconInbox, press: () => open('inbox'), badge: inboxCount },
            { id: 'work', label: t('Work'), icon: IconActivity, press: () => open('work') },
            { id: 'money', label: t('Money'), icon: IconCoin, press: () => open('money') },
          ].map((tab) => (
            <UnstyledButton key={tab.id} className="bottom-tab" data-active={active === tab.id || undefined} onClick={tab.press}>
              <Box pos="relative">
                <tab.icon size={22} stroke={1.7} />
                {tab.badge ? <Badge size="xs" color="red" circle pos="absolute" top={-6} right={-12}>{tab.badge}</Badge> : null}
              </Box>
              {tab.label}
            </UnstyledButton>
          ))}
          <UnstyledButton className="bottom-tab" data-active={['team', 'memory', 'history', 'settings', 'overview'].includes(active) || undefined} onClick={() => setMore(true)}>
            <IconDots size={22} stroke={1.7} />
            {t('More')}
          </UnstyledButton>
        </Group>
      </AppShell.Footer>}

      <Drawer opened={more} onClose={() => setMore(false)} position="bottom" size="auto" title={company?.name} radius="lg">
        <Stack gap={4} pb="md">
          {PAGES.filter((page) => !['inbox', 'work', 'money'].includes(page.id)).map(navLink)}
          <Divider my="xs" />
          {LANGUAGES.map((one) => (
            <NavLink key={one.code} label={one.name} leftSection={<IconLanguage size={18} />} active={one.code === language()} onClick={() => void pickLanguage(one.code)} />
          ))}
          <NavLink label={colorScheme === 'dark' ? t('Light theme') : t('Dark theme')} leftSection={<IconMoon size={18} />} onClick={toggleColorScheme} />
          <NavLink label={t('Sign out')} leftSection={<IconLogout size={18} />} onClick={() => void signOut()} />
        </Stack>
      </Drawer>

      <StartCompany opened={starting} close={() => setStarting(false)} started={(id) => { base.reload(); open('overview', { companyId: id }); }} />

      <GiveWork companyId={company?.id ?? null} opened={giving} close={() => setGiving(false)} />

      <Modal opened={checklist} onClose={() => setChecklist(false)} title={t('Finish setting up this deployment')} size="lg" centered>
        <Text size="sm" c="dimmed" mb="md">
          {t('What the deployment reported when it started. Each one is something switched off until the operator configures it; the README lists every variable.')}
        </Text>
        <Stack gap="xs">
          {setup.notes.map((note) => {
            const done = !setup.todo.includes(note);
            return (
              <Group key={note} gap="sm" wrap="nowrap" align="flex-start">
                <Badge color={done ? 'teal' : 'yellow'} variant="light" w={72}>{done ? t('done') : t('to do')}</Badge>
                <Text size="sm">{note}</Text>
              </Group>
            );
          })}
        </Stack>
      </Modal>

      <Modal opened={cancelling} onClose={() => setCancelling(false)} title={t('Cancel every task?')} centered>
        <Text size="sm">
          {t('This ends every task in every company, now, and cannot be undone. To pause instead, use Stop everything: that halts work cleanly and can be resumed.')}
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setCancelling(false)}>{t('Keep them')}</Button>
          <Button color="red" onClick={() => void cancelEverything()}>{t('Cancel everything')}</Button>
        </Group>
      </Modal>
    </AppShell>
  );
}

function CompanyPageView({ ctx, route }: PageProps) {
  switch (route.page) {
    case 'inbox': return <Decisions ctx={ctx} route={route} />;
    case 'overview': return <Overview ctx={ctx} route={route} />;
    case 'work': return <Work ctx={ctx} route={route} />;
    case 'team': return <Organization ctx={ctx} route={route} />;
    case 'memory': return <Memory ctx={ctx} route={route} />;
    case 'money': return <Money ctx={ctx} route={route} />;
    case 'history': return <History ctx={ctx} route={route} />;
    case 'settings': return <SettingsHub ctx={ctx} route={route} />;
  }
}

function CompanyMenu({
  companies, company, openCount, pick, start, compact = false,
}: {
  companies: Company[];
  company: Company | null;
  openCount: Record<string, number>;
  pick: (id: string) => void;
  start: () => void;
  compact?: boolean;
}) {
  return (
    <Menu width={compact ? 260 : 'target'} shadow="md" position="bottom-start">
      <Menu.Target>
        <UnstyledButton
          w={compact ? undefined : '100%'}
          p={compact ? 4 : 'xs'}
          style={compact ? undefined : { borderRadius: 'var(--mantine-radius-md)', border: '1px solid var(--mantine-color-default-border)', background: 'var(--mantine-color-body)' }}
        >
          <Group gap="sm" wrap="nowrap">
            {!compact && <Avatar color="brand" radius="md" size={34}>{company?.name.slice(0, 1).toUpperCase() ?? '?'}</Avatar>}
            <div style={{ flex: 1, minWidth: 0 }}>
              {!compact && <Text size="xs" c="dimmed">{t('Company')}</Text>}
              <Text fw={700} size="sm" truncate maw={compact ? 170 : undefined}>{company?.name ?? t('No company yet')}</Text>
            </div>
            <IconChevronDown size={16} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t('Your companies')}</Menu.Label>
        {companies.map((one) => (
          <Menu.Item
            key={one.id}
            leftSection={<Avatar size={22} radius="sm" color="brand">{one.name.slice(0, 1).toUpperCase()}</Avatar>}
            rightSection={openCount[one.id] ? <Badge size="xs" color="red" circle>{openCount[one.id]}</Badge> : one.frozen ? <Badge size="xs" color="gray">{t('frozen')}</Badge> : null}
            onClick={() => pick(one.id)}
          >
            {one.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item leftSection={<IconPlus size={16} />} onClick={start}>{t('Start a company')}</Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function GiveWork({ companyId, opened, close }: { companyId: string | null; opened: boolean; close: () => void }) {
  const structure = useLoad(async () => {
    if (!companyId || !opened) return null;
    const answer: Structure = await api('GET', `/api/companies/${companyId}/structure`);
    return answer;
  }, [companyId, opened]);
  return (
    <Modal opened={opened} onClose={close} title={t('Give a role something to do')} size="lg" centered>
      {structure.data && companyId ? <AssignWork companyId={companyId} structure={structure.data} done={close} /> : <Text size="sm" c="dimmed">{t('Loading…')}</Text>}
    </Modal>
  );
}

/**
 * Starting a company (PRD v2 section 5).
 *
 * A structural change if anything is -- it writes divisions, roles, grants and
 * a budget tree in one transaction -- so the API asks for the owner's device.
 */
function StartCompany({ opened, close, started }: { opened: boolean; close: () => void; started: (id: string) => void }) {
  const requireFactor = useFactor();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    let created: { companyId?: string } = {};
    try {
      const done = await requireFactor(t('Start {company}', { company: name }), async (proof) => {
        created = await api('POST', '/api/companies', { templateSlug: 'standard-company', companySlug: slug, name, proof });
      });
      if (!done) return;
      notifications.show({ color: 'teal', message: t('{company} is running.', { company: name }) });
      close();
      setName('');
      setSlug('');
      if (created.companyId) started(created.companyId);
    } catch (failure) {
      setError(explain(failure));
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Start a company')} centered>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('Built from the standard template: operations, delivery, growth, finance, support, assurance and a lab, with a role in each. Every capability the template grants must be bound on this deployment, and the refusal names any that are not.')}
        </Text>
        <TextInput label={t('Name')} placeholder={t('e.g. Kopi Nusantara')} value={name} onChange={(e) => {
          const value = e.currentTarget.value;
          setName(value);
          setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        }} required />
        <TextInput label={t('Short name')} description={t('Used in links and exports')} value={slug} onChange={(e) => setSlug(e.currentTarget.value)} required />
        {error && <Text c="red" size="sm">{error}</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={!name || !slug} onClick={() => void submit()}>{t('Start it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
