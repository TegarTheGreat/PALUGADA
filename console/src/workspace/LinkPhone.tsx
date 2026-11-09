/**
 * Link a phone (F19.19, F19.20; STATUS section 2.208): a person's own phone,
 * linked through a relay, so PALUGADA tells it what that person is owed.
 *
 * Nothing is sent on anyone's behalf until they link a device themselves.
 * The person asks for a code, eight characters good for ten minutes, and
 * enters it (or scans it) in the relay's app; the owner's code takes a factor
 * given now, since the owner's phone may decide things. The same component
 * serves the owner on the Relays section and, later, every person on their
 * profile; it shows only the caller's own links.
 */
import { useState } from 'react';
import { Alert, Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { dateTime, relative } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton } from '../components/ActionForm.tsx';

interface Links {
  links: Array<{ id: string; relayId: string; relay: string; label: string | null; status: 'offered' | 'active'; device: boolean; claimedAt: string | null }>;
  relays: Array<{ id: string; name: string }>;
}

/** The code as a picture the relay's app can scan. */
function LinkQr({ rows }: { rows: string[] }) {
  const size = rows.length + 8;
  const path = rows.flatMap((row, y) => [...row].map((bit, x) => (bit === '1' ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join('');
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={180} height={180} role="img" aria-label={t('QR code for the relay\'s app')} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function LinkPhone({ relayId, relayName }: { relayId: string; relayName: string }) {
  const requireFactor = useFactor();
  const view = useLoad(async (): Promise<Links> => api('GET', '/api/relays/links'), [relayId]);
  const [offered, setOffered] = useState<{ code: string; qr: string[]; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const link = async () => {
    setError(null);
    try {
      let answer: { code: string; qr: string[]; expiresAt: string } | null = null;
      const done = await requireFactor(t('Link a phone through {name}', { name: relayName }), async (proof) => {
        answer = await api('POST', '/api/relays/links', { relayId, proof });
      });
      if (done && answer) {
        setOffered(answer);
        view.reload();
      }
    } catch (failure) {
      setError(explain(failure));
    }
  };

  const mine = (view.data?.links ?? []).filter((one) => one.relayId === relayId && one.status === 'active');
  return (
    <Stack gap="xs">
      <Group justify="space-between" wrap="wrap">
        <Group gap="xs">
          <IconDeviceMobile size={18} stroke={1.7} />
          <Text size="sm" fw={500}>{t('Your phone')}</Text>
        </Group>
        <Button size="xs" variant="light" onClick={() => void link()}>{t('Link a phone')}</Button>
      </Group>
      {mine.length === 0 && !offered && (
        <Text size="xs" c="dimmed">{t('No phone is linked through this relay. Nothing is sent to it on your behalf until you link one.')}</Text>
      )}
      {mine.map((one) => (
        <Group key={one.id} justify="space-between" wrap="wrap">
          <Group gap="xs">
            <Text size="sm">{one.label ?? t('A phone')}</Text>
            {one.device
              ? <Badge size="sm" color="teal" variant="light">{t('Signed by the phone')}</Badge>
              : <Badge size="sm" color="orange" variant="light">{t('Told only: no key of its own')}</Badge>}
            {one.claimedAt && <Text size="xs" c="dimmed">{relative(one.claimedAt)}</Text>}
          </Group>
          <ActionButton size="xs" color="red" variant="subtle" label={t('Unlink')}
            run={() => api('POST', `/api/relays/links/${one.id}/end`, {})} done={view.reload} />
        </Group>
      ))}
      {offered && (
        <Stack gap={4} align="flex-start">
          <Text size="sm">{t('Enter this code in the relay\'s app, or scan it, before {when}.', { when: dateTime(offered.expiresAt) })}</Text>
          <Code fz="xl" style={{ letterSpacing: '0.2em' }}>{offered.code}</Code>
          <LinkQr rows={offered.qr} />
        </Stack>
      )}
      {error && <Alert color="red" variant="light">{error}</Alert>}
    </Stack>
  );
}
