/**
 * The first owner claims the deployment (F12.5, src/owner/claim.ts).
 *
 * A deployment with no owner prints a link as it starts: `#/claim/<code>`.
 * The code is in the fragment, which a browser never sends, so no proxy or
 * server log keeps it. Opened, the page shows a new secret as a QR code; the
 * owner adds it to their authenticator app, types the code the app shows,
 * and is signed in with the deployment's one authenticator.
 */
import { useEffect, useState } from 'react';
import { Alert, Anchor, Button, Center, Code, CopyButton, Loader, Paper, PinInput, Stack, Text, Title } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';

/** The claim code in the address the console was opened at, if it was a claim link. */
export function claimCode(): string | null {
  const found = /^#\/claim\/([A-Za-z2-7]{32})$/.exec(window.location.hash);
  return found ? found[1]!.toUpperCase() : null;
}

interface Offer {
  /** Which opening of the link this is, sent back with the code. */
  offer: string;
  secret: string;
  uri: string;
  qr: string[];
}

/** The modules the server laid out, drawn with the four-module margin a scanner needs. */
function QrCode({ rows }: { rows: string[] }) {
  const size = rows.length + 8;
  const path = rows.flatMap((row, y) => [...row].map((bit, x) => (bit === '1' ? `M${x + 4} ${y + 4}h1v1h-1z` : ''))).join('');
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={216} height={216} role="img" aria-label={t('QR code for your authenticator app')} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function Claim({ code, onSignedIn }: {
  code: string;
  onSignedIn: (session: { token: string; device: string; factor: string }) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  // Six boxes at the large size are wider than a phone's card.
  const narrow = useMediaQuery('(max-width: 26em)') ?? false;

  useEffect(() => {
    const opening: Promise<Offer> = api('POST', '/api/auth/claim', { code });
    opening.then(setOffer, (failure: unknown) => setError(explain(failure)));
  }, [code]);

  const confirm = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Which opening's secret the app holds: only that one can be confirmed (B3).
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/claim/confirm', {
        code, offer: offer?.offer, totp: value, label: t('Authenticator app'),
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
            <Title order={2}>{t('Make this deployment yours')}</Title>
            <Text c="dimmed" size="sm" mt={6}>
              {t('Scan this with your authenticator app, then enter the six-digit code it shows. That app is then how you sign in and approve.')}
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
                {t('Become the owner')}
              </Button>
            </>
          )}
          {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
          {error && !offer && (
            <Anchor component="button" type="button" size="sm" onClick={leave}>{t('Go to sign in')}</Anchor>
          )}
          <Text size="xs" c="dimmed" ta="center">
            {t('This link works once. When you are in, add a second device and make recovery codes under Settings, Security, so losing this phone does not lock you out.')}
          </Text>
        </Stack>
      </Paper>
    </Center>
  );
}
