/**
 * Relays (F19.19, F19.20; STATUS section 2.208): services outside PALUGADA
 * that tell people's phones what PALUGADA has for them, and carry back the
 * few presses a notice offers.
 *
 * A relay is added by its address and paired by the owner alone: at least
 * sixteen characters of the fingerprint its operator shows, the companies it
 * may hear about, and a code given now. It starts told the least -- that
 * something happened -- with presses off; widening either takes the owner's
 * device again, and narrowing voids what it no longer allows. The owner's own
 * phone is linked here until each person's profile has a place for it.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Checkbox, Code, Group, MultiSelect, Paper, SegmentedControl, Stack, Switch, Table, Text, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBroadcast, IconKey, IconPlus, IconRefresh, IconSend } from '@tabler/icons-react';
import { api, explain } from '../../api.ts';
import { useFactor } from '../../factor.tsx';
import { useLoad } from '../../hooks.ts';
import { dateTime, relative } from '../../format.ts';
import { N, t } from '../../i18n.ts';
import { EmptyState, LoadFailed, Loading, Section } from '../../components/ui.tsx';
import { ActionButton } from '../../components/ActionForm.tsx';
import { LinkPhone } from '../../workspace/LinkPhone.tsx';

type Share = 'signal' | 'summary' | 'content';

interface RelayView {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
  status: 'pending' | 'paired';
  mode: 'push' | 'pull';
  share: Share;
  companies: string[];
  allCompanies: boolean;
  mayPress: boolean;
  mayPost: boolean;
  pull: boolean;
  pausedUntil: string | null;
  lastOkAt: string | null;
  lastError: string | null;
  createdAt: string;
  pairedAt: string | null;
  links: number;
  outbox: { pending: number; sending: number; delivered: number; dead: number };
  dead: Array<{ id: string; type: string; attempts: number; lastError: string | null; createdAt: string }>;
}

interface RelaysPage {
  deployment: { key: string; kid: string; fingerprint: string; previous: { kid: string; until: string } | null };
  relays: RelayView[];
}

const SHARE_LABEL: Record<Share, string> = {
  signal: N('That something happened'),
  summary: N('What it is about'),
  content: N('What it says'),
};

/** A fingerprint as people read it out: groups of four. */
function grouped(fingerprint: string): string {
  return fingerprint.replace(/(.{4})(?!$)/g, '$1 ');
}

export function RelaySettings() {
  const requireFactor = useFactor();
  const view = useLoad(async () => {
    const [page, { companies }]: [RelaysPage, { companies: Array<{ id: string; name: string }> }] = await Promise.all([
      api('GET', '/api/control/relays'),
      api('GET', '/api/companies'),
    ]);
    return { ...page, companies };
  }, []);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={3} />;
  const { deployment, relays, companies } = view.data;

  const add = async () => {
    setAdding(true);
    setError(null);
    try {
      await api('POST', '/api/control/relays', { url: url.trim() });
      setUrl('');
      view.reload();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setAdding(false);
    }
  };
  const rotate = async () => {
    try {
      const done = await requireFactor(t('Give this deployment a new key'), (proof) => api('POST', '/api/control/relay-identity/rotate', { proof }));
      if (done) {
        notifications.show({ color: 'teal', message: t('A new key. Every relay is told, and the old key signs beside it for a week.') });
        view.reload();
      }
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  return (
    <Stack gap="lg">
      <Section
        title={t('This deployment\'s key')}
        description={t('A relay pairs with this deployment by this fingerprint. Read it to the relay\'s operator, or give it to the reference relay.')}
        actions={<Button size="xs" variant="default" leftSection={<IconKey size={16} />} onClick={() => void rotate()}>{t('New key')}</Button>}
      >
        <Stack gap={4}>
          <Code block fz="lg" style={{ letterSpacing: '0.08em' }}>{grouped(deployment.fingerprint)}</Code>
          {deployment.previous && (
            <Text size="xs" c="dimmed">
              {t('The previous key ({kid}) signs beside it until {when}.', { kid: deployment.previous.kid, when: dateTime(deployment.previous.until) })}
            </Text>
          )}
        </Stack>
      </Section>

      <Section title={t('Add a relay')} description={t('Its address, as its operator gives it. PALUGADA reads the relay\'s key from it and shows you its fingerprint to compare.')}>
        <Group align="flex-end" wrap="wrap">
          <TextInput
            label={t('Address')} placeholder="https://relay.example" value={url} style={{ flex: '1 1 16rem' }}
            onChange={(event) => setUrl(event.currentTarget.value)}
          />
          <Button leftSection={<IconPlus size={16} />} loading={adding} disabled={!url.trim()} onClick={() => void add()}>{t('Add')}</Button>
        </Group>
        {error && <Alert mt="sm" color="red" variant="light">{error}</Alert>}
      </Section>

      {relays.length === 0
        ? <EmptyState title={t('No relay yet')} description={t('Without a relay, PALUGADA reaches you through the channels you set and the console.')} />
        : relays.map((relay) => <RelayCard key={relay.id} relay={relay} companies={companies} reload={view.reload} />)}
    </Stack>
  );
}

function RelayCard({ relay, companies, reload }: { relay: RelayView; companies: Array<{ id: string; name: string }>; reload: () => void }) {
  const named = (ids: string[]) => ids.map((id) => companies.find((one) => one.id === id)?.name ?? id).join(', ');
  return (
    <Paper withBorder radius="lg" p="lg">
      <Stack gap="md">
        <Group justify="space-between" wrap="wrap">
          <Group gap="sm">
            <IconBroadcast size={20} stroke={1.7} />
            <Text fw={600}>{relay.name}</Text>
            <Badge color={relay.status === 'paired' ? 'teal' : 'orange'} variant="light">
              {relay.status === 'paired' ? t('Paired') : t('Waiting to be paired')}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>{relay.url}</Text>
        </Group>
        <Stack gap={2}>
          <Text size="xs" c="dimmed">{t('Its fingerprint')}</Text>
          <Code fz="md" style={{ letterSpacing: '0.08em' }}>{grouped(relay.fingerprint)}</Code>
        </Stack>
        {relay.status === 'pending' || relay.pausedUntil === 'infinity'
          ? (
            <>
              {relay.pausedUntil === 'infinity' && <Alert color="orange" variant="light">{t('The relay forgot this deployment: pair it again.')}</Alert>}
              <PairForm relay={relay} companies={companies} reload={reload} />
            </>
          )
          : (
            <>
              <Text size="sm">
                {relay.allCompanies ? t('Hears about every company, later ones too.') : t('Hears about: {companies}', { companies: named(relay.companies) })}
              </Text>
              <RelayControls relay={relay} companies={companies} reload={reload} />
              <Outbox relay={relay} reload={reload} />
              <LinkPhone relayId={relay.id} relayName={relay.name} />
            </>
          )}
        <Group justify="flex-end">
          <ActionButton size="xs" color="red" variant="subtle" label={t('Revoke')}
            run={() => api('POST', `/api/control/relays/${relay.id}/revoke`, {})} done={reload} />
        </Group>
      </Stack>
    </Paper>
  );
}

/** Pairing: what the operator showed, typed; the companies, named; a code given now. */
function PairForm({ relay, companies, reload }: { relay: RelayView; companies: Array<{ id: string; name: string }>; reload: () => void }) {
  const requireFactor = useFactor();
  const [fingerprint, setFingerprint] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const typed = fingerprint.replace(/[\s-]/g, '');
  const pair = async () => {
    setError(null);
    try {
      const done = await requireFactor(t('Pair {name}', { name: relay.name }), (proof) => api('POST', `/api/control/relays/${relay.id}/pair`, {
        fingerprint, companies: all ? 'all' : chosen, proof,
      }));
      if (!done) return;
      notifications.show({ color: 'teal', message: t('{name} is paired.', { name: relay.name }) });
      reload();
    } catch (failure) {
      setError(explain(failure));
    }
  };
  return (
    <Stack gap="sm">
      <Text size="sm">{t('Ask the relay\'s operator for its fingerprint, and type at least the first sixteen characters. Pair only if they match.')}</Text>
      <TextInput label={t('The fingerprint the operator shows')} ff="monospace" value={fingerprint} onChange={(event) => setFingerprint(event.currentTarget.value)}
        description={t('{count} of 16 characters', { count: typed.length })} />
      <MultiSelect label={t('Companies it may hear about')} data={companies.map((one) => ({ value: one.id, label: one.name }))}
        value={chosen} onChange={setChosen} disabled={all} searchable />
      <Checkbox label={t('Every company, later ones too')} checked={all} onChange={(event) => setAll(event.currentTarget.checked)} />
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button disabled={typed.length < 16 || (!all && chosen.length === 0)} onClick={() => void pair()}>{t('Pair it')}</Button>
      </Group>
    </Stack>
  );
}

/**
 * What the relay is told and may do. Saved in one press; the server asks for
 * a code only when the change widens something.
 */
function RelayControls({ relay, companies, reload }: { relay: RelayView; companies: Array<{ id: string; name: string }>; reload: () => void }) {
  const requireFactor = useFactor();
  const [share, setShare] = useState<Share>(relay.share);
  const [mayPress, setMayPress] = useState(relay.mayPress);
  const [chosen, setChosen] = useState<string[]>(relay.companies);
  const [all, setAll] = useState(relay.allCompanies);
  const changed = share !== relay.share || mayPress !== relay.mayPress || all !== relay.allCompanies
    || (!all && (chosen.length !== relay.companies.length || chosen.some((one) => !relay.companies.includes(one))));
  const save = async () => {
    try {
      const done = await requireFactor(t('Change what {name} is told', { name: relay.name }), (proof) => api('POST', `/api/control/relays/${relay.id}/settings`, {
        share, mayPress, allCompanies: all, ...(all ? {} : { companies: chosen }), proof,
      }));
      if (done) reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };
  return (
    <Stack gap="sm">
      <Stack gap={4}>
        <Text size="sm" fw={500}>{t('What it is told')}</Text>
        <SegmentedControl value={share} onChange={(value) => setShare(value as Share)} fullWidth
          data={(['signal', 'summary', 'content'] as const).map((value) => ({ value, label: t(SHARE_LABEL[value]) }))} />
        {share !== 'signal' && (
          <Text size="xs" c="dimmed">{t('A public ntfy topic is readable by anyone who guesses its name: above "that something happened", use a relay you trust, or a self-hosted or token-protected ntfy.')}</Text>
        )}
      </Stack>
      <MultiSelect label={t('Companies it may hear about')} data={companies.map((one) => ({ value: one.id, label: one.name }))}
        value={chosen} onChange={setChosen} disabled={all} searchable />
      <Checkbox label={t('Every company, later ones too')} checked={all} onChange={(event) => setAll(event.currentTarget.checked)} />
      <Switch checked={mayPress} onChange={(event) => setMayPress(event.currentTarget.checked)}
        label={t('Presses: approve and deny at tier 2 and below, and answer questions, from a phone linked with its own key')} />
      <Group justify="flex-end">
        <Button size="xs" disabled={!changed || (!all && chosen.length === 0)} onClick={() => void save()}>{t('Save')}</Button>
      </Group>
    </Stack>
  );
}

/** How the relay's envelopes are going, and the ones given up on. */
function Outbox({ relay, reload }: { relay: RelayView; reload: () => void }) {
  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed">
          {t('Sent {delivered}, waiting {pending}, given up {dead}. Last answered {when}.', {
            delivered: relay.outbox.delivered, pending: relay.outbox.pending + relay.outbox.sending, dead: relay.outbox.dead,
            when: relay.lastOkAt ? relative(relay.lastOkAt) : t('never'),
          })}
        </Text>
        <Group gap="xs">
          <ActionButton size="xs" variant="default" label={t('Send a test')} leftSection={<IconSend size={14} />}
            run={() => api('POST', `/api/control/relays/${relay.id}/test`, {})} done={reload} />
          {relay.outbox.dead > 0 && (
            <ActionButton size="xs" variant="light" label={t('Retry')} leftSection={<IconRefresh size={14} />}
              run={() => api('POST', `/api/control/relays/${relay.id}/retry`, {})} done={reload} />
          )}
        </Group>
      </Group>
      {relay.lastError && <Text size="xs" c="red">{relay.lastError}</Text>}
      {relay.dead.length > 0 && (
        <Table.ScrollContainer minWidth={420}>
          <Table verticalSpacing={4} fz="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('Given up')}</Table.Th>
                <Table.Th>{t('Kind')}</Table.Th>
                <Table.Th>{t('Why')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {relay.dead.map((one) => (
                <Table.Tr key={one.id}>
                  <Table.Td>{relative(one.createdAt)}</Table.Td>
                  <Table.Td><Code>{one.type}</Code></Table.Td>
                  <Table.Td>{one.lastError ?? ''}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </Stack>
  );
}
