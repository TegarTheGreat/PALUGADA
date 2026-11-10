/**
 * Browser (src/browser/): the company's own browser, as its work uses it.
 *
 * Each piece of work that opened a page has a tab, shown here as a picture of
 * the page, taken again about once a second while it is in front of the
 * owner. The owner takes the browser over with their device to do what a
 * role never does -- sign in, type the code a site sent to their phone,
 * answer a puzzle -- and while they hold it the company's work waits: what
 * they press on the picture is pressed on the page, and what they type is
 * typed there and kept nowhere else. Giving it back seals what they signed
 * in to for the company's work, and a role that asked for it goes on.
 */
import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from 'react';
import { Alert, Badge, Box, Button, Group, Paper, Select, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconHandStop, IconLock, IconWorldWww } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import type { BrowserScreen, BrowserTab, BrowserView } from '../types.ts';
import { EmptyState, LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';

/** Keys the owner presses with a button: the key as the page's input takes it, and as a keyboard draws it. */
const KEYS: ReadonlyArray<readonly [string, string]> = [
  ['Enter', '⏎'], ['Tab', '⇥'], ['Backspace', '⌫'], ['Escape', 'Esc'], ['ArrowUp', '↑'], ['ArrowDown', '↓'],
];

function tabSaid(tab: BrowserTab): string {
  let host = tab.url;
  try {
    host = new URL(tab.url).host || tab.url;
  } catch {
    // Said as it is.
  }
  return `${tab.taskId ? tab.work ?? tab.title : t('Your own tab')} · ${host}`;
}

export function Browser({ ctx, route }: PageProps) {
  const { companyId } = ctx;
  const requireFactor = useFactor();
  const view = useLoad<BrowserView>(() => api('GET', `/api/companies/${companyId}/browser`), [companyId], { every: 4_000 });
  const [chosen, setChosen] = useState<string | null>(null);
  const [screen, setScreen] = useState<BrowserScreen | null>(null);
  const [address, setAddress] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const scrolled = useRef({ dy: 0, timer: 0 });

  const tabs = view.data?.tabs ?? [];
  // The tab chosen here, else the work a card sent the owner about, else the first.
  const tab = tabs.find((one) => one.id === chosen)
    ?? (route.item ? tabs.find((one) => one.taskId === route.item) : undefined) ?? tabs[0] ?? null;
  const held = view.data?.held ?? null;

  // The picture, again and again, while this page is in front.
  useEffect(() => {
    if (!tab) {
      setScreen(null);
      return undefined;
    }
    let stopped = false;
    let timer = 0;
    const take = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const next: BrowserScreen = await api('GET', `/api/companies/${companyId}/browser/tabs/${tab.id}`);
          if (!stopped) setScreen(next);
        } catch {
          // The tab closed; the list says so when it is next read.
        }
      }
      if (!stopped) timer = window.setTimeout(() => { void take(); }, 1_000);
    };
    void take();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [companyId, tab?.id]);

  const failed = (error: unknown) => {
    notifications.show({ color: 'red', message: explain(error) });
    view.reload();
  };
  const send = async (input: Record<string, unknown>) => {
    if (!tab) return;
    try {
      await api('POST', `/api/companies/${companyId}/browser/tabs/${tab.id}/input`, input);
    } catch (error) {
      failed(error);
    }
  };
  const press = (event: MouseEvent<HTMLImageElement>) => {
    if (!held || !screen) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = Math.min(screen.width - 1, Math.max(0, Math.floor(((event.clientX - box.left) / box.width) * screen.width)));
    const y = Math.min(screen.height - 1, Math.max(0, Math.floor(((event.clientY - box.top) / box.height) * screen.height)));
    void send({ kind: 'click', x, y });
  };
  // A wheel turned on the picture scrolls the page, sent a few times a second rather than at every notch.
  const wheel = (event: WheelEvent<HTMLImageElement>) => {
    if (!held || !screen) return;
    scrolled.current.dy += event.deltaY;
    if (scrolled.current.timer) return;
    scrolled.current.timer = window.setTimeout(() => {
      const dy = Math.max(-10_000, Math.min(10_000, Math.round(scrolled.current.dy)));
      scrolled.current = { dy: 0, timer: 0 };
      if (dy !== 0) void send({ kind: 'scroll', dy });
    }, 200);
  };

  const takeOver = async () => {
    const done = await requireFactor(t('Take the company\'s browser over'), async (proof) => {
      await api('POST', `/api/companies/${companyId}/browser/take-over`, { proof });
    });
    if (done) view.reload();
  };
  const giveBack = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/browser/give-back`, {});
      notifications.show({ color: 'green', message: t('Given back. The work that asked for it goes on.') });
      view.reload();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const open = async () => {
    setBusy(true);
    try {
      const opened: BrowserTab = await api('POST', `/api/companies/${companyId}/browser/open`, {
        url: address.trim(), ...(tab ? { tabId: tab.id } : {}),
      });
      setChosen(opened.id);
      setAddress('');
      view.reload();
    } catch (error) {
      failed(error);
    } finally {
      setBusy(false);
    }
  };
  const type = async () => {
    if (!typed) return;
    await send({ kind: 'text', text: typed });
    setTyped('');
  };

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Browser')}
      description={t('The company\'s own browser: each piece of work\'s page as it is now. Take it over to sign in somewhere; while you hold it, the company\'s work waits.')}
      live={view.updatedAt}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={3} /></>;
  if (!view.data.available) {
    return (
      <Stack gap="lg">
        {header}
        <Alert color="gray" icon={<IconWorldWww size={18} />}>
          {t('This deployment has no browser: install Chromium on its machine, or set PALUGADA_CHROMIUM to one.')}
        </Alert>
      </Stack>
    );
  }

  return (
    <Stack gap="lg">
      {header}
      <Paper withBorder radius="md" p="md">
        {held ? (
          <Group justify="space-between" gap="sm">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge color="teal" variant="light" leftSection={<IconHandStop size={12} />}>{t('You have it')}</Badge>
              <Text size="sm" c="dimmed">{t('The company\'s work waits until you give it back.')}</Text>
            </Group>
            <Button variant="light" onClick={() => void giveBack()} loading={busy}>{t('Give it back')}</Button>
          </Group>
        ) : (
          <Group justify="space-between" gap="sm">
            <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 0 }}>{t('Take it over to press and type on its pages.')}</Text>
            <Button leftSection={<IconLock size={16} />} onClick={() => void takeOver()}>{t('Take it over')}</Button>
          </Group>
        )}
      </Paper>

      {held && (
        <Group gap="sm" align="flex-end" wrap="nowrap">
          <TextInput style={{ flex: 1, minWidth: 0 }} label={t('Open an address')} placeholder="https://"
            value={address} onChange={(event) => setAddress(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && address.trim()) void open(); }} />
          <Button onClick={() => void open()} disabled={!address.trim()} loading={busy}>{t('Open the page')}</Button>
        </Group>
      )}

      {tabs.length === 0 ? (
        <EmptyState
          title={t('No page is open')}
          description={t('When work opens a page, it is shown here. To sign in somewhere for the company, take the browser over and open the page yourself.')}
        />
      ) : (
        <Section title={t('Page')} padding="md">
          <Stack gap="sm">
            {tabs.length > 1 && (
              <Select data={tabs.map((one) => ({ value: one.id, label: tabSaid(one) }))} value={tab?.id ?? null}
                onChange={(value) => setChosen(value)} allowDeselect={false} aria-label={t('Page')} />
            )}
            {tab && <Text size="sm" c="dimmed" truncate>{tabs.length > 1 ? screen?.url ?? tab.url : tabSaid(tab)}</Text>}
            <Box style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8, overflow: 'hidden', lineHeight: 0 }}>
              {screen ? (
                <img src={screen.image} alt={screen.title} onClick={press} onWheel={wheel}
                  style={{ width: '100%', height: 'auto', display: 'block', cursor: held ? 'crosshair' : 'default' }} />
              ) : <Loading rows={3} />}
            </Box>
            {held && (
              <>
                <Text size="xs" c="dimmed">{t('Press on the picture to click there; what you type goes to the field the page has selected.')}</Text>
                <Group gap="sm" align="flex-end" wrap="nowrap">
                  <TextInput style={{ flex: 1, minWidth: 0 }} label={t('Type')} value={typed}
                    onChange={(event) => setTyped(event.currentTarget.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') void type(); }} />
                  <Button variant="light" onClick={() => void type()} disabled={!typed}>{t('Send')}</Button>
                </Group>
                <Group gap={6}>
                  {KEYS.map(([key, mark]) => (
                    <Button key={key} size="xs" variant="default" aria-label={t('Press {key}', { key })}
                      onClick={() => void send({ kind: 'key', key })}>{mark}</Button>
                  ))}
                </Group>
              </>
            )}
          </Stack>
        </Section>
      )}
    </Stack>
  );
}
