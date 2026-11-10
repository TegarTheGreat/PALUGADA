/**
 * Staff seats beside the owner (src/owner/staff.ts, 0110): who can follow
 * this company, and who may also approve what is small.
 *
 * A seat is made with the owner's device, and its invite is shown once: a
 * link the person opens to add PALUGADA to their own authenticator app. A
 * viewer reads; an approver also decides and answers the inbox at tier 2 and
 * below. Tier 3, every setting, key and device stay the owner's. Ending a
 * seat signs the person out at once.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, CopyButton, Group, Paper, SegmentedControl, Stack, Table, Text, TextInput, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import type { ConsoleContext } from '../App.tsx';
import { LoadFailed, Loading } from '../components/ui.tsx';

interface Seat {
  id: string;
  name: string;
  kind: 'viewer' | 'approver';
  joined: boolean;
  invitePending: boolean;
  lastUsedAt: string | null;
}

export function People({ ctx }: { ctx: ConsoleContext }) {
  const { companyId } = ctx;
  const requireFactor = useFactor();
  const seats = useLoad<{ seats: Seat[] }>(() => api('GET', `/api/companies/${companyId}/staff`), [companyId]);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'viewer' | 'approver'>('viewer');
  const [invite, setInvite] = useState<{ name: string; link: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const seat = async () => {
    setError(null);
    try {
      let made: { invite: string } | null = null;
      const done = await requireFactor(t('Seat {name}', { name: name.trim() }), async (proof) => {
        made = await api('POST', `/api/companies/${companyId}/staff`, { name: name.trim(), kind, proof });
      });
      if (!done || !made) return;
      // The fragment is never sent to a server, so no log keeps the invite.
      setInvite({ name: name.trim(), link: `${window.location.origin}/#/join/${(made as { invite: string }).invite}` });
      setName('');
      seats.reload();
    } catch (failure) {
      setError(explain(failure));
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

  return (
    <Stack gap="lg">
      <Paper withBorder radius="lg" p="lg">
        <Title order={4} mb={4}>{t('Seat someone')}</Title>
        <Text size="sm" c="dimmed" mb="md">
          {t('A viewer follows the company\'s work. An approver also approves or denies what waits at tier 2 and below. Tier 3, settings, keys and devices stay yours.')}
        </Text>
        <Group align="flex-end" gap="sm" wrap="wrap">
          <TextInput label={t('Their name')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} style={{ flex: 1, minWidth: 180 }} />
          <SegmentedControl
            value={kind}
            onChange={(value) => setKind(value as 'viewer' | 'approver')}
            data={[{ value: 'viewer', label: t('Viewer') }, { value: 'approver', label: t('Approver') }]}
          />
          <Button disabled={!name.trim()} onClick={() => void seat()}>{t('Make an invite')}</Button>
        </Group>
        {error && <Alert color="red" variant="light" mt="md">{error}</Alert>}
        {invite && (
          <Alert color="teal" variant="light" mt="md" title={t('Send {name} this link', { name: invite.name })}>
            <Stack gap="xs">
              <Text size="sm" style={{ wordBreak: 'break-all' }}>{invite.link}</Text>
              <Text size="xs" c="dimmed">{t('It works once, for a week, and is shown only now. Opening it asks them to add PALUGADA to their own authenticator app.')}</Text>
              <CopyButton value={invite.link}>
                {({ copied, copy }) => <Button size="xs" variant="light" onClick={copy}>{copied ? t('Copied') : t('Copy the link')}</Button>}
              </CopyButton>
            </Stack>
          </Alert>
        )}
      </Paper>

      <Paper withBorder radius="lg" p="lg">
        <Title order={4} mb="sm">{t('Seated')}</Title>
        {seats.error && !seats.data ? <LoadFailed message={seats.error} retry={seats.reload} />
          : !seats.data ? <Loading rows={2} />
          : seats.data.seats.length === 0 ? <Text size="sm" c="dimmed">{t('Nobody but you yet.')}</Text>
          : (
            <Table.ScrollContainer minWidth={420}>
              <Table verticalSpacing="sm">
                <Table.Tbody>
                  {seats.data.seats.map((one) => (
                    <Table.Tr key={one.id}>
                      <Table.Td><Text size="sm" fw={600}>{one.name}</Text></Table.Td>
                      <Table.Td><Badge variant="light" color={one.kind === 'approver' ? 'teal' : 'gray'}>{one.kind === 'approver' ? t('Approver') : t('Viewer')}</Badge></Table.Td>
                      <Table.Td>
                        <Text size="xs" c="dimmed">
                          {one.joined
                            ? one.lastUsedAt ? t('Last signed in {when}', { when: relative(one.lastUsedAt) }) : t('Joined')
                            : one.invitePending ? t('Invited, not joined yet') : t('The invite expired')}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Button size="xs" variant="subtle" color="red" onClick={() => void end(one)}>{t('End the seat')}</Button>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
      </Paper>
    </Stack>
  );
}
