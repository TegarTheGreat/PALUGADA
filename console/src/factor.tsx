/**
 * The second factor, asked for at the moment of the action (F10.10, F12.5).
 *
 * `requireFactor(what, attempt)` opens a dialog for *this* action and no
 * other: the code the owner types is handed to `attempt`, which is the one
 * request they are confirming. It resolves `true` once that request succeeded
 * and `false` if the owner backed out. Written this way rather than "return a
 * code" because a code is single use: handing one back and letting the caller
 * spend it later is how one ends up spent on a request that was never sent.
 *
 * The attempt lives in the dialog's own state and is replaced, never kept,
 * when the dialog closes -- the Cancel button, Escape, or a click outside. The
 * first console bound its listener by hand and missed Escape, and the next
 * confirmation then submitted the owner's code against the action they had
 * cancelled. A dialog that does the thing the owner backed out of is the
 * worst failure this page could have.
 *
 * A passkey answers the same dialog, offered when the owner has one enrolled
 * and this page is where it works: the device signs a fresh challenge and the
 * signature is handed to `attempt` the way a code is.
 */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { api, explain } from './api.ts';
import { Alert, Button, Divider, Group, Modal, PinInput, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconFingerprint, IconShieldLock } from '@tabler/icons-react';
import type { Proof } from './api.ts';
import { t } from './i18n.ts';
import { atPasskeyAddress, passkeysSupported, presentPasskey, type RelyingParty } from './passkey.ts';

type Attempt = (proof: Proof) => Promise<unknown>;

interface Pending {
  what: string;
  attempt: Attempt;
  resolve: (done: boolean) => void;
}

const FactorContext = createContext<(what: string, attempt: Attempt) => Promise<boolean>>(
  () => Promise.resolve(false),
);

export function useFactor(): (what: string, attempt: Attempt) => Promise<boolean> {
  return useContext(FactorContext);
}

export function FactorProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkey, setPasskey] = useState(false);
  const settled = useRef(false);

  const requireFactor = useCallback((what: string, attempt: Attempt) => new Promise<boolean>((resolve) => {
    settled.current = false;
    setCode('');
    setError(null);
    setPending({ what, attempt, resolve });
    // Asked each time rather than remembered: a passkey added or revoked in
    // another tab is offered, or not, the next time the dialog opens.
    setPasskey(false);
    if (passkeysSupported()) {
      api('GET', '/api/mfa/authenticators').then(
        (answer: { authenticators: Array<{ kind: string }>; passkeys: RelyingParty }) => {
          setPasskey(answer.authenticators.some((one) => one.kind === 'webauthn') && atPasskeyAddress(answer.passkeys));
        },
        () => setPasskey(false),
      );
    }
  }), []);

  const close = (done: boolean) => {
    if (pending && !settled.current) {
      settled.current = true;
      pending.resolve(done);
    }
    setPending(null);
    setCode('');
    setBusy(false);
  };

  const submit = async (value: string) => {
    if (!pending || busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await pending.attempt({ totp: value });
      close(true);
    } catch (failure) {
      // Shown here, where the owner is looking: "that code is wrong", "that
      // has been used" and "locked out" are three different next actions.
      setError(explain(failure));
      setCode('');
      setBusy(false);
    }
  };

  const withPasskey = async () => {
    if (!pending || busy) return;
    setBusy(true);
    setError(null);
    try {
      const challenge: RelyingParty & { challenge: string } = await api('GET', '/api/mfa/challenge');
      await pending.attempt({ webauthn: await presentPasskey(challenge) });
      close(true);
    } catch (failure) {
      setError(explain(failure));
      setBusy(false);
    }
  };

  return (
    <FactorContext.Provider value={requireFactor}>
      {children}
      <Modal
        opened={pending !== null}
        onClose={() => close(false)}
        centered
        radius="md"
        withCloseButton={false}
        size="sm"
      >
        <Stack align="center" gap="md" py="sm">
          <ThemeIcon size={52} radius="xl" variant="light">
            <IconShieldLock size={28} />
          </ThemeIcon>
          <div style={{ textAlign: 'center' }}>
            <Text fw={700} size="lg">{t('Confirm with your authenticator')}</Text>
            <Text c="dimmed" size="sm" mt={4}>{pending?.what}</Text>
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
            disabled={busy}
            error={error !== null}
            aria-label={t('Six-digit code')}
          />
          {passkey && (
            <>
              <Divider label={t('or')} w="100%" />
              <Button fullWidth variant="default" leftSection={<IconFingerprint size={18} />} disabled={busy} onClick={() => void withPasskey()}>
                {t('Use a passkey')}
              </Button>
            </>
          )}
          {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
          <Group justify="flex-end" w="100%" mt="xs">
            <Button variant="default" onClick={() => close(false)}>{t('Cancel')}</Button>
            <Button loading={busy} disabled={code.length !== 6} onClick={() => void submit(code)}>
              {t('Confirm')}
            </Button>
          </Group>
        </Stack>
      </Modal>
    </FactorContext.Provider>
  );
}
