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
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionIcon, Alert, AppShell, Avatar, Badge, Box, Button, Center, Divider, Drawer, FileInput, Group, Loader, Menu, Modal,
  NavLink, Paper, ScrollArea, SimpleGrid, Stack, Text, TextInput, Tooltip, UnstyledButton,
  useComputedColorScheme, useDirection, useMantineColorScheme,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { Spotlight, spotlight, type SpotlightActionData } from '@mantine/spotlight';
import {
  IconActivity, IconAlertOctagon, IconBrain, IconBuildingStore, IconCheck, IconChecklist, IconChevronDown,
  IconBook2, IconCoin, IconCompass, IconDots, IconHistory, IconHome, IconInbox, IconKey, IconLanguage, IconLayoutDashboard, IconLogout, IconMap, IconMessageCircle, IconMessages, IconWorldWww,
  IconMoon, IconPlayerPlay, IconPlayerStop, IconPlus, IconSearch, IconSparkles, IconServer2, IconSettings, IconSitemap, IconSun,
  IconUserCircle,
} from '@tabler/icons-react';
import { ApiError, api, explain, setToken, whenSignedOut } from './api.ts';
import { useFactor } from './factor.tsx';
import { useLoad } from './hooks.ts';
import { LANGUAGES, N, direction, isLanguage, language, setLanguage, t, tp, useLanguage, type Language } from './i18n.ts';
import { go, openResolvedNotice, takeLinkedNotice, takeLinkedRoute, takeLinkedTalk, useRoute, type CompanyPage, type Route, type SettingsSection } from './router.ts';
import type { Company, Languages, SearchHit, SetupReport, Staff, Structure } from './types.ts';
import type { SearchHit as RoomHit } from './workspace/types.ts';
import { companyEmblem, OWNER_PICTURE, personPicture, rolePicture } from './images.ts';
import { ChooseHandle, kindLabel, ProfileDrawer, useProfile, type Profile } from './workspace/Profile.tsx';
import type { Unread } from './workspace/types.ts';
import { badgeOf, useUnread } from './workspace/unread.ts';
import { useTabNotices } from './workspace/notifyInTab.ts';
import { useRoomPulse, whenRoomStreamReopens } from './workspace/useRoomStream.ts';
import { SignIn } from './pages/SignIn.tsx';
import { Home } from './pages/Home.tsx';
import { Onboarding } from './pages/Onboarding.tsx';
// A company's pages and the deployment's settings, each fetched when it is
// first opened. The sign-in page and Home are the only ones every visit
// needs; the charts alone -- drawn on Overview and Money -- were 130 KB
// gzipped that the sign-in page fetched and never used.
const DeploymentSettings = lazy(() => import('./pages/Deployment.tsx').then((module) => ({ default: module.DeploymentSettings })));
const Decisions = lazy(() => import('./pages/Decisions.tsx').then((module) => ({ default: module.Decisions })));
const Rooms = lazy(() => import('./pages/Rooms.tsx').then((module) => ({ default: module.Rooms })));
const Overview = lazy(() => import('./pages/Overview.tsx').then((module) => ({ default: module.Overview })));
const Plan = lazy(() => import('./pages/Plan.tsx').then((module) => ({ default: module.Plan })));
const Work = lazy(() => import('./pages/Work.tsx').then((module) => ({ default: module.Work })));
const Customers = lazy(() => import('./pages/Customers.tsx').then((module) => ({ default: module.Customers })));
const Books = lazy(() => import('./pages/Books.tsx').then((module) => ({ default: module.Books })));
const Browser = lazy(() => import('./pages/Browser.tsx').then((module) => ({ default: module.Browser })));
const Organization = lazy(() => import('./pages/Organization.tsx').then((module) => ({ default: module.Organization })));
const Memory = lazy(() => import('./pages/Memory.tsx').then((module) => ({ default: module.Memory })));
const Money = lazy(() => import('./pages/Money.tsx').then((module) => ({ default: module.Money })));
const History = lazy(() => import('./pages/History.tsx').then((module) => ({ default: module.History })));
const SettingsHub = lazy(() => import('./pages/SettingsHub.tsx').then((module) => ({ default: module.SettingsHub })));
import { AssignWork } from './components/AssignWork.tsx';
import { Assistant } from './components/Assistant.tsx';
import { Tour, type TourSpot } from './components/Tour.tsx';
import { setMoneyDisplay, useMoneyDisplay } from './format.ts';

/**
 * The pages of one company, as the sidebar offers them. `owner` marks one a
 * staff seat is not shown: the company's browser holds its sign-ins.
 */
/** `about` is said under each page's name, so nobody has to open one to learn what it is for. */
const PAGES: Array<{ id: CompanyPage; label: string; about: string; icon: typeof IconInbox; group: 'decide' | 'company' | 'setup'; owner?: true }> = [
  { id: 'inbox', label: N('Inbox'), about: N('What waits for your decision'), icon: IconInbox, group: 'decide' },
  { id: 'rooms', label: N('Rooms'), about: N('Talk with your team, and ask for work where you talk'), icon: IconMessageCircle, group: 'company' },
  { id: 'overview', label: N('Overview'), about: N('How the company is doing'), icon: IconLayoutDashboard, group: 'company' },
  { id: 'plan', label: N('Plan'), about: N('The vision, and the plan that serves it'), icon: IconCompass, group: 'company' },
  { id: 'work', label: N('Work'), about: N('What the team is doing now'), icon: IconActivity, group: 'company' },
  { id: 'customers', label: N('Customers'), about: N('Conversations with your customers'), icon: IconMessages, group: 'company' },
  { id: 'books', label: N('Books'), about: N('Money in, money out, and who owes whom'), icon: IconBook2, group: 'company' },
  { id: 'browser', label: N('Browser'), about: N('The browser the team works in'), icon: IconWorldWww, group: 'company', owner: true },
  { id: 'team', label: N('Team'), about: N('Roles, goals, schedules and rules'), icon: IconSitemap, group: 'company' },
  { id: 'memory', label: N('Memory'), about: N('What the company has learned'), icon: IconBrain, group: 'company' },
  { id: 'money', label: N('Money'), about: N('Budgets and what was spent'), icon: IconCoin, group: 'company' },
  { id: 'history', label: N('History'), about: N('Everything that happened'), icon: IconHistory, group: 'company' },
  { id: 'settings', label: N('Settings'), about: N('Hours, languages and security'), icon: IconSettings, group: 'setup' },
];

/**
 * The pages drawn edge to edge and the whole height of the screen, rather
 * than in the padded column every other page sits in: the rooms, whose
 * composer is pinned to the foot (STATUS 2.207). Kept apart from `PAGES`,
 * whose one-line form the page test reads.
 */
const FULL_PAGES: ReadonlySet<CompanyPage> = new Set(['rooms']);

export function App() {
  const [device, setDevice] = useState<string | null>(null);
  // Which kind of factor signed in: after a recovery code, the console asks for a new device.
  const [factor, setFactor] = useState<string | null>(null);
  // A staff seat beside the owner (0110), or null for the owner: asked once
  // signed in, before the console draws anything that is the owner's.
  const [staff, setStaff] = useState<Staff | null>(null);
  const lang = useLanguage();
  const reading = useMoneyDisplay();
  // Mantine mirrors its components from its own direction, set here as the
  // language changes; the page's `dir` is set with the language (i18n.ts).
  const { setDirection } = useDirection();
  useEffect(() => { setDirection(direction()); }, [lang, setDirection]);
  useEffect(() => { takeLinkedRoute(); }, []);
  useEffect(() => whenSignedOut(() => setDevice(null)), []);
  // The server ends a member of staff's streams when the owner changes what
  // they may do; once the stream is back, who they are is read again, and the
  // console draws the controls of their new kind without a reload (STATUS 2.210).
  useEffect(() => whenRoomStreamReopens(() => {
    void api('GET', '/api/me').then((me: { staff: Staff | null }) => {
      setStaff((now) => (now && me.staff && now.kind === me.staff.kind && now.name === me.staff.name ? now : me.staff));
    }, () => undefined);
  }), []);

  if (!device) {
    return <SignIn key={lang} onSignedIn={(session) => {
      setToken(session.token);
      void api('GET', '/api/me').then((me: { staff: Staff | null }) => {
        setStaff(me.staff);
        setFactor(session.factor);
        setDevice(me.staff ? me.staff.name : session.factor === 'recovery' ? t('Recovery code') : session.device);
      }, (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }));
    }} />;
  }
  return (
    <Console
      key={`${lang}:${reading}`}
      device={device}
      staff={staff}
      recovered={factor === 'recovery'}
      signOut={async () => {
        await api('POST', '/api/auth/sign-out', {}).catch(() => undefined);
        setToken(null);
        setDevice(null);
        setStaff(null);
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
  /** Open the conversation with this company's CEO, with `draft` waiting in the box to send or change. */
  talk: (draft?: string) => void;
  /** A staff seat signed in (0110), or null for the owner: a page leaves out what is the owner's. */
  staff: Staff | null;
  /** The person signed in, as their profile says (F19.2): a seat's principal, handle and picture. */
  me: Profile | null;
  openProfile: () => void;
  /** What waits in each company, as `/api/rooms/unread` last said (F19.10). */
  unread: Unread[];
  /** Read the waiting counts again now: a room was read, or a message sent. */
  refreshUnread: () => void;
  /** On a phone, an open room has the whole screen: no shell header, no tab bar (F19.16). */
  setImmersive: (on: boolean) => void;
}

export interface PageProps {
  ctx: ConsoleContext;
  route: Extract<Route, { kind: 'company' }>;
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

function Console({ device, staff, recovered, signOut }: {
  device: string; staff: Staff | null; recovered: boolean; signOut: () => Promise<void>;
}) {
  // A staff seat (0110): the owner's controls are not drawn for it. The API
  // refuses them anyway; drawn, each would only be a refusal to press.
  const owner = staff === null;
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
  // What the owner was given to say when the conversation opened: theirs to send or change.
  const [draft, setDraft] = useState<string | null>(null);
  // A company just started, whose CEO has spoken first (its first hour):
  // the conversation opens once the company is in the list.
  const [greeting, setGreeting] = useState<string | null>(null);
  const [checklist, setChecklist] = useState(false);
  const [touring, setTouring] = useState(false);
  // Whether the tour has never been taken or skipped, which the menu says.
  const [tourNew, setTourNew] = useState(false);
  const [spot, setSpot] = useState<TourSpot | null>(null);
  const spotted = (name: TourSpot) => (spot === name ? ' tour-spot' : '');
  // The person signed in, as they set themselves (F19.2, F19.22): a seat's
  // language, handle and picture, and the profile drawer everyone keeps.
  const me = useProfile();
  const [profiling, setProfiling] = useState(false);
  // A room open on a phone, which has the whole screen (Rooms.tsx).
  const [immersive, setImmersive] = useState(false);

  const base = useLoad(async () => {
    const [{ companies }, control, setup, languages, money]: [
      { companies: Company[] }, { stopAll: boolean }, SetupReport, Languages,
      { currency: string | null; rate: number | null },
    ] = await Promise.all([
      api('GET', '/api/companies'),
      owner ? api('GET', '/api/control') : Promise.resolve({ stopAll: false }),
      owner ? api('GET', '/api/control/setup') : Promise.resolve({ notes: [], todo: [] }),
      api('GET', '/api/control/languages'),
      api('GET', '/api/control/money-display'),
    ]);
    return { companies, stopAll: control.stopAll, setup, languages, money };
  }, [], { every: 30_000 });

  // The tour is the owner's to take, not laid over the first thing they see:
  // it used to open by itself, eight steps over an empty page, before there was
  // a company for any of them to point at. Asked for once at sign-in, so the
  // menu can say it has never been taken.
  useEffect(() => {
    if (!owner) return;
    void api('GET', '/api/control/tour').then(
      (tour: { finishedAt: string | null }) => setTourNew(tour.finishedAt === null),
      () => undefined,
    );
  }, []);
  const finishTour = useCallback(() => {
    setTouring(false);
    setTourNew(false);
    void api('POST', '/api/control/tour', { finished: true }).catch(() => undefined);
  }, []);

  // The deployment's choice wins over the browser's once the owner is in. A
  // member of staff reads in the language they chose, when they chose one
  // (F19.22), and the deployment's otherwise; theirs is waited for, so the
  // console is not drawn in one and then the other.
  useEffect(() => {
    const chosen = base.data?.languages.console;
    const wanted = staff ? (me.data ? (isLanguage(me.data.language) ? me.data.language : chosen) : null) : chosen;
    if (isLanguage(wanted) && wanted !== language()) setLanguage(wanted);
    // No choice yet: the console has been drawn in the browser's language, and
    // the deployment has never been told. Everything the server writes for the
    // owner -- the CEO's first words, a push, a card -- and every agent that has
    // not been given a language of its own follows what it is told here, so a
    // panel in Indonesian beside a team greeting in English was the deployment
    // not knowing what the owner was reading. Said once, as the browser's.
    if (owner && base.data && chosen === null) {
      void chooseLanguage(language()).then(() => base.reload(), () => undefined);
    }
    // And the currency the owner reads money in (0106), which redraws the
    // console as a language does when it changes.
    const money = base.data?.money;
    if (money) setMoneyDisplay(money.currency && money.rate ? { currency: money.currency, rate: money.rate } : null);
  }, [base.data, me.data]);

  const companies = base.data?.companies ?? [];
  const stopAll = base.data?.stopAll ?? false;
  const refreshCompanies = useCallback(async () => { base.reload(); }, [base]);

  const routed = route.kind === 'company' ? companies.find((one) => one.id === route.companyId) ?? null : null;
  useEffect(() => { if (routed) setLastCompany(routed.id); }, [routed]);
  const company = routed ?? companies.find((one) => one.id === lastCompany) ?? companies[0] ?? null;

  // The company in view's room stream, held by the shell so a tab holds it once on every page (STATUS 2.210): its
  // changes read the badges again at once, and a hidden tab tells its person of a direct message or a mention.
  const attention = useRoomPulse(company?.id ?? null, (frame) => 'room' in frame && frame.kind !== 'reaction' && frame.kind !== 'pin');
  useTabNotices(company?.id ?? null, me.data ? { principal: me.data.principal, notifyInTab: me.data.notifyInTab } : null);
  // What waits in each company: the Rooms badge, the company menu's, the tab's title, and the owner's inbox count.
  const unread = useUnread(attention.pulse);

  // A company just started or restored is in the address before the list read again has it: until it does, it
  // is not taken for one that no longer exists.
  const [arriving, setArriving] = useState<string | null>(null);
  useEffect(() => {
    if (arriving && companies.some((one) => one.id === arriving)) setArriving(null);
  }, [arriving, companies]);

  // A company in the address that no longer exists: back to the portfolio.
  useEffect(() => {
    if (base.data && route.kind === 'company' && !routed && route.companyId !== arriving) go({ kind: 'home' }, { replace: true });
  }, [base.data, route, routed, arriving]);

  // Opened from a relay's notice: its link names only a handle, which the
  // server answers with where it opens now that its person has signed in
  // (STATUS section 2.216); to anyone else it opens nothing, and says so.
  useEffect(() => {
    const handle = takeLinkedNotice();
    if (!handle) return;
    api('GET', `/api/relays/notices/${encodeURIComponent(handle)}`).then(
      (opens: Parameters<typeof openResolvedNotice>[0]) => openResolvedNotice(opens),
      (failure: unknown) => {
        openResolvedNotice(null);
        notifications.show({ color: 'red', message: explain(failure) });
      },
    );
  }, []);

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
  // A member of staff lands on the rooms, where their work with the company is; the owner keeps their own page.
  const landed = useRef(false);
  useEffect(() => {
    if (landed.current || !staff || !base.data) return;
    landed.current = true;
    if (route.kind === 'home') go({ kind: 'company', companyId: staff.companyId, page: 'rooms', section: 'company', item: null }, { replace: true });
  }, [base.data]);

  // To a company just started or restored: its overview, once the list is read again.
  const arrive = (id: string) => {
    setArriving(id);
    base.reload();
    open('overview', { companyId: id });
  };

  const context = useMemo<ConsoleContext | null>(() => (company ? {
    companyId: company.id,
    company,
    companies,
    open: (page, options) => open(page, options),
    refreshCompanies,
    setOpenCount: (count: number) => setOpenCount((current) => (current[company.id] === count ? current : { ...current, [company.id]: count })),
    giveWork: () => setGiving(true),
    talk: (said?: string) => {
      // Only words: a handler that passes its click event on opens it empty.
      setDraft(typeof said === 'string' ? said : null);
      setTalking(company);
    },
    staff,
    me: me.data,
    openProfile: () => setProfiling(true),
    unread: unread.data ?? [],
    refreshUnread: unread.reload,
    setImmersive,
  } : null), [company, companies, open, refreshCompanies, staff, me.data, unread.data, unread.reload]);

  // The owner's inbox count is the server's, read with the rooms' (F19.10): it no longer waits for the inbox to
  // be opened. The inbox still says it at once when it is.
  useEffect(() => {
    if (!owner || !unread.data) return;
    setOpenCount((current) => {
      const next = { ...current };
      for (const one of unread.data!) if (one.openCount !== null) next[one.companyId] = one.openCount;
      return next;
    });
  }, [unread.data]);
  // What is addressed to the person, everywhere they are: in the tab's title, and on an installed app's icon.
  const waiting = (unread.data ?? []).reduce((total, one) => total + badgeOf(one), 0);
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) PALUGADA` : 'PALUGADA';
    const app = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (waiting > 0) void app.setAppBadge?.(waiting).catch(() => undefined);
    else void app.clearAppBadge?.().catch(() => undefined);
  }, [waiting]);

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
      // The deployment's language is the owner's; a member of staff's is their own.
      // Read again, so the profile drawer opens with the choice made here.
      if (staff) {
        await api('POST', '/api/me/profile', { language: code });
        me.reload();
        setLanguage(code);
      } else await chooseLanguage(code);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const spotlightActions: SpotlightActionData[] = [
    ...(owner ? [{ id: 'ask', label: t('Ask PALUGADA'), description: t('Say what you want; it sets things up with you'), leftSection: <IconSparkles size={18} />, onClick: () => setAsking(true) }] : []),
    ...(owner && company?.ceo ? [{
      id: 'talk', label: t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug }),
      description: t('The one who runs {company} for you', { company: company.name }),
      leftSection: <Avatar size={18} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />, onClick: () => setTalking(company),
    }] : []),
    { id: 'home', label: t('Home'), description: t('Every company at a glance'), leftSection: <IconHome size={18} />, onClick: () => go({ kind: 'home' }) },
    ...PAGES.filter((page) => owner || !page.owner).map((page) => ({
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
    { id: 'start-company', label: t('Start a company'), description: t('Starts with a CEO, who builds the team'), leftSection: <IconBuildingStore size={18} />, onClick: () => setStarting(true) },
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
    // The search reads every company, so a staff seat jumps to pages only.
    if (text.length < 2 || !owner) {
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
  // What people said that matches (STATUS 2.212), asked of the rooms' own
  // search, which runs as the person: every company's for the owner, the
  // seat's own company's for a member of staff. Never through `/api/search`,
  // which the owner's assistant may read.
  const [said, setSaid] = useState<Array<{ companyId: string; company: string; hits: RoomHit[] }>>([]);
  // Each search counts towards the person's searches a minute (STATUS 2.217):
  // past them the palette says so, rather than look as if nothing matched.
  const [saidRefused, setSaidRefused] = useState<string | null>(null);
  useEffect(() => {
    const text = query.trim();
    const seatCompany = staff?.companyId ?? null;
    if (text.length < 2 || (!owner && !seatCompany)) {
      setSaid([]);
      setSaidRefused(null);
      return;
    }
    const words = `q=${encodeURIComponent(text)}`;
    const timer = setTimeout(() => {
      (owner
        ? api('GET', `/api/room-search?${words}`).then((answer: { found: Array<{ companyId: string; company: string; hits: RoomHit[] }> }) => answer.found)
        : api('GET', `/api/companies/${seatCompany}/room-search?${words}`)
          .then((answer: { hits: RoomHit[] }) => [{ companyId: seatCompany!, company: '', hits: answer.hits.slice(0, 8) }]))
        .then((found) => {
          setSaid(found);
          setSaidRefused(null);
        }, (failure: unknown) => {
          setSaid([]);
          setSaidRefused(failure instanceof ApiError && failure.code === 'workspace.too_fast' ? explain(failure) : null);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);
  const refusedActions: SpotlightActionData[] = saidRefused ? [{ id: 'said-refused', label: saidRefused, disabled: true }] : [];
  const saidActions: SpotlightActionData[] = said.flatMap((one) => one.hits.map((hit) => ({
    id: `said-${hit.messageId}`,
    label: hit.excerpt,
    description: [hit.author.principal === 'owner' ? t('Owner') : hit.author.name ?? '', one.company].filter(Boolean).join(' · '),
    leftSection: <Avatar size={18} radius="xl" src={personPicture(hit.author.principal, hit.author.picture)} alt="" />,
    // Opened in its thread, where a reply is read and a message is drawn with what was said around it.
    onClick: () => open('rooms', { companyId: one.companyId, item: `${hit.roomId}~${hit.threadOf ?? hit.messageId}` }),
  })));
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

  const setup: SetupReport = base.data?.setup ?? { notes: [], todo: [] };
  const inboxCount = company ? openCount[company.id] ?? 0 : 0;
  const roomsCount = company ? badgeOf((unread.data ?? []).find((one) => one.companyId === company.id)) : 0;
  const active = route.kind === 'company' ? route.page : route.kind;

  /**
   * A page's link. Said under its name where there is room to scroll -- the
   * phone's menu -- and in a tooltip in the sidebar, where each line costs a
   * page that would otherwise be out of sight: at 800 pixels high the sidebar
   * showed four of its eleven pages and hid the rest below the fold.
   */
  const navLink = (page: (typeof PAGES)[number], inline = false) => {
    const link = (
      <NavLink
        key={inline ? page.id : undefined}
        label={t(page.label)}
        {...(inline ? { description: t(page.about) } : { py: 7 })}
        leftSection={<page.icon size={18} stroke={1.7} />}
        rightSection={page.id === 'inbox' && inboxCount > 0 ? <Badge size="sm" color="red" circle>{inboxCount}</Badge>
          : page.id === 'rooms' && roomsCount > 0
            ? <Badge data-badge="rooms" size="sm" color="red" circle aria-label={tp('{count} message for you', '{count} messages for you', roomsCount)}>{roomsCount}</Badge>
            : null}
        active={active === page.id}
        onClick={() => open(page.id)}
        className={`nav-link${spotted(page.id as TourSpot)}`}
      />
    );
    return inline ? link : <Tooltip key={page.id} label={t(page.about)} position="right" withArrow openDelay={400}>{link}</Tooltip>;
  };

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

  // A deployment with no company: not a shell of pages with nothing in them,
  // but the one thing to do (Onboarding.tsx). The deployment's own page is
  // still one press away, for an owner who came to set the model or a channel.
  if (owner && base.data && companies.length === 0 && route.kind !== 'deployment') {
    return (
      <Box mih="100vh">
        <Group justify="space-between" px="lg" py="md" wrap="nowrap">
          <img
            className="brand-lockup"
            src={colorScheme === 'dark' ? '/brand/palugada-lockup-on-dark.svg' : '/brand/palugada-lockup.svg'}
            alt="PALUGADA"
            height={26}
          />
          <Menu position="bottom-end" width={240} shadow="md">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" size="lg" aria-label={t('Menu')}><IconDots size={18} /></ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {languageMenu}
              <Menu.Divider />
              <Menu.Item leftSection={<IconServer2 size={16} />} onClick={() => go({ kind: 'deployment', section: 'model' })}>{t('This deployment')}</Menu.Item>
              <Menu.Item leftSection={colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />} onClick={toggleColorScheme}>
                {colorScheme === 'dark' ? t('Light theme') : t('Dark theme')}
              </Menu.Item>
              <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>{t('Sign out')}</Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
        <Box px="md" py={{ base: 'md', sm: 48 }}>
          <Onboarding
            languages={base.data.languages}
            setup={base.data.setup}
            reloadSetup={base.reload}
            restore={() => setRestoring(true)}
            started={(id) => { arrive(id); setGreeting(id); }}
          />
        </Box>
        <RestoreCompany opened={restoring} close={() => setRestoring(false)} restored={(id) => arrive(id)} />
      </Box>
    );
  }

  return (
    <AppShell
      navbar={{ width: 264, breakpoint: 'sm', collapsed: { mobile: true } }}
      // The phone's own header and tab bar exist only on a phone: collapsed
      // rather than absent, they still sat just past the bottom of the screen.
      // A room open on a phone has neither: it is the whole screen, with its
      // own way back (Rooms.tsx).
      {...(mobile && !immersive ? { header: { height: 56 }, footer: { height: 64 } } : {})}
      data-immersive={(mobile && immersive) || undefined}
      padding={0}
    >
      <Spotlight
        query={query}
        onQueryChange={setQuery}
        // The pages and commands that match, then what the search found --
        // which matched on the server, perhaps in a result the title does
        // not show, so it is not filtered again here.
        actions={[...spotlightActions.filter(matches), ...(foundActions.length > 0 ? [{ group: t('Found'), actions: foundActions }] : []),
          ...(saidActions.length + refusedActions.length > 0 ? [{ group: t('Messages'), actions: [...saidActions, ...refusedActions] }] : [])]}
        filter={(_, actions) => actions}
        nothingFound={t('Nothing matches')}
        highlightQuery
        searchProps={{ leftSection: <IconSearch size={18} />, placeholder: t('Go to a page, switch company, or do something…') }}
        shortcut={['mod + K', '/']}
      />

      {mobile && !immersive && <AppShell.Header px="md">
        <Group h="100%" justify="space-between" wrap="nowrap">
          <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
            <img className="brand-mark" src="/brand/palugada-app-icon.svg" alt="" width={30} height={30} />
            <CompanyMenu companies={companies} company={company} openCount={openCount} unread={unread.data ?? []} compact
              pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={owner ? () => setStarting(true) : null} />
          </Group>
          <Group gap={6} wrap="nowrap">
            {owner && company?.ceo && (
              <ActionIcon variant="default" size="lg" radius="xl" onClick={() => setTalking(company)}
                aria-label={t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug })}>
                <Avatar size={26} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />
              </ActionIcon>
            )}
            {owner && <ActionIcon variant="light" size="lg" onClick={() => setAsking(true)} aria-label={t('Ask PALUGADA')}><IconSparkles size={18} /></ActionIcon>}
            <ActionIcon variant="subtle" size="lg" onClick={() => spotlight.open()} aria-label={t('Search')}><IconSearch size={18} /></ActionIcon>
            {owner && (
              <ActionIcon variant={stopAll ? 'filled' : 'light'} color={stopAll ? 'teal' : 'red'} size="lg" onClick={() => void toggleStop()} aria-label={stopAll ? t('Resume everything') : t('Stop everything')}>
                {stopAll ? <IconPlayerPlay size={18} /> : <IconPlayerStop size={18} />}
              </ActionIcon>
            )}
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
          <CompanyMenu companies={companies} company={company} openCount={openCount} unread={unread.data ?? []}
            pick={(id) => open(route.kind === 'company' ? route.page : 'inbox', { companyId: id })} start={owner ? () => setStarting(true) : null} />
          {owner && <Menu position="bottom-start" width="target" shadow="md">
            <Menu.Target>
              <Button fullWidth mt="sm" size="sm" leftSection={<IconPlus size={16} />} justify="flex-start" className={spotted('new')}>{t('New')}</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconActivity size={16} />} onClick={() => setGiving(true)} disabled={!company}>{t('Give a role work')}</Menu.Item>
              <Menu.Item leftSection={<IconSitemap size={16} />} onClick={() => open('team')} disabled={!company}>{t('Schedule, goal or policy')}</Menu.Item>
              <Menu.Item leftSection={<IconBuildingStore size={16} />} onClick={() => setStarting(true)}>{t('Start a company')}</Menu.Item>
            </Menu.Dropdown>
          </Menu>}
          {owner && company?.ceo && (
            <Tooltip label={t('Ask about this company, or have something done. The CEO runs the team.')} multiline w={240} withArrow position="right">
              <Button fullWidth mt={6} size="sm" variant="default" justify="flex-start" onClick={() => setTalking(company)}
                leftSection={<Avatar size={20} radius="xl" src={rolePicture(company.ceo.slug, 'CEO')} alt="" />}>
                <Text size="sm" fw={600} truncate>{t('Talk to {name}, CEO', { name: company.ceo.displayName ?? company.ceo.slug })}</Text>
              </Button>
            </Tooltip>
          )}
          {owner && (
            <Tooltip label={t('For everything beyond one company: the model, the channels, and new companies.')} multiline w={240} withArrow position="right">
              <Button fullWidth mt={6} size="sm" variant="light" leftSection={<IconSparkles size={16} />} justify="flex-start" onClick={() => setAsking(true)}>
                {t('Ask PALUGADA')}
              </Button>
            </Tooltip>
          )}
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} type="auto" offsetScrollbars="y" mt="sm">
          <NavLink label={t('Home')} py={7} leftSection={<IconHome size={18} stroke={1.7} />} active={active === 'home'} onClick={() => go({ kind: 'home' })} className={`nav-link${spotted('home')}`} />
          {/* Until there is a company there is nothing for these pages to show:
              the first thing to do is on Home, and the deployment's own page. */}
          {company && PAGES.filter((page) => page.group === 'decide').map((page) => navLink(page))}
          {company && <div className="nav-section-label">{company.name}</div>}
          {company && PAGES.filter((page) => page.group === 'company' && (owner || !page.owner)).map((page) => navLink(page))}
          {owner && company && <Divider my="xs" />}
          {owner && company && PAGES.filter((page) => page.group === 'setup').map((page) => navLink(page))}
          {owner && <NavLink
            label={t('This deployment')}
            py={7}
            leftSection={<IconServer2 size={18} stroke={1.7} />}
            active={active === 'deployment'}
            onClick={() => go({ kind: 'deployment', section: 'model' })}
            className="nav-link"
          />}
        </AppShell.Section>

        <AppShell.Section>
          {setup.todo.length > 0 && (
            // One line, not a card with a bar: pinned under the pages, a card
            // took the room of two of them, and the deployment's optional notes
            // (a push channel, an email channel) keep it there for good.
            <Paper withBorder radius="md" px="sm" py={6} mb="xs" className={`clickable-row${spotted('setup')}`} onClick={() => setChecklist(true)}>
              <Group gap="xs" wrap="nowrap">
                <IconChecklist size={16} color="var(--mantine-color-yellow-7)" />
                <Text size="sm" fw={600}>{t('Finish setting up')}</Text>
                <Text size="xs" c="dimmed" ms="auto" className="tabular">{setup.notes.length - setup.todo.length}/{setup.notes.length}</Text>
              </Group>
            </Paper>
          )}
          {owner && <Button
            fullWidth
            color={stopAll ? 'teal' : 'red'}
            variant={stopAll ? 'filled' : 'light'}
            leftSection={stopAll ? <IconPlayerPlay size={16} /> : <IconPlayerStop size={16} />}
            onClick={() => void toggleStop()}
            className={spotted('stop')}
          >
            {stopAll ? t('Resume everything') : t('Stop everything')}
          </Button>}
          <Divider my="sm" />
          <Menu position="top-start" width={240} shadow="md">
            <Menu.Target>
              <UnstyledButton w="100%" px={6} py={4} style={{ borderRadius: 'var(--mantine-radius-md)' }}>
                <Group gap="sm" wrap="nowrap">
                  <Avatar radius="xl" size={32} src={staff ? personPicture(me.data?.principal ?? 'seat:', me.data?.picture) : OWNER_PICTURE} alt="" />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Text size="sm" fw={600} truncate>{staff ? staff.name : t('Owner')}</Text>
                    <Text size="xs" c="dimmed" truncate>
                      {staff ? `${kindLabel(staff.kind)}${me.data?.handle ? ` · @${me.data.handle}` : ''}` : device}
                    </Text>
                  </div>
                  <IconDots size={16} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item leftSection={<IconUserCircle size={16} />} onClick={() => setProfiling(true)}>{t('Your profile')}</Menu.Item>
              <Menu.Divider />
              {languageMenu}
              <Menu.Divider />
              <Menu.Item leftSection={colorScheme === 'dark' ? <IconSun size={16} /> : <IconMoon size={16} />} onClick={toggleColorScheme}>
                {colorScheme === 'dark' ? t('Light theme') : t('Dark theme')}
              </Menu.Item>
              {owner && (
                <Menu.Item leftSection={<IconMap size={16} />} onClick={() => setTouring(true)}
                  rightSection={tourNew ? <Badge size="xs" variant="light">{t('New')}</Badge> : null}>
                  {t('Take the tour')}
                </Menu.Item>
              )}
              {owner && <Menu.Item color="red" leftSection={<IconAlertOctagon size={16} />} onClick={() => setCancelling(true)}>{t('Cancel every task…')}</Menu.Item>}
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
        <Box
          className="app-content"
          {...(route.kind === 'company' && context && FULL_PAGES.has(route.page)
            ? { 'data-layout': 'full', px: 0, py: 0 }
            : { px: { base: 'md', sm: 'xl' }, py: { base: 'md', sm: 'xl' } })}
        >
          <Suspense fallback={<Center py="xl"><Loader size="sm" /></Center>}>
          {!base.data ? null : route.kind === 'deployment' ? (
            <DeploymentSettings section={route.section} />
          ) : route.kind === 'home' || !context ? (
            <Home
              companies={companies}
              openCompany={(id, page, item) => open(page, { companyId: id, item: item ?? null })}
              startCompany={owner ? () => setStarting(true) : null}
              restoreCompany={owner ? () => setRestoring(true) : null}
              setup={setup}
              checklist={() => setChecklist(true)}
            />
          ) : (
            <CompanyPageView key={`${context.companyId}:${route.page}:${route.section}`} ctx={context} route={route as Extract<Route, { kind: 'company' }>} />
          )}
          </Suspense>
        </Box>
      </AppShell.Main>

      {mobile && !immersive && <AppShell.Footer>
        <Group h="100%" gap={0} wrap="nowrap">
          {/* The owner's day starts at Home; a member of staff's in the rooms. Money is in More (F19.16). */}
          {[
            ...(owner ? [{ id: 'home', label: t('Home'), icon: IconHome, press: () => go({ kind: 'home' }), badge: 0 }] : []),
            { id: 'rooms', label: t('Rooms'), icon: IconMessageCircle, press: () => open('rooms'), badge: roomsCount },
            { id: 'inbox', label: t('Inbox'), icon: IconInbox, press: () => open('inbox'), badge: inboxCount },
            { id: 'work', label: t('Work'), icon: IconActivity, press: () => open('work'), badge: 0 },
          ].map((tab) => (
            <UnstyledButton key={tab.id} className="bottom-tab" data-active={active === tab.id || undefined} onClick={tab.press}>
              <Box pos="relative">
                <tab.icon size={22} stroke={1.7} />
                {tab.badge ? <Badge size="xs" color="red" circle pos="absolute" top={-6} right={-12}>{tab.badge}</Badge> : null}
              </Box>
              {tab.label}
            </UnstyledButton>
          ))}
          <UnstyledButton className="bottom-tab" data-active={['team', 'memory', 'history', 'settings', 'overview', 'plan', 'customers', 'books', 'browser', 'money', 'deployment'].includes(active) || undefined} onClick={() => setMore(true)}>
            <IconDots size={22} stroke={1.7} />
            {t('More')}
          </UnstyledButton>
        </Group>
      </AppShell.Footer>}

      {/* As tall as what it lists, rather than the whole screen. */}
      <Drawer opened={more} onClose={() => setMore(false)} position="bottom" title={company?.name} radius="lg"
        styles={{ content: { flex: '0 0 auto', height: 'auto', maxHeight: '85dvh' } }}>
        <Stack gap={4} pb="md">
          {PAGES.filter((page) => !['inbox', 'rooms', 'work'].includes(page.id) && (owner || (page.group !== 'setup' && !page.owner))).map((page) => navLink(page, true))}
          {owner && <NavLink label={t('This deployment')} leftSection={<IconServer2 size={18} stroke={1.7} />} active={active === 'deployment'}
            onClick={() => { setMore(false); go({ kind: 'deployment', section: 'model' }); }} />}
          <Divider my="xs" />
          {LANGUAGES.map((one) => (
            <NavLink key={one.code} label={one.name} leftSection={<IconLanguage size={18} />} active={one.code === language()} onClick={() => void pickLanguage(one.code)} />
          ))}
          <NavLink label={colorScheme === 'dark' ? t('Light theme') : t('Dark theme')} leftSection={<IconMoon size={18} />} onClick={toggleColorScheme} />
          <NavLink label={t('Your profile')} leftSection={<IconUserCircle size={18} />} onClick={() => { setMore(false); setProfiling(true); }} />
          <NavLink label={t('Sign out')} leftSection={<IconLogout size={18} />} onClick={() => void signOut()} />
        </Stack>
      </Drawer>

      <ProfileDrawer opened={profiling} onClose={() => setProfiling(false)} profile={me.data} changed={() => me.reload()} />
      {staff && me.data && <ChooseHandle profile={me.data} chosen={() => me.reload()} />}

      <StartCompany opened={starting} close={() => setStarting(false)} languages={base.data?.languages ?? null} setup={setup} reloadSetup={base.reload}
        started={(id) => { arrive(id); setGreeting(id); }} />
      <RestoreCompany opened={restoring} close={() => setRestoring(false)} restored={(id) => arrive(id)} />

      <GiveWork companyId={company?.id ?? null} opened={giving} close={() => setGiving(false)} />
      <Assistant opened={asking} onClose={() => setAsking(false)} />
      <Assistant opened={talking !== null} company={talking} draft={draft} onClose={() => { setTalking(null); setDraft(null); }} />

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
        {setup.modelMissing && (
          <Button mb="md" variant="light" color="red" leftSection={<IconServer2 size={16} />} onClick={() => { setChecklist(false); go({ kind: 'deployment', section: 'model' }); }}>
            {t('Set the model')}
          </Button>
        )}
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
    case 'rooms': return <Rooms ctx={ctx} route={route} />;
    case 'overview': return <Overview ctx={ctx} route={route} />;
    case 'plan': return <Plan ctx={ctx} route={route} />;
    case 'work': return <Work ctx={ctx} route={route} />;
    case 'customers': return <Customers ctx={ctx} route={route} />;
    case 'books': return <Books ctx={ctx} route={route} />;
    case 'browser': return <Browser ctx={ctx} route={route} />;
    case 'team': return <Organization ctx={ctx} route={route} />;
    case 'memory': return <Memory ctx={ctx} route={route} />;
    case 'money': return <Money ctx={ctx} route={route} />;
    case 'history': return <History ctx={ctx} route={route} />;
    case 'settings': return <SettingsHub ctx={ctx} route={route} />;
  }
}

function CompanyMenu({
  companies, company, openCount, unread, pick, start, compact = false,
}: {
  companies: Company[];
  company: Company | null;
  openCount: Record<string, number>;
  /** What waits for the person in each company's rooms: its badge beside the inbox's. */
  unread: Unread[];
  pick: (id: string) => void;
  /** Null for a staff seat, which starts no company. */
  start: (() => void) | null;
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
            rightSection={(
              <Group gap={4} wrap="nowrap">
                {badgeOf(unread.find((waiting) => waiting.companyId === one.id)) > 0 && (
                  <Badge size="xs" color="blue" circle aria-label={tp('{count} message for you', '{count} messages for you', badgeOf(unread.find((waiting) => waiting.companyId === one.id)))}>
                    {badgeOf(unread.find((waiting) => waiting.companyId === one.id))}
                  </Badge>
                )}
                {openCount[one.id] ? <Badge size="xs" color="red" circle>{openCount[one.id]}</Badge> : one.eraseAfter ? <Badge size="xs" color="red" variant="light">{t('closing')}</Badge> : one.frozen ? <Badge size="xs" color="gray">{t('frozen')}</Badge> : null}
              </Group>
            )}
            onClick={() => pick(one.id)}
          >
            {one.name}
          </Menu.Item>
        ))}
        <Menu.Divider />
        {start && <Menu.Item leftSection={<IconPlus size={16} />} onClick={start}>{t('Start a company')}</Menu.Item>}
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
 * One more company: the same screen the first one starts from
 * (pages/Onboarding.tsx), in a dialog. A company is asked its languages as it
 * starts (N7); left alone, it took the deployment's default, which is English
 * until the owner finds Settings.
 */
function StartCompany({ opened, close, started, languages, setup, reloadSetup }: {
  opened: boolean; close: () => void; started: (id: string) => void; languages: Languages | null;
  setup: SetupReport; reloadSetup: () => void;
}) {
  return (
    <Modal opened={opened} onClose={close} title={t('Start a company')} centered size="lg">
      <Onboarding languages={languages} setup={setup} reloadSetup={reloadSetup} cancel={close}
        started={(id) => { close(); started(id); }} />
    </Modal>
  );
}
