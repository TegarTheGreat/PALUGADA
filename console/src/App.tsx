/**
 * The owner's console: the door, and the company behind it.
 *
 * One human, one queue of decisions (PRD v2 §5 principle 1). The queue is the
 * first page because it is the one with a person waiting on it; everything
 * else is running a company rather than being interrupted by it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActionIcon, AppShell, Avatar, Badge, Burger, Button, Divider, Group, Menu, NavLink, ScrollArea,
  Stack, Text, TextInput, Tooltip, UnstyledButton, useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconActivity, IconAlertOctagon, IconBuildingSkyscraper, IconChartPie, IconChevronDown, IconCoin,
  IconCpu, IconHistory, IconInbox, IconLayoutDashboard, IconLogout, IconMoon, IconPackage,
  IconPlayerPlay, IconPlayerStop, IconPlus, IconSettings, IconSitemap, IconSparkles, IconSun,
} from '@tabler/icons-react';
import { api, setToken, whenSignedOut } from './api.ts';
import { useFactor } from './factor.tsx';
import type { Company } from './types.ts';
import { SignIn } from './pages/SignIn.tsx';
import { Decisions } from './pages/Decisions.tsx';
import { Overview } from './pages/Overview.tsx';
import { Work } from './pages/Work.tsx';
import { Organization } from './pages/Organization.tsx';
import { Money } from './pages/Money.tsx';
import { History } from './pages/History.tsx';
import { Health } from './pages/Health.tsx';
import { Skills } from './pages/Skills.tsx';
import { Bundles } from './pages/Bundles.tsx';
import { Devices } from './pages/Devices.tsx';
import { Settings } from './pages/Settings.tsx';
import { Modal } from '@mantine/core';

export type PageId =
  | 'decisions' | 'overview' | 'work' | 'organization' | 'money' | 'history'
  | 'health' | 'skills' | 'bundles' | 'devices' | 'settings';

const PAGES: Array<{ id: PageId; label: string; icon: typeof IconInbox; group: 'run' | 'guard' }> = [
  { id: 'decisions', label: 'Decisions', icon: IconInbox, group: 'run' },
  { id: 'overview', label: 'Overview', icon: IconLayoutDashboard, group: 'run' },
  { id: 'work', label: 'Work', icon: IconActivity, group: 'run' },
  { id: 'organization', label: 'Organization', icon: IconSitemap, group: 'run' },
  { id: 'money', label: 'Money', icon: IconCoin, group: 'run' },
  { id: 'history', label: 'History', icon: IconHistory, group: 'run' },
  { id: 'health', label: 'Health', icon: IconChartPie, group: 'guard' },
  { id: 'skills', label: 'Skills', icon: IconSparkles, group: 'guard' },
  { id: 'bundles', label: 'Bundles', icon: IconPackage, group: 'guard' },
  { id: 'devices', label: 'Devices', icon: IconCpu, group: 'guard' },
  { id: 'settings', label: 'Settings', icon: IconSettings, group: 'guard' },
];

/**
 * Where a notification's link pointed: `/?company=<id>&item=<id>`. Read once,
 * on the first draw, and then forgotten, so the page does not keep jumping
 * back to it.
 */
function linkedFromUrl(): { companyId: string | null; itemId: string | null } {
  const query = new URLSearchParams(window.location.search);
  const linked = { companyId: query.get('company'), itemId: query.get('item') };
  if (linked.companyId || linked.itemId) window.history.replaceState(null, '', window.location.pathname);
  return linked;
}

export function App() {
  const [device, setDevice] = useState<string | null>(null);
  const [linked] = useState(linkedFromUrl);

  useEffect(() => whenSignedOut(() => setDevice(null)), []);

  if (!device) {
    return (
      <SignIn
        onSignedIn={(session) => {
          setToken(session.token);
          setDevice(session.device);
        }}
      />
    );
  }
  return (
    <Console
      device={device}
      linked={linked}
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
  go: (page: PageId) => void;
  refreshCompanies: () => Promise<void>;
  /** The inbox tells the navigation how many decisions are waiting. */
  setOpenCount: (count: number) => void;
}

function Console({
  device, linked, signOut,
}: {
  device: string;
  linked: { companyId: string | null; itemId: string | null };
  signOut: () => Promise<void>;
}) {
  const [opened, { toggle, close }] = useDisclosure();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(linked.companyId);
  const [page, setPage] = useState<PageId>('decisions');
  const [stopAll, setStopAll] = useState(false);
  const [openCount, setOpenCount] = useState<Record<string, number>>({});
  const [linkedItem, setLinkedItem] = useState<string | null>(linked.itemId);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const requireFactor = useFactor();
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();

  const refreshCompanies = useCallback(async () => {
    const [{ companies: list }, control]: [{ companies: Company[] }, { stopAll: boolean }] = await Promise.all([
      api('GET', '/api/companies'),
      api('GET', '/api/control'),
    ]);
    setCompanies(list);
    setStopAll(control.stopAll);
    setCompanyId((current) => (current && list.some((one) => one.id === current) ? current : list[0]?.id ?? null));
  }, []);

  useEffect(() => { void refreshCompanies(); }, [refreshCompanies]);

  const company = companies.find((one) => one.id === companyId) ?? null;
  const go = useCallback((next: PageId) => { setPage(next); close(); }, [close]);

  const context = useMemo<ConsoleContext | null>(() => (company ? {
    companyId: company.id,
    company,
    companies,
    go,
    refreshCompanies,
    setOpenCount: (count: number) => setOpenCount((current) => ({ ...current, [company.id]: count })),
  } : null), [company, companies, go, refreshCompanies]);

  // F10.7. Two controls, because they are two decisions: "stop" raises a flag
  // the engine reads at every step, so work stops cleanly and resumes when the
  // flag clears; "cancel everything" ends the tasks outright and cannot be
  // undone, which is why it asks for the authenticator. Stopping takes one
  // press; resuming takes the authenticator, so a stolen session cannot undo
  // the stop.
  const toggleStop = async () => {
    try {
      if (stopAll) {
        const done = await requireFactor('Resume everything', (proof) =>
          api('POST', '/api/control/stop-all', { on: false, proof }));
        if (!done) return;
      } else {
        await api('POST', '/api/control/stop-all', { on: true });
      }
      await refreshCompanies();
      notifications.show({
        color: stopAll ? 'teal' : 'red',
        message: stopAll ? 'Everything is running again.' : 'Every company is halted. Nothing is running.',
      });
    } catch (failure) {
      notifications.show({ color: 'red', message: (failure as Error).message });
    }
  };

  const cancelEverything = async () => {
    setCancelling(false);
    const done = await requireFactor('Cancel every task in every company', (proof) =>
      api('POST', '/api/control/cancel-everything', { proof }));
    if (done) {
      notifications.show({ color: 'red', message: 'Every task was cancelled.' });
      await refreshCompanies();
    }
  };

  const Page = pageComponent(page);

  return (
    <AppShell
      header={{ height: 60 }}
      navbar={{ width: 272, breakpoint: 'sm', collapsed: { mobile: !opened } }}
      padding="lg"
    >
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <span className="brand-mark" aria-hidden="true">P</span>
            <Text fw={800} lts="0.12em" visibleFrom="xs">PALUGADA</Text>
            {stopAll && <Badge color="red" variant="filled" leftSection={<IconAlertOctagon size={12} />}>All stopped</Badge>}
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Tooltip label={stopAll ? 'Resume every company (takes your authenticator)' : 'Halt every company at its next step'}>
              <Button
                color={stopAll ? 'teal' : 'red'}
                variant={stopAll ? 'filled' : 'light'}
                leftSection={stopAll ? <IconPlayerPlay size={16} /> : <IconPlayerStop size={16} />}
                onClick={() => void toggleStop()}
                size="sm"
              >
                <Text span visibleFrom="xs" inherit>{stopAll ? 'Resume everything' : 'Stop everything'}</Text>
              </Button>
            </Tooltip>
            <ActionIcon variant="default" size="lg" onClick={toggleColorScheme} aria-label="Toggle colour scheme">
              {colorScheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
            </ActionIcon>
            <Menu position="bottom-end" width={240} shadow="md">
              <Menu.Target>
                <UnstyledButton aria-label="Account">
                  <Avatar color="teal" radius="xl" size={34}>{device.slice(0, 1).toUpperCase()}</Avatar>
                </UnstyledButton>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>Signed in with</Menu.Label>
                <Menu.Item disabled>{device}</Menu.Item>
                <Menu.Divider />
                <Menu.Item color="red" leftSection={<IconAlertOctagon size={16} />} onClick={() => setCancelling(true)}>
                  Cancel everything…
                </Menu.Item>
                <Menu.Item leftSection={<IconLogout size={16} />} onClick={() => void signOut()}>
                  Sign out
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <AppShell.Section>
          <Menu width="target" shadow="md" position="bottom-start">
            <Menu.Target>
              <UnstyledButton
                w="100%"
                p="xs"
                style={{ borderRadius: 'var(--mantine-radius-md)', border: '1px solid var(--mantine-color-default-border)' }}
              >
                <Group gap="sm" wrap="nowrap">
                  <Avatar color="blue" radius="md" size={36}>{company?.name.slice(0, 1).toUpperCase() ?? '?'}</Avatar>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Text size="xs" c="dimmed">Company</Text>
                    <Text fw={700} size="sm" truncate>{company?.name ?? 'No company yet'}</Text>
                  </div>
                  <IconChevronDown size={16} />
                </Group>
              </UnstyledButton>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Your companies</Menu.Label>
              {companies.map((one) => (
                <Menu.Item
                  key={one.id}
                  leftSection={<Avatar size={22} radius="sm" color="blue">{one.name.slice(0, 1).toUpperCase()}</Avatar>}
                  rightSection={openCount[one.id] ? <Badge size="xs" color="red" circle>{openCount[one.id]}</Badge> : one.frozen ? <Badge size="xs" color="gray">frozen</Badge> : null}
                  onClick={() => { setCompanyId(one.id); setLinkedItem(null); }}
                >
                  {one.name}
                </Menu.Item>
              ))}
              <Menu.Divider />
              <Menu.Item leftSection={<IconPlus size={16} />} onClick={() => setStarting(true)}>
                Start a company
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </AppShell.Section>

        <AppShell.Section grow component={ScrollArea} mt="md">
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" mb={6}>Run the company</Text>
          {PAGES.filter((one) => one.group === 'run').map((one) => (
            <NavLink
              key={one.id}
              label={one.label}
              leftSection={<one.icon size={18} stroke={1.7} />}
              rightSection={one.id === 'decisions' && company && openCount[company.id]
                ? <Badge size="sm" color="red" circle>{openCount[company.id]}</Badge>
                : null}
              active={page === one.id}
              onClick={() => go(one.id)}
              style={{ borderRadius: 'var(--mantine-radius-md)' }}
              fw={500}
            />
          ))}
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" mt="lg" mb={6}>Safeguards & setup</Text>
          {PAGES.filter((one) => one.group === 'guard').map((one) => (
            <NavLink
              key={one.id}
              label={one.label}
              leftSection={<one.icon size={18} stroke={1.7} />}
              active={page === one.id}
              onClick={() => go(one.id)}
              style={{ borderRadius: 'var(--mantine-radius-md)' }}
              fw={500}
            />
          ))}
        </AppShell.Section>

        <AppShell.Section>
          <Divider mb="sm" />
          <Group gap="xs" px="xs" wrap="nowrap">
            <IconBuildingSkyscraper size={16} color="var(--mantine-color-dimmed)" />
            <Text size="xs" c="dimmed">{companies.length} {companies.length === 1 ? 'company' : 'companies'} · one owner</Text>
          </Group>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        {context ? (
          <Page key={`${context.companyId}:${page}`} ctx={context} linkedItem={linkedItem} clearLinked={() => setLinkedItem(null)} />
        ) : (
          <Stack align="center" mt={80} gap="sm">
            <Text fw={700} size="lg">No company yet</Text>
            <Text c="dimmed" size="sm">Start one from the standard template to see it here.</Text>
            <Button leftSection={<IconPlus size={16} />} onClick={() => setStarting(true)}>Start a company</Button>
          </Stack>
        )}
      </AppShell.Main>

      <StartCompany opened={starting} close={() => setStarting(false)} started={async (id) => { await refreshCompanies(); setCompanyId(id); }} />

      <Modal opened={cancelling} onClose={() => setCancelling(false)} title="Cancel every task?" centered>
        <Text size="sm">
          This ends every task in every company, now, and cannot be undone. To pause instead, use
          Stop everything: that halts work cleanly and can be resumed.
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={() => setCancelling(false)}>Keep them</Button>
          <Button color="red" onClick={() => void cancelEverything()}>Cancel everything</Button>
        </Group>
      </Modal>
    </AppShell>
  );
}

export interface PageProps {
  ctx: ConsoleContext;
  linkedItem: string | null;
  clearLinked: () => void;
}

function pageComponent(page: PageId): (props: PageProps) => React.ReactElement {
  switch (page) {
    case 'decisions': return Decisions;
    case 'overview': return Overview;
    case 'work': return Work;
    case 'organization': return Organization;
    case 'money': return Money;
    case 'history': return History;
    case 'health': return Health;
    case 'skills': return Skills;
    case 'bundles': return Bundles;
    case 'devices': return Devices;
    case 'settings': return Settings;
  }
}

/**
 * Starting a company (PRD v2 section 5).
 *
 * A structural change if anything is -- it writes divisions, roles, grants and
 * a budget tree in one transaction -- so the API asks for the owner's device.
 */
function StartCompany({
  opened, close, started,
}: { opened: boolean; close: () => void; started: (id: string) => Promise<void> }) {
  const requireFactor = useFactor();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    let created: { companyId?: string } = {};
    try {
      const done = await requireFactor(`Start ${name}`, async (proof) => {
        created = await api('POST', '/api/companies', { templateSlug: 'standard-company', companySlug: slug, name, proof });
      });
      if (!done) return;
      notifications.show({ color: 'teal', message: `${name} is running.` });
      close();
      setName('');
      setSlug('');
      if (created.companyId) await started(created.companyId);
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title="Start a company" centered>
      <Stack>
        <Text size="sm" c="dimmed">
          Built from the standard template: operations, delivery, growth, finance, support,
          assurance and a lab, with a role in each. A template needs every capability it grants to
          be bound on this deployment, and the refusal names any that are not.
        </Text>
        <TextInput label="Name" placeholder="Kopi Nusantara" value={name} onChange={(e) => {
          const value = e.currentTarget.value;
          setName(value);
          setSlug(value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
        }} required />
        <TextInput label="Short name" description="Used in URLs and exports" value={slug} onChange={(e) => setSlug(e.currentTarget.value)} required />
        {error && <Text c="red" size="sm">{error}</Text>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>Cancel</Button>
          <Button disabled={!name || !slug} onClick={() => void submit()}>Start it</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
