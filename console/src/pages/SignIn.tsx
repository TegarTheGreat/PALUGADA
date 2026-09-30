/**
 * Signing in is presenting a second factor. There are no accounts: PALUGADA
 * has one human, so an identity system would be a table with one row and a
 * password to lose.
 *
 * A code or a passkey. The passkey is offered wherever the browser can use
 * one; which device holds it is the device's business, since there is no
 * account to name -- the owner's device offers the passkey it made here.
 *
 * The language can be switched here, before signing in, for this visit only:
 * nothing is saved until the owner is in and chooses in the console, where
 * the choice goes to the deployment rather than to the browser.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Anchor, Button, Center, Divider, Grid, Group, Image, List, Paper, PinInput, SegmentedControl, Stack, Text,
  TextInput, ThemeIcon, Title, useComputedColorScheme,
} from '@mantine/core';
import { IconCheck, IconFingerprint } from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import { api, explain } from '../api.ts';
import { LANGUAGES, language, setLanguage, t, type Language } from '../i18n.ts';
import { passkeysSupported, presentPasskey, type RelyingParty } from '../passkey.ts';
import { Claim, claimCode } from './Claim.tsx';

export function SignIn({ onSignedIn }: { onSignedIn: (session: { token: string; device: string; factor: string }) => void }) {
  // Opened from the link a deployment with no owner printed as it started --
  // or pasted into a tab already showing this page, which changes only the
  // fragment and loads nothing.
  const [claim, setClaim] = useState(claimCode);
  useEffect(() => {
    const changed = () => setClaim(claimCode());
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  if (claim) return <Claim code={claim} onSignedIn={onSignedIn} />;
  return <Door onSignedIn={onSignedIn} />;
}

function Door({ onSignedIn }: { onSignedIn: (session: { token: string; device: string; factor: string }) => void }) {
  const [code, setCode] = useState('');
  // Six boxes at the large size are wider than a phone's card.
  const narrow = useMediaQuery('(max-width: 26em)') ?? false;
  // No owner yet: nothing on this page can open it, and the owner is told where the way in is.
  const [claimable, setClaimable] = useState(false);
  useEffect(() => {
    const asking: Promise<{ claimable?: boolean }> = api('GET', '/api/auth/challenge');
    asking.then((answer) => setClaimable(answer.claimable === true), () => undefined);
  }, []);
  const [error, setError] = useState<{ message: string; from: 'code' | 'passkey' | 'recovery' } | null>(null);
  const [busy, setBusy] = useState<'code' | 'passkey' | 'recovery' | null>(null);
  // The phone is gone: one of the codes written down on the day.
  const [recovering, setRecovering] = useState(false);
  const [recovery, setRecovery] = useState('');

  const withRecovery = async () => {
    if (!recovery.trim() || busy) return;
    setBusy('recovery');
    setError(null);
    try {
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/sign-in', { recovery: recovery.trim() });
      onSignedIn(session);
    } catch (failure) {
      setError({ message: explain(failure), from: 'recovery' });
      setBusy(null);
    }
  };
  const scheme = useComputedColorScheme('light');

  const submit = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy('code');
    setError(null);
    try {
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/sign-in', { totp: value });
      onSignedIn(session);
    } catch (failure) {
      setError({ message: explain(failure), from: 'code' });
      setCode('');
      setBusy(null);
    }
  };

  const withPasskey = async () => {
    if (busy) return;
    setBusy('passkey');
    setError(null);
    try {
      const challenge: RelyingParty & { challenge: string } = await api('GET', '/api/auth/challenge');
      const webauthn = await presentPasskey(challenge);
      const session: { token: string; device: string; factor: string } = await api('POST', '/api/auth/sign-in', { webauthn });
      onSignedIn(session);
    } catch (failure) {
      // Said below the buttons, and not drawn on the code: the code was not
      // what went wrong.
      setError({ message: explain(failure), from: 'passkey' });
      setBusy(null);
    }
  };

  return (
    <Grid gap={0} mih="100vh">
      <Grid.Col span={{ base: 12, md: 6 }} className="signin-art" visibleFrom="md">
        <Center h="100%" p="xl">
          <Stack maw={520} gap="lg">
            <img
              className="brand-lockup"
              src={scheme === 'dark' ? '/brand/palugada-lockup-on-dark.svg' : '/brand/palugada-lockup.svg'}
              alt="PALUGADA"
              height={34}
            />
            <Image src="/illustrations/owner-and-agents.webp" alt="" />
            <Title order={2}>{t('Your companies run themselves. You decide what matters.')}</Title>
            <List
              spacing="xs"
              icon={<ThemeIcon color="teal" size={22} radius="xl"><IconCheck size={14} /></ThemeIcon>}
            >
              <List.Item>{t('Agents do the work; every irreversible step waits for you.')}</List.Item>
              <List.Item>{t('Money is reserved before work starts, and can never run away.')}</List.Item>
              <List.Item>{t('Every decision is kept, searchable, with your reasons.')}</List.Item>
            </List>
          </Stack>
        </Center>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 6 }}>
        <Center h="100%" mih="100vh" p="md" pos="relative">
          <Group pos="absolute" top={16} right={16}>
            <SegmentedControl
              size="xs"
              value={language()}
              onChange={(value) => setLanguage(value as Language)}
              data={LANGUAGES.map((one) => ({ value: one.code, label: one.code.toUpperCase() }))}
              aria-label={t('Language')}
            />
          </Group>
          <Paper withBorder shadow="md" radius="lg" p={{ base: 'lg', xs: 36 }} w="100%" maw={440}>
            <Stack gap="lg" align="center">
              <img className="brand-mark" src="/brand/palugada-app-icon.svg" alt="" width={56} height={56} />
              <div style={{ textAlign: 'center' }}>
                <Title order={2}>{t('Welcome back')}</Title>
                <Text c="dimmed" size="sm" mt={6}>{t('Enter the six-digit code from your authenticator app.')}</Text>
              </div>
              <PinInput
                length={6}
                type="number"
                oneTimeCode
                autoFocus
                size={narrow ? 'md' : 'lg'}
                value={code}
                onChange={setCode}
                onComplete={(value) => void submit(value)}
                error={error?.from === 'code'}
                disabled={busy !== null}
                aria-label={t('Six-digit code')}
              />
              {claimable && (
                <Alert color="blue" variant="light" w="100%" title={t('This deployment has no owner yet')}>
                  {t('Open the link PALUGADA printed in its log when it started. It ends in /#/claim/ and a code, and makes whoever opens it first the owner.')}
                </Alert>
              )}
              {error && <Alert color="red" variant="light" w="100%">{error.message}</Alert>}
              <Button fullWidth size="md" loading={busy === 'code'} disabled={code.length !== 6 || busy === 'passkey'} onClick={() => void submit(code)}>
                {t('Sign in')}
              </Button>
              {passkeysSupported() && (
                <>
                  <Divider label={t('or')} w="100%" />
                  <Button
                    fullWidth
                    size="md"
                    variant="default"
                    leftSection={<IconFingerprint size={18} />}
                    loading={busy === 'passkey'}
                    disabled={busy === 'code'}
                    onClick={() => void withPasskey()}
                  >
                    {t('Sign in with a passkey')}
                  </Button>
                </>
              )}
              {recovering ? (
                <Stack gap="xs" w="100%">
                  <TextInput label={t('Recovery code')} placeholder="abcd-efgh-ijkl-mnop" value={recovery} autoComplete="off"
                    onChange={(event) => setRecovery(event.currentTarget.value)} error={error?.from === 'recovery'} disabled={busy !== null}
                    onKeyDown={(event) => { if (event.key === 'Enter') void withRecovery(); }} />
                  <Button fullWidth variant="light" loading={busy === 'recovery'} disabled={!recovery.trim() || busy !== null} onClick={() => void withRecovery()}>
                    {t('Sign in with a recovery code')}
                  </Button>
                </Stack>
              ) : (
                <Anchor component="button" type="button" size="sm" onClick={() => setRecovering(true)}>{t('Lost your phone? Use a recovery code')}</Anchor>
              )}
              <Text size="xs" c="dimmed" ta="center">
                {t('The session lives in this tab only. Tier 3 approvals ask for your authenticator every time.')}
              </Text>
            </Stack>
          </Paper>
        </Center>
      </Grid.Col>
    </Grid>
  );
}
