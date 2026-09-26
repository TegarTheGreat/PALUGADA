/**
 * Signing in is presenting a second factor. There are no accounts: PALUGADA
 * has one human, so an identity system would be a table with one row and a
 * password to lose.
 */
import { useState } from 'react';
import {
  Alert, Box, Button, Center, Grid, Image, List, Paper, PinInput, Stack, Text, ThemeIcon, Title,
} from '@mantine/core';
import { IconCheck } from '@tabler/icons-react';
import { api } from '../api.ts';

export function SignIn({ onSignedIn }: { onSignedIn: (session: { token: string; device: string }) => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (value: string) => {
    if (value.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session: { token: string; device: string } = await api('POST', '/api/auth/sign-in', { totp: value });
      onSignedIn(session);
    } catch (failure) {
      setError((failure as Error).message);
      setCode('');
      setBusy(false);
    }
  };

  return (
    <Grid gap={0} mih="100vh">
      <Grid.Col span={{ base: 12, md: 6 }} className="signin-art" visibleFrom="md">
        <Center h="100%" p="xl">
          <Stack maw={520} gap="lg">
            <Image src="/illustrations/owner-and-agents.webp" alt="" />
            <Title order={2}>Your companies run themselves. You decide what matters.</Title>
            <List
              spacing="xs"
              icon={<ThemeIcon color="teal" size={22} radius="xl"><IconCheck size={14} /></ThemeIcon>}
            >
              <List.Item>Agents do the work; every irreversible step waits for you.</List.Item>
              <List.Item>Money is reserved before work starts, and can never run away.</List.Item>
              <List.Item>Every decision is kept, searchable, with your reasons.</List.Item>
            </List>
          </Stack>
        </Center>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 6 }}>
        <Center h="100%" mih="100vh" p="md">
          <Paper withBorder shadow="md" radius="lg" p={36} w="100%" maw={440}>
            <Stack gap="lg" align="center">
              <Box className="brand-mark" style={{ width: 48, height: 48, fontSize: 22, borderRadius: 12 }}>P</Box>
              <div style={{ textAlign: 'center' }}>
                <Title order={2}>Welcome back</Title>
                <Text c="dimmed" size="sm" mt={6}>
                  Enter the six-digit code from your authenticator app.
                </Text>
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
                aria-label="Six-digit code"
              />
              {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
              <Button fullWidth size="md" loading={busy} disabled={code.length !== 6} onClick={() => void submit(code)}>
                Sign in
              </Button>
              <Text size="xs" c="dimmed" ta="center">
                The session lives in this tab only. Tier 3 approvals ask for a fresh code every time.
              </Text>
            </Stack>
          </Paper>
        </Center>
      </Grid.Col>
    </Grid>
  );
}
