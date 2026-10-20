/**
 * The console, walked through once with its owner.
 *
 * Every screen was built for someone who already knew what it was for, and a
 * new owner met a sidebar of nouns. The tour names each place, says in a
 * sentence or two what it is for, and moves the console there behind it, so
 * what is described is what is on the screen. It opens by itself until it is
 * finished or skipped -- remembered by the deployment (0064), since the
 * console stores nothing in the browser -- and again from the owner's menu.
 */
import { useEffect, useState } from 'react';
import { Button, Group, Modal, Progress, Stack, Text, ThemeIcon, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconActivity, IconBuildingStore, IconHome, IconInbox, IconLayoutDashboard, IconPlayerStop, IconSettings, IconSparkles,
} from '@tabler/icons-react';
import { N, t } from '../i18n.ts';

/** Where a stop takes the console: a page of the current company, or the portfolio. */
export type TourPlace = 'home' | 'inbox' | 'work' | 'overview' | 'settings';

/** What a stop points at in the sidebar, which is there whether or not a company is. */
export type TourSpot = TourPlace | 'new' | 'setup' | 'stop';

interface Stop {
  title: string;
  body: string;
  icon: typeof IconHome;
  place: TourPlace | null;
  spot: TourSpot | null;
}

const STOPS: readonly Stop[] = [
  {
    title: N('Welcome to PALUGADA'),
    body: N('Your companies are run by AI agents. You set the goals and the limits, and every step that cannot be undone waits for you. This takes two minutes; it is in the menu under your name if you want it again.'),
    icon: IconSparkles,
    place: null,
    spot: null,
  },
  {
    title: N('Home: every company at a glance'),
    body: N('What needs you, what is running and what it costs, across all your companies. Start here each day.'),
    icon: IconHome,
    place: 'home',
    spot: 'home',
  },
  {
    title: N('Inbox: what only you can decide'),
    body: N('Approvals, questions from agents and incidents, most urgent first. Each says what it costs, whether it can be undone and what happens if you say no. The irreversible ones ask for a code from your authenticator.'),
    icon: IconInbox,
    place: 'inbox',
    spot: 'inbox',
  },
  {
    title: N('Give work in a sentence'),
    body: N('New, then Give a role work: say what you want. The coordinator hands it to the role whose job it is, and Work shows it moving and what it delivered.'),
    icon: IconActivity,
    place: 'work',
    spot: 'new',
  },
  {
    title: N('A company, page by page'),
    body: N('Overview has its goals and stage. Team is its divisions and roles, Memory what it has learned, Money its budgets and spend, and History every change and decision.'),
    icon: IconLayoutDashboard,
    place: 'overview',
    spot: 'overview',
  },
  {
    title: N('Settings, and what is left to set up'),
    body: N('Languages, bundles, schedules, triggers and devices are in Settings. Finish setting up, in the sidebar, lists what this deployment still needs, such as a model or a vendor account.'),
    icon: IconSettings,
    place: 'settings',
    spot: 'setup',
  },
  {
    title: N('The brake'),
    body: N('Stop everything halts every company cleanly, and Resume everything starts them again. Use it whenever you want quiet: nothing is lost.'),
    icon: IconPlayerStop,
    place: null,
    spot: 'stop',
  },
  {
    title: N('Start your first company'),
    body: N('A company starts with its CEO. Say what it is for, then talk to the CEO: it builds the team as the work needs it, and you answer the inbox when it asks.'),
    icon: IconBuildingStore,
    place: 'home',
    spot: 'new',
  },
];

export function Tour({ opened, hasCompany, finish, show, point, start }: {
  opened: boolean;
  /** Whether there is a company whose pages can be shown. */
  hasCompany: boolean;
  /** Finished or skipped: the deployment remembers, and the tour closes. */
  finish: () => void;
  show: (place: TourPlace) => void;
  /** Marks what a stop is about in the sidebar; null when nothing is. */
  point: (spot: TourSpot | null) => void;
  /** The last stop's own action. */
  start: () => void;
}) {
  const [at, setAt] = useState(0);
  // A phone has no sidebar beside the tour to point at, and no room for
  // three buttons in a row.
  const phone = useMediaQuery('(max-width: 48em)') ?? false;
  const stop = STOPS[at]!;
  const last = at === STOPS.length - 1;

  // The console follows the tour, so what a stop describes is what is behind
  // it. A company's pages need a company; before the first one, the tour
  // stays where it is and says the same.
  useEffect(() => {
    if (!opened) return;
    point(stop.spot);
    if (stop.place !== null && (stop.place === 'home' || hasCompany)) show(stop.place);
  }, [opened, at]); // eslint-disable-line react-hooks/exhaustive-deps

  const close = () => {
    setAt(0);
    point(null);
    finish();
  };

  return (
    <Modal
      opened={opened}
      onClose={close}
      withCloseButton={false}
      centered
      size="lg"
      radius="lg"
      shadow="xl"
      // No overlay: the page a stop is about, and the part of the sidebar it
      // points at, stay in full view beside it.
      withOverlay={false}
      // A click on the page it is showing is not a request to skip it.
      closeOnClickOutside={false}
      xOffset={phone ? 0 : '12vw'}
    >
      <Stack gap="md" p="xs">
        <Progress value={((at + 1) / STOPS.length) * 100} size="sm" radius="xl" aria-label={t('{step} of {total}', { step: at + 1, total: STOPS.length })} />
        <Group gap="sm" wrap="nowrap">
          <ThemeIcon size={44} radius="md" variant="light"><stop.icon size={24} /></ThemeIcon>
          <Title order={3}>{t(stop.title)}</Title>
        </Group>
        <Text>{t(stop.body)}</Text>
        {(() => {
          const skip = <Button variant="subtle" color="gray" onClick={close} fullWidth={phone}>{last ? t('Finish') : t('Skip the tour')}</Button>;
          const back = at > 0 ? <Button variant="default" onClick={() => setAt(at - 1)} fullWidth={phone}>{t('Back')}</Button> : null;
          const onward = last
            ? <Button onClick={() => { close(); start(); }} fullWidth={phone}>{t('Start a company')}</Button>
            : <Button onClick={() => setAt(at + 1)} fullWidth={phone}>{t('Next')}</Button>;
          return phone
            ? <Stack gap="xs" mt="sm">{onward}{back}{skip}</Stack>
            : (
              <Group justify="space-between" mt="sm" wrap="nowrap">
                {skip}
                <Group gap="xs" wrap="nowrap">{back}{onward}</Group>
              </Group>
            );
        })()}
        <Text size="xs" c="dimmed" ta="center" className="tabular">{t('{step} of {total}', { step: at + 1, total: STOPS.length })}</Text>
      </Stack>
    </Modal>
  );
}
