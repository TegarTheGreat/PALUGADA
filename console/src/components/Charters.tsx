/**
 * The charters a company's runs are told first (F3.1, F3.2), and where the
 * owner rewrites them (F3.6).
 *
 * Nothing could write one before: the only writer was a file import the boot
 * never ran, so every run went out with no rules above its role's. The
 * company's charter is shown under the platform's because that is how every
 * run reads them, and each takes the owner's device to change -- a session
 * alone could otherwise rewrite what every agent obeys.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Badge, Button, Group, Modal, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { dateTime } from '../format.ts';
import { locale, t } from '../i18n.ts';
import type { Charter, Charters as CharterPair } from '../types.ts';
import { LoadFailed, Loading, Section } from './ui.tsx';
import { ConfigHistory } from './ConfigHistory.tsx';

/** The server's bound: every run carries a charter whole, so it is kept short. */
const CHARTER_LIMIT = 20_000;

export function Charters({ companyId }: { companyId: string }) {
  const requireFactor = useFactor();
  const view = useLoad(async () => {
    const answer: CharterPair = await api('GET', `/api/companies/${companyId}/charter`);
    return answer;
  }, [companyId]);
  const [history, setHistory] = useState(false);

  if (view.error && !view.data) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={3} />;

  const saved = (answer: { version: number; unchanged: boolean }) => {
    notifications.show({
      color: 'teal',
      message: answer.unchanged ? t('Nothing changed.') : t('Charter v{version} saved. The next run is told it.', { version: answer.version }),
    });
    view.reload();
  };

  return (
    <Stack gap="lg">
      <CharterEditor
        title={t('Company charter')}
        description={t('What this company is for and how it works. Every run of it is told this first, under the platform charter. Changing it asks for your authenticator, and every version is kept.')}
        current={view.data.company}
        empty={t('This company has no charter yet, so its runs are told only the platform charter. Write what it is for and how it works.')}
        actions={view.data.company && (
          <Button size="compact-sm" variant="subtle" onClick={() => setHistory(true)}>{t('History')}</Button>
        )}
        save={async (body) => {
          let answer: { version: number; unchanged: boolean } | null = null;
          const done = await requireFactor(t('Change the company charter'), async (proof) => {
            answer = await api('POST', `/api/companies/${companyId}/charter`, { body, proof });
          });
          if (done && answer) saved(answer);
          return done;
        }}
      />
      <CharterEditor
        title={t('Platform charter')}
        description={t('The rules every company on this deployment works under, above its own charter. No company can set them aside. Changing it changes what every agent here is told.')}
        current={view.data.platform}
        empty={t('This deployment has no platform charter yet.')}
        save={async (body) => {
          let answer: { version: number; unchanged: boolean } | null = null;
          const done = await requireFactor(t('Change the platform charter'), async (proof) => {
            answer = await api('POST', '/api/control/charter', { body, proof });
          });
          if (done && answer) saved(answer);
          return done;
        }}
      />
      <Modal opened={history} onClose={() => setHistory(false)} title={t('Company charter')} size="lg" centered>
        {history && <ConfigHistory companyId={companyId} kind="charter" changed={view.reload} />}
      </Modal>
    </Stack>
  );
}

function CharterEditor({ title, description, current, empty, actions, save }: {
  title: string;
  description: string;
  current: Charter | null;
  empty: string;
  actions?: ReactNode;
  /** Resolves true when it was saved. */
  save: (body: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(current?.body ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A version saved elsewhere -- a rollback, another tab -- replaces the
  // page's copy only when the owner has not started changing it.
  useEffect(() => { setDraft(current?.body ?? ''); }, [current?.version, current?.body]);

  const text = draft.trim();
  const changed = text !== (current?.body ?? '');
  const tooLong = text.length > CHARTER_LIMIT;

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await save(text);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={title}
      description={description}
      actions={(
        <Group gap="xs">
          {current
            ? <Badge variant="light" color="brand">v{current.version} · {dateTime(current.createdAt)}</Badge>
            : <Badge variant="light" color="gray">{t('None yet')}</Badge>}
          {actions}
        </Group>
      )}
    >
      <Stack gap="sm">
        {!current && <Alert color="orange" variant="light">{empty}</Alert>}
        <Textarea
          aria-label={title}
          autosize
          minRows={8}
          maxRows={24}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
        />
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Text size="xs" c={tooLong ? 'red' : 'dimmed'}>
            {t('{count} of {limit} characters', { count: text.length.toLocaleString(locale()), limit: CHARTER_LIMIT.toLocaleString(locale()) })}
          </Text>
          <Group gap="xs">
            {changed && current && (
              <Button variant="subtle" color="gray" onClick={() => { setDraft(current.body); setError(null); }}>{t('Undo my edits')}</Button>
            )}
            <Button disabled={!changed || !text || tooLong} loading={busy} onClick={() => void submit()}>{t('Save the charter')}</Button>
          </Group>
        </Group>
        {error && <Alert color="red" variant="light">{error}</Alert>}
      </Stack>
    </Section>
  );
}
