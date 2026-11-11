/**
 * Link a phone (F19.19, F19.20; STATUS section 2.208): a person's own phone,
 * linked through a relay, so PALUGADA tells it what that person is owed.
 *
 * Nothing is sent on anyone's behalf until they link a device themselves.
 * The person asks for a code, eight characters good for ten minutes, and
 * enters it (or scans it) in the relay's app; the owner's code takes a factor
 * given now, since the owner's phone may decide things; a seat's needs none.
 * The same component serves the owner on the Relays section and every person
 * in their profile (`PhoneLinks`, STATUS section 2.213); it shows only the
 * caller's own links.
 *
 * While a code is on the screen the links are read again every few seconds,
 * so the moment the relay's app claims it the code goes and the profile says
 * which phone is linked; a code that runs out unclaimed goes too, and says so
 * (STATUS 2.218).
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Code, Group, Stack, Text } from '@mantine/core';
import { IconDeviceMobile } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { dateTime, relative } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton } from '../components/ActionForm.tsx';

interface Links {
  links: Array<{
    id: string; relayId: string; relay: string; label: string | null; status: 'offered' | 'active'; device: boolean;
    /** The device key's fingerprint, to compare with what the phone shows (STATUS section 2.216). */
    deviceFingerprint: string | null; claimedAt: string | null;
  }>;
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

/** How often the links are read again while a code waits to be claimed. */
const CLAIM_EVERY_MS = 3_000;

export function LinkPhone({ relayId, relayName }: { relayId: string; relayName: string }) {
  const requireFactor = useFactor();
  const view = useLoad(async (): Promise<Links> => api('GET', '/api/relays/links'), [relayId]);
  const [offered, setOffered] = useState<{ code: string; qr: string[]; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What became of the last code: the phone it linked, or that it ran out.
  const [outcome, setOutcome] = useState<{ linked: string } | { expired: true } | null>(null);
  // The phones already linked when the code was offered, so the one that claims it is told apart.
  const before = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!offered) return undefined;
    const timer = window.setInterval(() => {
      if (Date.now() >= new Date(offered.expiresAt).getTime()) {
        setOffered(null);
        setOutcome({ expired: true });
        return;
      }
      view.reload();
    }, CLAIM_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [offered]);
  useEffect(() => {
    if (!offered || !view.data) return;
    const claimed = view.data.links.find((one) => one.relayId === relayId && one.status === 'active' && !before.current.has(one.id));
    if (!claimed) return;
    setOffered(null);
    setOutcome({ linked: claimed.label ?? t('A phone') });
  }, [view.data]);

  const link = async () => {
    setError(null);
    try {
      let answer: { code: string; qr: string[]; expiresAt: string } | null = null;
      const done = await requireFactor(t('Link a phone through {name}', { name: relayName }), async (proof) => {
        answer = await api('POST', '/api/relays/links', { relayId, proof });
      });
      if (done && answer) {
        before.current = new Set((view.data?.links ?? []).filter((one) => one.status === 'active').map((one) => one.id));
        setOutcome(null);
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
            {one.deviceFingerprint && (
              <Text size="xs" c="dimmed" ff="monospace">{t('Its key: {fingerprint}', { fingerprint: one.deviceFingerprint.replace(/(.{4})(?!$)/g, '$1 ') })}</Text>
            )}
          </Group>
          <ActionButton size="xs" color="red" variant="subtle" label={t('Unlink')}
            run={() => api('POST', `/api/relays/links/${one.id}/end`, {})} done={view.reload} />
        </Group>
      ))}
      {outcome && 'linked' in outcome && (
        <Alert color="teal" variant="light" data-linked>{t('Linked: {label}', { label: outcome.linked })}</Alert>
      )}
      {outcome && 'expired' in outcome && (
        <Text size="xs" c="dimmed">{t('That code ran out before a phone used it. Ask for another to link one.')}</Text>
      )}
      {offered && (
        <Stack gap={4} align="flex-start">
          <Text size="sm">{t('Enter this code in the relay\'s app, or scan it, before {when}.', { when: dateTime(offered.expiresAt) })}</Text>
          <Code fz="xl" style={{ letterSpacing: '0.2em' }} data-link-code>{offered.code}</Code>
          <LinkQr rows={offered.qr} />
        </Stack>
      )}
      {error && <Alert color="red" variant="light">{error}</Alert>}
    </Stack>
  );
}

/**
 * A person's phones, in their profile (STATUS section 2.213): every relay
 * they may link one through -- paired, and hearing about their company --
 * each with its own Link a phone and the links already made. Linking is done
 * at once, apart from the profile's Save.
 */
export function PhoneLinks() {
  const view = useLoad(async (): Promise<Links> => api('GET', '/api/relays/links'), []);
  const relays = view.data?.relays ?? [];
  return (
    <Stack gap="sm">
      <Text size="sm" fw={500}>{t('Phones')}</Text>
      <Text size="xs" c="dimmed">
        {t('A phone you link is told who wrote to you or mentioned you, and what waits for you. Nothing is sent to it until you link it.')}
      </Text>
      {view.data && relays.length === 0 && (
        <Text size="xs" c="dimmed">{t('No relay is paired for this company yet: the owner pairs one in This deployment, Relays.')}</Text>
      )}
      {relays.map((relay) => (
        <Stack key={relay.id} gap={4}>
          {relays.length > 1 && <Text size="xs" fw={500}>{relay.name}</Text>}
          <LinkPhone relayId={relay.id} relayName={relay.name} />
        </Stack>
      ))}
    </Stack>
  );
}
