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
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, Alert, AppShell, Avatar, Badge, Box, Button, Center, Divider, Drawer, FileInput, Group, Loader, Menu, Modal,
  NavLink, Paper, Progress, ScrollArea, Select, SimpleGrid, Stack, Switch, Text, TextInput, Tooltip, UnstyledButton,
  useComputedColorScheme, useDirection, useMantineColorScheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Spotlight, spotlight, type SpotlightActionData } from '@mantine/spotlight';
import {
  IconActivity, IconAlertOctagon, IconBrain, IconBuildingStore, IconCheck, IconChecklist, IconChevronDown,
  IconCoin, IconDots, IconHistory, IconHome, IconInbox, IconKey, IconLanguage, IconLayoutDashboard, IconLogout, IconMap,
  IconMoon, IconPlayerPlay, IconPlayerStop, IconPlus, IconSearch, IconSparkles, IconServer2, IconSettings, IconSitemap, IconSun,
} from '@tabler/icons-react';
import { api, explain, setToken, whenSignedOut } from './api.ts';
import { useFactor } from './factor.tsx';
import { useLoad } from './hooks.ts';
import { LANGUAGES, N, direction, isLanguage, language, setLanguage, t, useLanguage, type Language } from './i18n.ts';
import { go, takeLinkedRoute, takeLinkedTalk, useRoute, type CompanyPage, type Route, type SettingsSection } from './router.ts';
import type { Company, SearchHit, Structure } from './types.ts';
import { companyEmblem, OWNER_PICTURE, rolePicture } from './images.ts';
import { SignIn } from './pages/SignIn.tsx';
import { Home } from './pages/Home.tsx';
// A company's pages and the deployment's settings, each fetched when it is
// first opened. The sign-in page and Home are the only ones every visit
// needs; the charts alone -- drawn on Overview and Money -- were 130 KB
// gzipped that the sign-in page fetched and never used.
const DeploymentSettings = lazy(() => import('./pages/Deployment.tsx').then((module) => ({ default: module.DeploymentSettings })));
const Decisions = lazy(() => import('./pages/Decisions.tsx').then((module) => ({ default: module.Decisions })));
const Overview = lazy(() => import('./pages/Overview.tsx').then((module) => ({ default: module.Overview })));
const Work = lazy(() => import('./pages/Work.tsx').then((module) => ({ default: module.Work })));
const Organization = lazy(() => import('./pages/Organization.tsx').then((module) => ({ default: module.Organization })));
const Memory = lazy(() => import('./pages/Memory.tsx').then((module) => ({ default: module.Memory })));
const Money = lazy(() => import('./pages/Money.tsx').then((module) => ({ default: module.Money })));
const History = lazy(() => import('./pages/History.tsx').then((module) => ({ default: module.History })));
const SettingsHub = lazy(() => import('./pages/SettingsHub.tsx').then((module) => ({ default: module.SettingsHub })));
import { AssignWork } from './components/AssignWork.tsx';
import { Assistant } from './components/Assistant.tsx';
import { Tour, type TourSpot } from './components/Tour.tsx';
import { setMoneyDisplay, useMoneyDisplay } from './format.ts';

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
  // Which kind of factor signed in: after a recovery code, the console asks for a new device.
  const [factor, setFactor] = useState<string | null>(null);
  const lang = useLanguage();
  const reading = useMoneyDisplay();
  // Mantine mirrors its components from its own direction, set here as the
  // language changes; the page's `dir` is set with the language (i18n.ts).
  const { setDirection } = useDirection();
  useEffect(() => { setDirection(direction()); }, [lang, setDirection]);
  useEffect(() => { takeLinkedRoute(); }, []);
  useEffect(() => whenSignedOut(() => setDevice(null)), []);

  if (!device) {
    return <SignIn key={lang} onSignedIn={(session) => { setToken(session.token); setDevice(session.factor === 'recovery' ? t('Recovery code') : session.device); setFactor(session.factor); }} />;
  }
  return (
    <Console
      key={`${lang}:${reading}`}
      device={device}
      recovered={factor === 'recovery'}
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
  /** Open the conversation with this company's CEO. */
  talk: () => void;
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

function Console({ device, recovered, signOut }: { device: string; recovered: boolean; signOut: () => Promise<void> }) {
  const route = useRoute();
  const mobile = useMediaQuery('(max-width: 48em)') ?? false;
  const requireFactor = useFactor();
  const { toggleColorScheme } = useMantineColorScheme();
  // What is on the screen, not what was chosen: under "auto" the choice is
  // neither light nor dark, and the menu would offer the dark theme to an owner
  // already looking at it.
  const colorScheme = useComputedColorScheme('light');
  const [openCount, setOpenCount] = useState<Record<string, number>>({});
  const [lastCompany, setLastCompany] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [more, setMore] = useState(false);
  const [giving, setGiving] = useState(false);
  const [asking, setAsking] = useState(false);
  // The company whose CEO the owner is talking to, if any.
  const [talking, setTalking] = useState<Company | null>(null);
  // A company just started, whose CEO has spoken first (its first hour):
  // the conversation opens once the company is in the list.
  const [greeting, setGreeting] = useState<string | null>(null);
  const [checklist, setChecklist] = useState(false);
  const [touring, setTouring] = useState(false);
  const [spot, setSpot] = useState<TourSpot | null>(null);
  const spotted = (name: TourSpot) => (spot === name ? ' tour-spot' : '');

  const base = useLoad(async () => {
    const [{ companies }, control, setup, languages, money]: [
      { companies: Company[] }, { stopAll: boolean }, { notes: string[]; todo: string[]; version?: string }, Languages,
      { currency: string | null; rate: number | null },
    ] = await Promise.all([
      api('GET', '/api/companies'),
      api('GET', '/api/control'),
      api('GET', '/api/control/setup'),
      api('GET', '/api/control/languages'),
      api('GET', '/api/control/money-display'),
    ]);
    return { companies, stopAll: control.stopAll, setup, languages, money };
  }, [], { every: 30_000 });

  // The tour, once: asked for at sign-in rather than every thirty seconds,
  // and opened by itself only while the deployment says it was never
  // finished or skipped.
  useEffect(() => {
    void api('GET', '/api/control/tour').then(
      (tour: { finishedAt: string | null }) => { if (tour.finishedAt === null) setTouring(true); },
      () => undefined,
    );
  }, []);
  const finishTour = useCallback(() => {
    setTouring(false);
    void api('POST', '/api/control/tour', { finished: true }).catch(() => undefined);
  }, []);

  // The deployment's choice wins over the browser's once the owner is in.
  useEffect(() => {
    const chosen = base.data?.languages.console;
    if (isLanguage(chosen) && chosen !== language()) setLanguage(chosen);
    // And the currency the owner reads money in (0106), which redraws the
    // console as a language does when it changes.
    const money = base.data?.money;
    if (money) setMoneyDisplay(money.currency && money.rate ? { currency: money.currency, rate: money.rate } : null);
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

  // Opened from a card in Telegram that the chat could not apply: the
  // conversation it came from, with the card waiting in it.
  useEffect(() => {
    if (!base.data || !takeLinkedTalk()) return;
    if (routed?.ceo) setTalking(routed);
    else setAsking(true);
  }, [base.data]);

  useEffect(() => {
    if (!greeting) return;
    const started = companies.find((one) => one.id === greeting);
    if (!started) return;
    setGreeting(null);
    if (started.ceo) setTalking(started);
  }, [greeting, companies]);

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
    talk: () => setTalking(company),
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
    { id: 'ask', label: t('Ask PALUGADA'), description: t('Say what you want; it sets things up with you'), leftSection: <IconSparkles size={18} />, onClick: () => setAsking(true) },
    ...(company?.ceo ? [{
      id: 'talk', label: t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug }),
      description: t('The one who runs {company} for you', { company: company.name }),
      leftSection: <Avatar size={18} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />, onClick: () => setTalking(company),
    }] : []),
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
      leftSection: <Avatar size={20} radius="sm" src={companyEmblem(one)} alt="" />,
      onClick: () => open('inbox', { companyId: one.id }),
    })),
    { id: 'give-work', label: t('Give a role something to do'), description: t('Wakes the role now'), leftSection: <IconPlus size={18} />, onClick: () => setGiving(true) },
    { id: 'start-company', label: t('Start a company'), description: t('From the standard template'), leftSection: <IconBuildingStore size={18} />, onClick: () => setStarting(true) },
    { id: 'deployment', label: t('Model'), description: t('This deployment'), leftSection: <IconServer2 size={18} />, onClick: () => go({ kind: 'deployment', section: 'model' }) },
    { id: 'languages', label: t('Languages'), description: t('The panel, and what your agents write in'), leftSection: <IconLanguage size={18} />, onClick: () => open('settings', { section: 'language' }) },
    { id: 'stop', label: stopAll ? t('Resume everything') : t('Stop everything'), description: t('Every company'), leftSection: <IconPlayerStop size={18} />, onClick: () => void toggleStop() },
    { id: 'theme', label: colorScheme === 'dark' ? t('Light theme') : t('Dark theme'), description: t('Appearance'), leftSection: <IconMoon size={18} />, onClick: toggleColorScheme },
  ];

  // What the search box found in every company (src/owner/search.ts): asked
  // once the owner has typed two characters and paused, and shown beside the
  // pages and commands whose names match.
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<SearchHit[]>([]);
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setFound([]);
      return;
    }
    const timer = setTimeout(() => {
      api('GET', `/api/search?q=${encodeURIComponent(text)}`)
        .then((answer: { hits: SearchHit[] }) => setFound(answer.hits))
        .catch(() => setFound([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const HIT_LABEL: Record<SearchHit['kind'], string> = { task: t('Task'), decision: t('Decision'), memory: t('Memory') };
  const foundActions: SpotlightActionData[] = found.map((hit) => ({
    id: `found-${hit.kind}-${hit.id}`,
    label: hit.title,
    description: `${HIT_LABEL[hit.kind]} · ${hit.company}${hit.detail && hit.kind !== 'memory' ? ` · ${hit.detail}` : ''}`,
    leftSection: hit.kind === 'task' ? <IconSitemap size={18} /> : hit.kind === 'decision' ? <IconCheck size={18} /> : <IconBrain size={18} />,
    onClick: () => (hit.kind === 'task' ? open('work', { companyId: hit.companyId, item: hit.id })
      : hit.kind === 'decision' ? open(hit.status === 'open' ? 'inbox' : 'history', { companyId: hit.companyId, item: hit.status === 'open' ? hit.id : null })
        : open('memory', { companyId: hit.companyId })),
  }));
  const matches = (action: SpotlightActionData) => {
    const text = query.trim().toLowerCase();
    return !text || `${action.label ?? ''} ${action.description ?? ''}`.toLowerCase().includes(text);
  };

  const setup: { notes: string[]; todo: string[]; version?: string } = base.data?.setup ?? { notes: [], todo: [] };
  const inboxCount = company ? openCount[company.id] ?? 0 : 0;
  const active = route.kind === 'company' ? route.page : route.kind;

  const navLink = (page: (typeof PAGES)[number]) => (
    <NavLink
      key={page.id}
      label={t(page.label)}
      leftSection={<page.icon size={18} stroke={1.7} />}
      rightSection={page.id === 'inbox' && inboxCount > 0 ? <Badge size="sm" color="red" circle>{inboxCount}</Badge> : null}
      active={active === page.id}
      onClick={() => open(page.id)}
      className={`nav-link${spotted(page.id as TourSpot)}`}
    />
  );

  const languageMenu = (
    <>
      <Menu.Label>{t('Panel language')}</Menu.Label>
      {/* Twenty-one languages are taller than a screen: the menu opens upward
          from the foot of the sidebar, and the first languages were above
          the top of the window, out of reach. They scroll in a box instead. */}
      <ScrollArea.Autosize mah={232} type="auto" offsetScrollbars>
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
      </ScrollArea.Autosize>
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
        query={query}
        onQueryChange={setQuery}
        // The pages and commands that match, then what the search found --
        // which matched on the server, perhaps in a result the title does
        // not show, so it is not filtered again here.
        actions={[...spotlightActions.filter(matches), ...(foundActions.length > 0 ? [{ group: t('Found'), actions: foundActions }] : [])]}
        filter={(_, actions) => actions}
        nothingFound={t('Nothing matches')}
        highlightQuery
        searchProps={{ leftSection: <IconSearch size={18} />, placeholder: t('Go to a page, switch company, or do something…') }}
        shortcut={['mod + K', '/']}
      />

      {mobile && <AppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <img className="brand-mark" src="/brand/palugada-app-icon.svg" alt="" width={30} height={30} />
            <CompanyMenu companies={companies} company={company} openCount={openCount} compact
              pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={() => setStarting(true)} />
          </Group>
          <Group gap={6} wrap="nowrap">
            {company?.ceo && (
              <ActionIcon variant="default" size="lg" radius="xl" onClick={() => setTalking(company)}
                aria-label={t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug })}>
                <Avatar size={26} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />
              </ActionIcon>
            )}
            <ActionIcon variant="light" size="lg" onClick={() => setAsking(true)} aria-label={t('Ask PALUGADA')}><IconSparkles size={18} /></ActionIcon>
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
              <img
                className="brand-lockup"
                src={colorScheme === 'dark' ? '/brand/palugada-lockup-on-dark.svg' : '/brand/palugada-lockup.svg'}
                alt="PALUGADA"
                height={26}
              />
            </Group>
            <Tooltip label={t('Search and jump (⌘K)')}>
              <ActionIcon variant="subtle" color="gray" onClick={() => spotlight.open()} aria-label={t('Search')}><IconSearch size={18} /></ActionIcon>
            </Tooltip>
          </Group>
          <CompanyMenu companies={companies} company={company} openCount={openCount}
            pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={() => setStarting(true)} />
          <Menu position="bottom-start" width="target" shadow="md">
            <Menu.Target>
              <Button fullWidth mt="sm" leftSection={<IconPlus size={16} />} justify="flex-start" className={spotted('new')}>{t('New')}</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconActivity size={16} />} onClick={() => setGiving(true)} disabled={!company}>{t('Give a role work')}</Menu.Item>
              <Menu.Item leftSection={<IconSitemap size={16} />} onClick={() => open('team')} disabled={!company}>{t('Schedule, goal or policy')}</Menu.Item>
              <Menu.Item leftSection={<IconBuildingStore size={16} />} onClick={() => setStarting(true)}>{t('Start a company')}</Menu.Item>
            </Menu.Dropdown>
          </Menu>
          {company?.ceo && (
            <Button fullWidth mt={6} variant="default" justify="flex-start" onClick={() => setTalking(company)}
              leftSection={<Avatar size={20} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />}>
              <Text size="sm" fw={600} truncate>{t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug })}</Text>
            </Button>
          )}
          <Button fullWidth mt={6} variant="light" leftSection={<IconSparkles size={16} />} justify="flex-start" onClick={() => setAsking(true)}>
            {t('Ask PALUGADA')}
          </Button>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt="sm">
          <NavLink label={t('Home')} leftSection={<IconHome size={18} stroke={1.7} />} active={active === 'home'} onClick={() => go({ kind: 'home' })} className={`nav-link${spotted('home')}`} />
          {PAGES.filter((page) => page.group === 'decide').map(navLink)}
          {company && <div className="nav-section-label">{company.name}</div>}
          {PAGES.filter((page) => page.group === 'company').map(navLink)}
        </AppShell.Section>

        <AppShell.Section>
          {setup.todo.length > 0 && (
            <Paper withBorder radius="md" p="sm" mb="sm" className={`clickable-row${spotted('setup')}`} onClick={() => setChecklist(true)}>
              <Group gap="xs" wrap="nowrap">
                <IconChecklist size={18} color="var(--mantine-color-yellow-7)" />
                <Text size="sm" fw={600}>{t('Finish setting up')}</Text>
                <Text size="xs" c="dimmed" ms="auto" className="tabular">{setup.notes.length - setup.todo.length}/{setup.notes.length}</Text>
              </Group>
              <Progress value={((setup.notes.length - setup.todo.length) / Math.max(1, setup.notes.length)) * 100} size="sm" mt={8} color="yellow" radius="xl" />
            </Paper>
          )}
          {PAGES.filter((page) => page.group === 'setup').map(navLink)}
          <NavLink
            label={t('This deployment')}
            leftSection={<IconServer2 size={18} stroke={1.7} />}
            active={active === 'deployment'}
            onClick={() => go({ kind: 'deployment', section: 'model' })}
            className="nav-link"
          />
          <Button
            fullWidth
            mt="xs"
            color={stopAll ? 'teal' : 'red'}
            variant={stopAll ? 'filled' : 'light'}
            leftSection={stopAll ? <IconPlayerPlay size={16} /> : <IconPlayerStop size={16} />}
            onClick={() => void toggleStop()}
            className={spotted('stop')}
          >
            {stopAll ? t('Resume everything') : t('Stop everything')}
          </Button>
          <Divider my="sm" />
          <Menu position="top-start" width={240} shadow="md">
            <Menu.Target>
              <UnstyledButton w="100%" px={6} py={4} style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                <Group gap="sm" wrap="nowrap">
                  <Avatar radius="xl" size={32} src={OWNER_PICTURE} alt="" />
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
              <Menu.Item leftSection={<IconMap size={16} />} onClick={() => setTouring(true)}>{t('Take the tour')}</Menu.Item>
              <Menu.Item color="red" leftSection={<IconAlertOctagon size={16} />} onClick={() => setCancelling(true)}>{t('Cancel every task…')}</Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>{t('Sign out')}</Menu.Item>
              {setup.version && <Menu.Label>{t('PALUGADA {version}', { version: setup.version })}</Menu.Label>}
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
        {recovered && (
          <Box bg="yellow.1" c="dark" py={8} px="lg">
            <Group justify="center" gap="sm">
              <IconKey size={18} />
              <Text size="sm" fw={600}>{t('You signed in with a recovery code. Add a passkey on this device, then take the lost phone off.')}</Text>
              {companies[0] && (
                <Button size="compact-sm" variant="white" color="dark" onClick={() => open('settings', { companyId: companies[0]!.id, section: 'security' })}>
                  {t('Open Security')}
                </Button>
              )}
            </Group>
          </Box>
        )}
        <Box className="app-content" px={{ base: 'md', sm: 'xl' }} py={{ base: 'md', sm: 'xl' }}>
          <Suspense fallback={<Center py="xl"><Loader size="sm" /></Center>}>
          {!base.data ? null : route.kind === 'deployment' ? (
            <DeploymentSettings section={route.section} />
          ) : route.kind === 'home' || !context ? (
            <Home
              companies={companies}
              openCompany={(id, page, item) => open(page, { companyId: id, item: item ?? null })}
              startCompany={() => setStarting(true)}
              restoreCompany={() => setRestoring(true)}
              setup={setup}
            />
          ) : (
            <CompanyPageView key={`${context.companyId}:${route.page}:${route.section}`} ctx={context} route={route as Extract<Route, { kind: 'company' }>} />
          )}
          </Suspense>
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
          <UnstyledButton className="bottom-tab" data-active={['team', 'memory', 'history', 'settings', 'overview', 'deployment'].includes(active) || undefined} onClick={() => setMore(true)}>
            <IconDots size={22} stroke={1.7} />
            {t('More')}
          </UnstyledButton>
        </Group>
      </AppShell.Footer>}

      <Drawer opened={more} onClose={() => setMore(false)} position="bottom" size="auto" title={company?.name} radius="lg">
        <Stack gap={4} pb="md">
          {PAGES.filter((page) => !['inbox', 'work', 'money'].includes(page.id)).map(navLink)}
          <NavLink label={t('This deployment')} leftSection={<IconServer2 size={18} stroke={1.7} />} active={active === 'deployment'}
            onClick={() => { setMore(false); go({ kind: 'deployment', section: 'model' }); }} />
          <Divider my="xs" />
          {LANGUAGES.map((one) => (
            <NavLink key={one.code} label={one.name} leftSection={<IconLanguage size={18} />} active={one.code === language()} onClick={() => void pickLanguage(one.code)} />
          ))}
          <NavLink label={colorScheme === 'dark' ? t('Light theme') : t('Dark theme')} leftSection={<IconMoon size={18} />} onClick={toggleColorScheme} />
          <NavLink label={t('Sign out')} leftSection={<IconLogout size={18} />} onClick={() => void signOut()} />
        </Stack>
      </Drawer>

      <StartCompany opened={starting} close={() => setStarting(false)} languages={base.data?.languages ?? null}
        started={(id) => { base.reload(); open('overview', { companyId: id }); setGreeting(id); }} />
      <RestoreCompany opened={restoring} close={() => setRestoring(false)} restored={(id) => { base.reload(); open('overview', { companyId: id }); }} />

      <GiveWork companyId={company?.id ?? null} opened={giving} close={() => setGiving(false)} />
      <Assistant opened={asking} onClose={() => setAsking(false)} />
      <Assistant opened={talking !== null} company={talking} onClose={() => setTalking(null)} />

      <Tour
        opened={touring}
        hasCompany={company !== null}
        finish={finishTour}
        show={(place) => (place === 'home' ? go({ kind: 'home' }) : open(place))}
        point={setSpot}
        start={() => setStarting(true)}
      />

      <Modal opened={checklist} onClose={() => setChecklist(false)} title={t('Finish setting up this deployment')} size="lg" centered>
        <Text size="sm" c="dimmed" mb="md">
          {t('What the deployment reported when it started. Each one is something switched off until it is configured: the model is set on the This deployment page, and the rest in the environment, which docs/configuration.md lists.')}
        </Text>
        <Button mb="md" variant="light" leftSection={<IconServer2 size={16} />} onClick={() => { setChecklist(false); go({ kind: 'deployment', section: 'model' }); }}>
          {t('Set the model')}
        </Button>
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
            {!compact && <Avatar radius="md" size={34} src={company ? companyEmblem(company) : '/brand/palugada-app-icon.svg'} alt="" />}
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
            leftSection={<Avatar size={22} radius="sm" src={companyEmblem(one)} alt="" />}
            rightSection={openCount[one.id] ? <Badge size="xs" color="red" circle>{openCount[one.id]}</Badge> : one.eraseAfter ? <Badge size="xs" color="red" variant="light">{t('closing')}</Badge> : one.frozen ? <Badge size="xs" color="gray">{t('frozen')}</Badge> : null}
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
interface ArchivePreview {
  company: { slug: string; name: string };
  sections: Record<string, number>;
  skipped: string[];
}

/**
 * A company back from the file the console's export downloads (F16.4): read
 * in the browser, previewed by the server -- what comes back and what does
 * not -- and restored only with the owner's device, because it creates a
 * company. Nothing is kept in the browser after it is sent.
 */
function RestoreCompany({ opened, close, restored }: { opened: boolean; close: () => void; restored: (id: string) => void }) {
  const requireFactor = useFactor();
  const [archive, setArchive] = useState<unknown>(null);
  const [preview, setPreview] = useState<ArchivePreview | null>(null);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const reset = () => { setArchive(null); setPreview(null); setName(''); setSlug(''); setError(null); };
  const choose = async (file: File | null) => {
    reset();
    if (!file) return;
    setReading(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const answer: { preview: ArchivePreview } = await api('POST', '/api/companies/import', { archive: parsed, preview: true });
      setArchive(parsed);
      setPreview(answer.preview);
      setName(answer.preview.company.name);
      setSlug(`${answer.preview.company.slug}-restored`);
    } catch (failure) {
      setError(failure instanceof SyntaxError ? t('That file is not an export from this console.') : explain(failure));
    } finally {
      setReading(false);
    }
  };
  const submit = async () => {
    setError(null);
    let answer: { companyId?: string } = {};
    try {
      const done = await requireFactor(t('Restore {company}', { company: name || slug }), async (proof) => {
        answer = await api('POST', '/api/companies/import', { archive, slug, name, proof });
      });
      if (!done) return;
      notifications.show({ color: 'teal', message: t('{company} is restored.', { company: name || slug }) });
      reset();
      close();
      if (answer.companyId) restored(answer.companyId);
    } catch (failure) {
      setError(explain(failure));
    }
  };
  const rows = preview ? Object.values(preview.sections).reduce((total, count) => total + count, 0) : 0;

  return (
    <Modal opened={opened} onClose={() => { reset(); close(); }} title={t('Restore a company')} centered size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          {t('From the file a company\'s export downloads, on this deployment or another. It comes back as a new company beside any that exist; credentials come back as references to set up again, and skills from outside come back quarantined.')}
        </Text>
        <FileInput label={t('Export file')} placeholder={t('Choose the .json file')} accept="application/json,.json" onChange={(file) => void choose(file)} clearable disabled={reading} />
        {preview && (
          <Alert variant="light" color="brand" title={t('{company}: {rows} rows in {sections} sections', {
            company: preview.company.name, rows, sections: Object.keys(preview.sections).length,
          })}>
            {preview.skipped.length > 0 && (
              <Text size="sm">{t('Not restored: {sections}.', { sections: preview.skipped.join(', ') })}</Text>
            )}
          </Alert>
        )}
        {preview && (
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('Name')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
            <TextInput label={t('Short name')} description={t('Used in links and exports')} value={slug} onChange={(e) => setSlug(e.currentTarget.value)} required />
          </SimpleGrid>
        )}
        {error && <Text c="red" size="sm">{error}</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => { reset(); close(); }}>{t('Cancel')}</Button>
          <Button disabled={!preview || !slug} onClick={() => void submit()}>{t('Restore it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/**
 * A company is asked its languages as it starts (N7). Left alone, it took the
 * deployment's default, which is English until the owner finds Settings: an
 * owner who wrote to the panel in Indonesian got a company whose agents
 * answered in English. Both start in the language the panel is in now.
 */
/** The time zone the owner's browser is in, or null where it does not say. */
function ownTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function StartCompany({ opened, close, started, languages }: {
  opened: boolean; close: () => void; started: (id: string) => void; languages: Languages | null;
}) {
  const requireFactor = useFactor();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [runsItself, setRunsItself] = useState(true);
  // Null until chosen: the panel's language, which the owner may change while
  // the form is open.
  const [work, setWork] = useState<string | null>(null);
  const [talk, setTalk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const supported = (languages?.supported ?? []).map((one) => ({
    value: one.code, label: one.native === one.name ? one.name : `${one.native} · ${one.name}`,
  }));
  const panel = supported.some((one) => one.value === language()) ? language() : null;
  const workLanguage = work ?? panel;
  const talkLanguage = talk ?? panel;

  const submit = async () => {
    setError(null);
    let created: { companyId?: string } = {};
    try {
      const done = await requireFactor(t('Start {company}', { company: name }), async (proof) => {
        created = await api('POST', '/api/companies', {
          templateSlug: 'standard-company', companySlug: slug, name, proof,
          // Its schedules run on the owner's clock, not UTC (the weekly
          // review at 07:45 on Monday is the owner's Monday morning).
          ...(ownTimeZone() ? { timezone: ownTimeZone() } : {}),
          ...(workLanguage ? { workLanguage } : {}),
          ...(talkLanguage ? { talkLanguage } : {}),
          // company-os: a strategist, a weekly review and the operating skills.
          ...(runsItself ? { bundles: ['company-os'] } : {}),
        });
      });
      if (!done) return;
      notifications.show({ color: 'teal', message: t('{company} is running.', { company: name }) });
      close();
      setName('');
      setSlug('');
      setWork(null);
      setTalk(null);
      if (created.companyId) started(created.companyId);
    } catch (failure) {
      setError(explain(failure));
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Start a company')} centered>
      <Stack>
        <Text size="sm" c="dimmed">
          {t('Built from the standard template: operations, delivery, growth, finance, support, assurance and a lab, with a role in each. The coordinator routes work you give without naming a role. A capability that needs an outside account waits until you bind one.')}
        </Text>
        <TextInput label={t('Name')} placeholder={t('e.g. Kopi Nusantara')} value={name} onChange={(e) => {
          const value = e.currentTarget.value;
          setName(value);
          setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        }} required />
        <TextInput label={t('Short name')} description={t('Used in links and exports')} value={slug} onChange={(e) => setSlug(e.currentTarget.value)} required />
        {supported.length > 0 && (
          <>
            <Select
              label={t('Work language')}
              description={t('What it produces: documents, emails, content for customers, code comments.')}
              data={supported}
              value={workLanguage}
              onChange={setWork}
              searchable
              allowDeselect={false}
            />
            <Select
              label={t('Talk language')}
              description={t('What its agents write to you and to each other: approvals, questions, reports, handoffs.')}
              data={supported}
              value={talkLanguage}
              onChange={setTalk}
              searchable
              allowDeselect={false}
            />
          </>
        )}
        <Switch
          checked={runsItself}
          onChange={(e) => setRunsItself(e.currentTarget.checked)}
          label={t('Let it run itself')}
          description={t('Adds a strategist who reviews the week every Monday and proposes what to do next. Nothing it proposes happens without you.')}
        />
        {error && <Text c="red" size="sm">{error}</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={!name || !slug} onClick={() => void submit()}>{t('Start it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
