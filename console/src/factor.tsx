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
import { api, ApiError, explain } from './api.ts';
import { useMediaQuery } from '@mantine/hooks';
import { Alert, Anchor, Button, Divider, Group, Modal, PinInput, Stack, Text, TextInput, ThemeIcon, getDefaultZIndex } from '@mantine/core';
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
  // Six boxes of the larger size are wider than this dialog on a phone.
  const narrow = useMediaQuery('(max-width: 26em)') ?? false;
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkey, setPasskey] = useState(false);
  // A recovery code instead of the phone: what the owner has after losing it.
  const [recovering, setRecovering] = useState(false);
  const [recovery, setRecovery] = useState('');
  const settled = useRef(false);

  const ask = useCallback((what: string, attempt: Attempt, said: string | null) => new Promise<boolean>((resolve) => {
    settled.current = false;
    setCode('');
    setRecovery('');
    setRecovering(false);
    setError(said);
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

  /**
   * A code shown a few minutes ago still covers what builds the company
   * (0120). While the session says it is inside that window the action is
   * tried without one: the server decides what the window covers, and refuses
   * the rest before doing anything, which opens the dialog as it always did.
   * A failure that is not that refusal -- a name taken, a field wrong -- is
   * shown in the dialog, where the owner has always read them.
   */
  const requireFactor = useCallback(async (what: string, attempt: Attempt): Promise<boolean> => {
    let said: string | null = null;
    try {
      const me: { stepUp?: { until: string | null } } = await api('GET', '/api/me');
      if (me.stepUp?.until) {
        try {
          // `Proof` is what a dialog hands over; here there is none, and the route is told so by leaving it out.
          await attempt(undefined as unknown as Proof);
          return true;
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.code === 'approval.channel_forbidden')) said = explain(failure);
        }
      }
    } catch {
      // The window is not known: ask, as before.
    }
    return ask(what, attempt, said);
  }, [ask]);

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

  const withRecovery = async () => {
    if (!pending || busy || !recovery.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await pending.attempt({ recovery: recovery.trim() });
      close(true);
    } catch (failure) {
      setError(explain(failure));
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
      {/* Above every other dialog: the action it confirms is often pressed
          inside one (starting a company, from its own dialog), and on the
          same layer that dialog stayed on top of this one, so the owner
          pressed and saw nothing happen. */}
      <Modal
        opened={pending !== null}
        onClose={() => close(false)}
        zIndex={getDefaultZIndex('modal') + 10}
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
            size={narrow ? 'sm' : 'lg'}
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
          {recovering ? (
            <TextInput w="100%" label={t('Recovery code')} placeholder="abcd-efgh-ijkl-mnop" value={recovery} autoComplete="off"
              onChange={(event) => setRecovery(event.currentTarget.value)} disabled={busy}
              description={t('Each code works once. It adds a device or takes a lost one off; it does not approve.')} />
          ) : (
            <Anchor component="button" type="button" size="xs" onClick={() => setRecovering(true)}>{t('Lost your phone? Use a recovery code')}</Anchor>
          )}
          {error && <Alert color="red" variant="light" w="100%">{error}</Alert>}
          <Group justify="flex-end" w="100%" mt="xs">
            <Button variant="default" onClick={() => close(false)}>{t('Cancel')}</Button>
            {recovering ? (
              <Button loading={busy} disabled={!recovery.trim()} onClick={() => void withRecovery()}>{t('Confirm')}</Button>
            ) : (
              <Button loading={busy} disabled={code.length !== 6} onClick={() => void submit(code)}>
                {t('Confirm')}
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </FactorContext.Provider>
  );
}
