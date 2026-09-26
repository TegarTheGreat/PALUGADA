/**
 * Signing in is presenting a second factor. There are no accounts: PALUGADA
 * has one human, so an identity system would be a table with one row and a
 * password to lose.
 *
 * The language can be switched here, before signing in, for this visit only:
 * nothing is saved until the owner is in and chooses in the console, where
 * the choice goes to the deployment rather than to the browser.
 */
import { useState } from 'react';
import {
  Alert, Button, Center, Grid, Group, Image, List, Paper, PinInput, SegmentedControl, Stack, Text,
  ThemeIcon, Title, useComputedColorScheme,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { LANGUAGES, language, setLanguage, t, type Language } from '../i18n.ts';

export function SignIn({ onSignedIn }: { onSignedIn: (session: { token: string; device: string }) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const scheme = useComputedColorScheme('light');

  const submit = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session: { token: string; device: string } = await api('POST', '/api/auth/sign-in', { totp: value });
      onSignedIn(session);
    } catch (failure) {
      setError(explain(failure));
      setCode('');
      setBusy(false);
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
          <Paper withBorder shadow="md" radius="lg" p={36} w="100%" maw={440}>
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
                size="lg"
                value={code}
                onChange={setCode}
                onComplete={(value) => void submit(value)}
                error={error !== null}
                disabled={busy}
                aria-label={t('Six-digit code')}
              />
              {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
              <Button fullWidth size="md" loading={busy} disabled={code.length !== 6} onClick={() => void submit(code)}>
                {t('Sign in')}
              </Button>
              <Text size="xs" c="dimmed" ta="center">
                {t('The session lives in this tab only. Tier 3 approvals ask for a fresh code every time.')}
              </Text>
            </Stack>
          </Paper>
        </Center>
      </Grid.Col>
    </Grid>
  );
}
