/**
 * Joining a company as staff, from the invite the owner made
 * (src/owner/staff.ts, 0110).
 *
 * The owner's link is `#/join/<code>`; the code is in the fragment, which a
 * browser never sends, so no proxy or server log keeps it. Opened, the page
 * shows a new secret as a QR code; the person adds it to their own
 * authenticator app, types the code the app shows, and is signed in to their
 * seat. Their app is then how they sign in.
 */
import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Center, Code, CopyButton, Loader, Paper, PinInput, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';
import { QrCode } from './Claim.tsx';

/** The invite code in the address the console was opened at, if it was an invite. */
export function joinCode(): string | null {
  const found = /^#\/join\/([A-Za-z2-7]{32})$/.exec(window.location.hash);
  return found ? found[1]!.toUpperCase() : null;
}

interface Offer {
  offer: string;
  secret: string;
  qr: string[];
  seat: { name: string; kind: 'viewer' | 'approver' };
}

export function Join({ code, onSignedIn }: {
  code: string;
  onSignedIn: (session: { token: string; device: string; factor: string }) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  const narrow = useMediaQuery('(max-width: 26em)') ?? false;

  useEffect(() => {
    const opening: Promise<Offer> = api('POST', '/api/auth/join', { code });
    opening.then(setOffer, (failure: unknown) => setError(explain(failure)));
  }, [code]);

  const confirm = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/join/confirm', {
        code, offer: offer?.offer, totp: value,
      });
      // Spent: out of the address bar, and out of the back button's reach.
      window.history.replaceState(null, '', '#/home');
      onSignedIn(session);
    } catch (failure) {
      setError(explain(failure));
      setTotp('');
      setBusy(false);
    }
  };

  const leave = () => {
    window.history.replaceState(null, '', '#/home');
    window.location.reload();
  };

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="md" radius="lg" p={{ base: 'lg', xs: 36 }} w="100%" maw={480}>
        <Stack gap="lg" align="center">
          <img className="brand-mark" src="/brand/palugada-app-icon.svg" alt="" width={56} height={56} />
          <div style={{ textAlign: 'center' }}>
            <Title order={2}>{offer ? t('Welcome, {name}', { name: offer.seat.name }) : t('Join a company')}</Title>
            {offer && (
              <Text c="dimmed" size="sm" mt={6}>
                {offer.seat.kind === 'approver'
                  ? t('You can follow the company\'s work here, and approve or deny what waits at tier 2 and below. Everything else stays the owner\'s.')
                  : t('You can follow the company\'s work here. Changing it stays the owner\'s.')}
              </Text>
            )}
            <Text c="dimmed" size="sm" mt={6}>
              {t('Scan this with your authenticator app, then enter the six-digit code it shows. That app is then how you sign in.')}
            </Text>
          </div>
          {!offer && !error && <Loader />}
          {offer && (
            <>
              <QrCode rows={offer.qr} />
              <Stack gap={4} align="center">
                <Text size="xs" c="dimmed">{t('Cannot scan? Enter this key in the app instead:')}</Text>
                <Code fz="sm">{offer.secret.match(/.{1,4}/g)!.join(' ')}</Code>
                <CopyButton value={offer.secret}>
                  {({ copied, copy }) => (
                    <Anchor component="button" type="button" size="xs" onClick={copy}>{copied ? t('Copied') : t('Copy the key')}</Anchor>
                  )}
                </CopyButton>
              </Stack>
              <PinInput
                length={6}
                type="number"
                oneTimeCode
                size={narrow ? 'md' : 'lg'}
                value={totp}
                onChange={setTotp}
                onComplete={(value) => void confirm(value)}
                error={error !== null}
                disabled={busy}
                aria-label={t('Six-digit code')}
              />
              <Button fullWidth size="md" loading={busy} disabled={totp.length !== 6} onClick={() => void confirm(totp)}>
                {t('Join')}
              </Button>
            </>
          )}
          {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
          {error && !offer && (
            <Anchor component="button" type="button" size="sm" onClick={leave}>{t('Go to sign in')}</Anchor>
          )}
          <Text size="xs" c="dimmed" ta="center">{t('This link works once.')}</Text>
        </Stack>
      </Paper>
    </Center>
  );
}
