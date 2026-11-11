/**
 * Joining a company as staff, from the invite the owner made
 * (src/owner/staff.ts, 0110).
 *
 * The owner's link is `#/join/<code>`; the code is in the fragment, which a
 * browser never sends, so no proxy or server log keeps it. Opened, the page
 * first asks how the person will appear (F19.22): the name the owner gave
 * them, shown as it is; the handle colleagues mention them by and they sign
 * in with; a picture; their language and quiet hours; and what joining means
 * for what they write. Then it shows a new secret as a QR code; the person
 * adds it to their own authenticator app, types the code the app shows, and
 * is signed in to their seat. Their app and their handle are then how they
 * sign in.
 *
 * A link the owner made for a seat's new authenticator (STATUS 2.217) is
 * opened `again`: the person chose their handle and picture already, so the
 * page goes straight to the new secret, and what they chose stays.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Anchor, Avatar, Button, Center, Code, CopyButton, Group, Loader, Paper, PinInput, Stack, Text, TextInput, Title,
} from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { api, ApiError, explain } from '../api.ts';
import { isLanguage, language, setLanguage, t } from '../i18n.ts';
import { HANDLE } from '../handles.ts';
import { personPicture } from '../images.ts';
import { kindAbout, kindLabel, LanguagePicker, PicturePicker, QuietHours } from '../workspace/Profile.tsx';
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
  seat: { id: string; name: string; kind: 'viewer' | 'member' | 'approver'; company: string; handle: string | null; again: boolean };
}


export function Join({ code, onSignedIn }: {
  code: string;
  onSignedIn: (session: { token: string; device: string; factor: string }) => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totp, setTotp] = useState('');
  const [busy, setBusy] = useState(false);
  // How the person will appear, chosen before the code.
  const [step, setStep] = useState<'choose' | 'code'>('choose');
  const [handle, setHandle] = useState('');
  const [picture, setPicture] = useState<string | null>(null);
  const [chosenLanguage, setChosenLanguage] = useState<string | null>(null);
  const [quiet, setQuiet] = useState<{ start: number | null; end: number | null }>({ start: null, end: null });
  const narrow = useMediaQuery('(max-width: 26em)') ?? false;

  useEffect(() => {
    const opening: Promise<Offer> = api('POST', '/api/auth/join', { code });
    opening.then((opened) => {
      setOffer(opened);
      // A new authenticator for a seat that joined: nothing to choose again.
      if (opened.seat.again) setStep('code');
    }, (failure: unknown) => setError(explain(failure)));
  }, [code]);

  // The page is drawn in the language they choose, as the console will be.
  const chooseLanguage = (next: string | null) => {
    setChosenLanguage(next);
    if (isLanguage(next) && next !== language()) setLanguage(next);
  };

  const confirm = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/join/confirm', {
        code, offer: offer?.offer, totp: value,
        ...(offer?.seat.again ? {} : { handle }),
        ...(picture ? { picture } : {}),
        ...(chosenLanguage ? { language: chosenLanguage } : {}),
        ...(quiet.start !== null && quiet.end !== null ? { quietStart: quiet.start, quietEnd: quiet.end } : {}),
      });
      // Spent: out of the address bar, and out of the back button's reach.
      window.history.replaceState(null, '', '#/home');
      onSignedIn(session);
    } catch (failure) {
      setError(explain(failure));
      setTotp('');
      setBusy(false);
      // Someone has that handle: back to choosing, where it is.
      if (failure instanceof ApiError && failure.code === 'handle.unusable') setStep('choose');
    }
  };

  const leave = () => {
    window.history.replaceState(null, '', '#/home');
    window.location.reload();
  };

  const principal = offer ? `seat:${offer.seat.id}` : 'seat:';

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="md" radius="lg" p={{ base: 'lg', xs: 36 }} w="100%" maw={480}>
        <Stack gap="lg" align="center">
          <img className="brand-mark" src="/brand/palugada-app-icon.svg" alt="" width={56} height={56} />
          <div style={{ textAlign: 'center' }}>
            <Title order={2}>
              {offer?.seat.again ? t('A new authenticator for {name}', { name: offer.seat.name })
                : offer ? t('Welcome, {name}', { name: offer.seat.name }) : t('Join a company')}
            </Title>
            {offer?.seat.again && (
              <Text c="dimmed" size="sm" mt={6}>
                {offer.seat.handle
                  ? t('You stay @{handle}, in the same rooms and conversations. Add PALUGADA to the authenticator app on your new phone; the old one no longer signs you in.', { handle: offer.seat.handle })
                  : t('You stay in the same rooms and conversations. Add PALUGADA to the authenticator app on your new phone; the old one no longer signs you in.')}
              </Text>
            )}
            {offer && !offer.seat.again && (
              <Text c="dimmed" size="sm" mt={6}>
                {offer.seat.kind === 'approver'
                  ? t('You can follow the company\'s work here, and approve or deny what waits at tier 2 and below. Everything else stays the owner\'s.')
                  : offer.seat.kind === 'member'
                    ? t('You can follow the company\'s work here, ask for work, and answer what is put to you. Everything else stays the owner\'s.')
                    : t('You can follow the company\'s work here. Changing it stays the owner\'s.')}
              </Text>
            )}
          </div>
          {!offer && !error && <Loader />}
          {offer && step === 'choose' && (
            <Stack gap="md" w="100%">
              <Group gap="sm" wrap="nowrap">
                <Avatar src={personPicture(principal, picture)} alt="" size={48} radius="xl" />
                <div style={{ minWidth: 0 }}>
                  <Text fw={600}>{offer.seat.name}{HANDLE.test(handle) ? ` @${handle}` : ''}</Text>
                  <Text size="xs" c="dimmed">{kindLabel(offer.seat.kind)}: {kindAbout(offer.seat.kind)} {t('The owner sets names.')}</Text>
                </div>
              </Group>
              <TextInput name="handle" label={t('Your handle')} description={t('How colleagues mention you, and how you sign in.')}
                leftSection="@" value={handle} maxLength={32} autoComplete="username" required
                error={handle && !HANDLE.test(handle) ? t('3 to 32 letters, digits, dots, dashes or underscores, starting with a letter.') : undefined}
                onChange={(event) => setHandle(event.currentTarget.value.trim().replace(/^@/, '').toLowerCase())} />
              <div>
                <Text size="sm" fw={500} mb={6}>{t('Picture')}</Text>
                <PicturePicker principal={principal} value={picture} onChange={setPicture} />
              </div>
              <LanguagePicker value={chosenLanguage} onChange={chooseLanguage} />
              <QuietHours start={quiet.start} end={quiet.end} onChange={(start, end) => setQuiet({ start, end })} />
              <Text size="xs" c="dimmed">
                {t("What you write here belongs to {company}. The owner can read every room except direct messages they are not in, and the owner's export of the company includes everything, direct messages too. The owner keeps the earlier words of an edited message. Messages to someone who linked a phone also go to that phone's relay, and a notice already sent stays sent after a delete. People can infer how busy the company's rooms are, never what was said or where.", { company: offer.seat.company })}
              </Text>
              <Button fullWidth size="md" disabled={!HANDLE.test(handle)} onClick={() => { setError(null); setStep('code'); }}>
                {t('Continue')}
              </Button>
            </Stack>
          )}
          {offer && step === 'code' && (
            <>
              <Text c="dimmed" size="sm" ta="center">
                {t('Scan this with your authenticator app, then enter the six-digit code it shows. That app is then how you sign in.')}
              </Text>
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
              {!offer.seat.again && (
                <Anchor component="button" type="button" size="sm" onClick={() => setStep('choose')}>{t('Back')}</Anchor>
              )}
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
