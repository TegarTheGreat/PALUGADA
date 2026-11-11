/**
 * The people the owner seats beside them (src/owner/staff.ts, 0110; F19.2,
 * F19.8, F19.21, F19.22): who reads and talks, who also asks for work, and
 * who also approves what is small.
 *
 * A seat is made with the owner's device, one at a time or several at once
 * with one proof, and each invite is shown once: a link the person opens to
 * choose their handle and picture and add PALUGADA to their own
 * authenticator app. The owner names every person, and a name that reads
 * like a colleague's, the owner, PALUGADA, the CEO or a role is refused. A
 * change that lets someone do more takes the owner's code; one that lets
 * them do less, and a rename, does not. Tier 3, every setting, key and
 * device stay the owner's. Ending a seat signs the person out at once.
 */
import { useState } from 'react';
import {
  Alert, Avatar, Badge, Button, CopyButton, Group, Modal, NumberInput, Paper, SegmentedControl, Stack, Table, Text, Textarea, TextInput, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ApiError, api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { t, tp } from '../i18n.ts';
import { personPicture } from '../images.ts';
import type { ConsoleContext } from '../App.tsx';
import { LoadFailed, Loading } from '../components/ui.tsx';
import { kindAbout, kindLabel } from '../workspace/Profile.tsx';
import { FormerPeople, ImportSlack } from '../workspace/ImportSlack.tsx';

type Kind = 'viewer' | 'member' | 'approver';

interface Seat {
  id: string;
  name: string;
  kind: Kind;
  handle: string | null;
  picture: string | null;
  asksPerDay: number;
  joined: boolean;
  invitePending: boolean;
  sharesName: boolean;
  lastUsedAt: string | null;
}

const LADDER: Record<Kind, number> = { viewer: 0, member: 1, approver: 2 };
/** The most people one proof seats, as the owner API holds it. */
const BATCH_MOST = 30;

function KindPicker({ value, onChange }: { value: Kind; onChange: (kind: Kind) => void }) {
  return (
    <Stack gap={4}>
      <SegmentedControl
        value={value}
        onChange={(next) => onChange(next as Kind)}
        data={(['viewer', 'member', 'approver'] as const).map((kind) => ({ value: kind, label: kindLabel(kind) }))}
      />
      <Text size="xs" c="dimmed">{kindAbout(value)}</Text>
    </Stack>
  );
}

/** Links to send, one per person, shown once. */
function Invites({ invites }: { invites: Array<{ name: string; link: string }> }) {
  return (
    <Alert color="teal" variant="light" mt="md"
      title={invites.length === 1 ? t('Send {name} this link', { name: invites[0]!.name }) : t('Send each person their own link')}>
      <Stack gap="xs">
        {invites.map((one) => (
          <Group key={one.link} gap="xs" wrap="nowrap" align="flex-start">
            <div style={{ minWidth: 0, flex: 1 }}>
              {invites.length > 1 && <Text size="sm" fw={600}>{one.name}</Text>}
              <Text size="sm" style={{ wordBreak: 'break-all' }}>{one.link}</Text>
            </div>
            <CopyButton value={one.link}>
              {({ copied, copy }) => <Button size="xs" variant="light" onClick={copy}>{copied ? t('Copied') : t('Copy the link')}</Button>}
            </CopyButton>
          </Group>
        ))}
        <Text size="xs" c="dimmed">{t('Each works once, for a week, and is shown only now. Opening it asks the person to choose a handle and add PALUGADA to their own authenticator app.')}</Text>
      </Stack>
    </Alert>
  );
}

export function People({ ctx }: { ctx: ConsoleContext }) {
  const { companyId } = ctx;
  const requireFactor = useFactor();
  const seats = useLoad<{ seats: Seat[] }>(() => api('GET', `/api/companies/${companyId}/staff`), [companyId]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('member');
  const [several, setSeveral] = useState(false);
  const [names, setNames] = useState('');
  const [invites, setInvites] = useState<Array<{ name: string; link: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  // Which of several names a refusal is about, as the line the owner wrote it on.
  const [refusedLine, setRefusedLine] = useState<{ line: number; name: string } | null>(null);
  const [changing, setChanging] = useState<Seat | null>(null);

  // The fragment is never sent to a server, so no log keeps the invite.
  const linkFor = (invite: string) => `${window.location.origin}/#/join/${invite}`;
  const listed = names.split('\n').map((one) => one.trim()).filter(Boolean);

  const seatOne = async () => {
    setError(null);
    setRefusedLine(null);
    try {
      let made: { invite: string } | null = null;
      const done = await requireFactor(t('Seat {name}', { name: name.trim() }), async (proof) => {
        made = await api('POST', `/api/companies/${companyId}/staff`, { name: name.trim(), kind, proof });
      });
      if (!done || !made) return;
      setInvites([{ name: name.trim(), link: linkFor((made as { invite: string }).invite) }]);
      setName('');
      seats.reload();
    } catch (failure) {
      setError(explain(failure));
    }
  };

  const seatSeveral = async () => {
    setError(null);
    setRefusedLine(null);
    try {
      let made: { seats: Array<{ name: string; invite: string }> } | null = null;
      const done = await requireFactor(tp('Seat {count} person', 'Seat {count} people', listed.length, { count: listed.length }), async (proof) => {
        made = await api('POST', `/api/companies/${companyId}/staff-batch`, { people: listed.map((one) => ({ name: one, kind })), proof });
      });
      if (!done || !made) return;
      setInvites((made as { seats: Array<{ name: string; invite: string }> }).seats.map((one) => ({ name: one.name, link: linkFor(one.invite) })));
      setNames('');
      seats.reload();
    } catch (failure) {
      setError(explain(failure));
      // The API names the person by their place among the names sent, which
      // leaves out blank lines; the owner reads the line they typed it on.
      const index = failure instanceof ApiError ? failure.details.index : undefined;
      if (typeof index === 'number' && listed[index] !== undefined) {
        const lines = names.split('\n');
        const at = lines.map((one, line) => (one.trim() ? line : -1)).filter((line) => line >= 0)[index]!;
        setRefusedLine({ line: at + 1, name: listed[index]! });
      }
    }
  };

  const end = async (one: Seat) => {
    try {
      await api('POST', `/api/companies/${companyId}/staff/${one.id}/revoke`, {});
      notifications.show({ color: 'teal', message: t('{name} is no longer seated, and is signed out.', { name: one.name }) });
      seats.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const sharing = seats.data?.seats.filter((one) => one.sharesName) ?? [];

  return (
    <Stack gap="lg">
      <Paper withBorder radius="lg" p="lg">
        <Title order={4} mb={4}>{t('Seat someone')}</Title>
        <Text size="sm" c="dimmed" mb="md">
          {t('You name each person; they choose their handle and picture. Tier 3, settings, keys and devices stay yours.')}
        </Text>
        <Stack gap="sm">
          <KindPicker value={kind} onChange={setKind} />
          {several ? (
            <>
              <Textarea label={t('Their names, one a line')} autosize minRows={3} maxRows={12} value={names}
                onChange={(event) => { setNames(event.currentTarget.value); setRefusedLine(null); }}
                error={listed.length > BATCH_MOST ? t('Up to thirty people at once.')
                  : refusedLine ? t('Line {line}: {name}', { line: refusedLine.line, name: refusedLine.name }) : undefined} />
              <Group gap="sm">
                <Button disabled={listed.length === 0 || listed.length > BATCH_MOST} onClick={() => void seatSeveral()}>{t('Make the invites')}</Button>
                <Button variant="subtle" onClick={() => setSeveral(false)}>{t('One person')}</Button>
              </Group>
            </>
          ) : (
            <Group align="flex-end" gap="sm" wrap="wrap">
              <TextInput label={t('Their name')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} style={{ flex: 1, minWidth: 180 }} />
              <Button disabled={!name.trim()} onClick={() => void seatOne()}>{t('Make an invite')}</Button>
              <Button variant="subtle" onClick={() => setSeveral(true)}>{t('Several people')}</Button>
            </Group>
          )}
        </Stack>
        {error && (
          <Alert color="red" variant="light" mt="md"
            title={refusedLine ? t('Line {line}: {name}', { line: refusedLine.line, name: refusedLine.name }) : undefined}>{error}</Alert>
        )}
        {invites.length > 0 && <Invites invites={invites} />}
      </Paper>

      <Paper withBorder radius="lg" p="lg">
        <Title order={4} mb="sm">{t('Seated')}</Title>
        {sharing.length > 0 && (
          <Alert color="yellow" variant="light" mb="md">{t('Two people here share a name. Rename one, so nobody is taken for the other.')}</Alert>
        )}
        {seats.error && !seats.data ? <LoadFailed message={seats.error} retry={seats.reload} />
          : !seats.data ? <Loading rows={2} />
          : seats.data.seats.length === 0 ? <Text size="sm" c="dimmed">{t('Nobody but you yet.')}</Text>
          : (
            <Table.ScrollContainer minWidth={680}>
              <Table verticalSpacing="sm">
                <Table.Tbody>
                  {seats.data.seats.map((one) => (
                    <Table.Tr key={one.id}>
                      <Table.Td>
                        <Group gap="sm" wrap="nowrap">
                          <Avatar src={personPicture(`seat:${one.id}`, one.picture)} alt="" size={32} radius="xl" />
                          <div style={{ minWidth: 0 }}>
                            <Group gap={6} wrap="nowrap">
                              <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>{one.name}</Text>
                              {one.sharesName && <Badge size="xs" color="yellow" variant="light">{t('Same name')}</Badge>}
                            </Group>
                            {one.handle && <Text size="xs" c="dimmed">@{one.handle}</Text>}
                          </div>
                        </Group>
                      </Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        <Badge variant="light" color={one.kind === 'approver' ? 'teal' : one.kind === 'member' ? 'blue' : 'gray'}>{kindLabel(one.kind)}</Badge>
                      </Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {one.kind === 'viewer' ? '' : tp('Asks for work up to {count} time a day', 'Asks for work up to {count} times a day', one.asksPerDay, { count: one.asksPerDay })}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {one.joined
                            ? one.lastUsedAt ? t('Last signed in {when}', { when: relative(one.lastUsedAt) }) : t('Joined')
                            : one.invitePending ? t('Invited, not joined yet') : t('The invite expired')}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Group gap={4} justify="flex-end" wrap="nowrap">
                          <Button size="xs" variant="subtle" onClick={() => setChanging(one)}>{t('Change')}</Button>
                          <Button size="xs" variant="subtle" color="red" onClick={() => void end(one)}>{t('End the seat')}</Button>
                        </Group>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
      </Paper>

      <ChangeSeat companyId={companyId} seat={changing} close={() => setChanging(null)} changed={() => { setChanging(null); seats.reload(); }} />

      {/* A Slack workspace's history, and the people it came with, linked to the seats above (STATUS 2.214). */}
      <Paper withBorder radius="lg" p="lg">
        <Title order={4} mb={4}>{t('Import from Slack')}</Title>
        <ImportSlack companyId={companyId} />
      </Paper>
      <FormerPeople companyId={companyId} seats={seats.data?.seats ?? []} />
    </Stack>
  );
}

/**
 * Renaming a person, or changing what they may do. Letting them do more --
 * a kind higher up, more asks a day -- takes the owner's code, as seating them
 * did; the rest takes the session.
 */
function ChangeSeat({ companyId, seat, close, changed }: { companyId: string; seat: Seat | null; close: () => void; changed: () => void }) {
  const requireFactor = useFactor();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('viewer');
  const [asks, setAsks] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<string | null>(null);
  if (seat && shown !== seat.id) {
    setShown(seat.id);
    setName(seat.name);
    setKind(seat.kind);
    setAsks(seat.asksPerDay);
    setError(null);
  }

  const save = async () => {
    if (!seat) return;
    const body: Record<string, unknown> = {};
    if (name.trim() !== seat.name) body.name = name.trim();
    if (kind !== seat.kind) body.kind = kind;
    if (asks !== seat.asksPerDay) body.asksPerDay = asks;
    if (Object.keys(body).length === 0) {
      close();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const widens = LADDER[kind] > LADDER[seat.kind] || asks > seat.asksPerDay;
      if (widens) {
        const done = await requireFactor(t('Let {name} do more', { name: seat.name }),
          (proof) => api('POST', `/api/companies/${companyId}/staff/${seat.id}/change`, { ...body, proof }));
        if (!done) return;
      } else {
        await api('POST', `/api/companies/${companyId}/staff/${seat.id}/change`, body);
      }
      notifications.show({ color: 'teal', message: t('{name} is changed.', { name: name.trim() }) });
      setShown(null);
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={seat !== null} onClose={() => { setShown(null); close(); }} title={seat ? t('Change {name}', { name: seat.name }) : ''} centered>
      <Stack gap="md">
        <TextInput label={t('Their name')} description={t('You set names; people choose only their handle and picture.')}
          value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
        <KindPicker value={kind} onChange={setKind} />
        {kind !== 'viewer' && (
          <NumberInput label={t('Asks for work a day')} description={t('How many times a day they may ask the company for work.')}
            min={0} max={200} value={asks} onChange={(value) => setAsks(typeof value === 'number' ? value : asks)} />
        )}
        {seat && kind !== seat.kind && (
          <Text size="xs" c="dimmed">{t('What they may do changes at once. Their console shows it the next time it is opened.')}</Text>
        )}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={() => { setShown(null); close(); }}>{t('Cancel')}</Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>{t('Save')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
