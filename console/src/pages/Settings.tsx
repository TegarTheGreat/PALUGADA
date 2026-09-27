/**
 * The company's settings, and the owner's own (F1.5, F9.5, F9.6, F11.5,
 * F11.6, F12.5): hours, cheap hours, retention, alert thresholds, freezing
 * and exporting; languages; authenticators and sessions.
 *
 * Each is a section of the settings page (SettingsHub), not a page of its
 * own: an owner changes these rarely and should find them all in one place.
 */
import { Alert, Badge, Button, Grid, Group, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconFingerprint, IconLanguage, IconShieldCheck, IconSnowflake, IconSnowflakeOff } from '@tabler/icons-react';
import { useState } from 'react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { day } from '../format.ts';
import { LANGUAGES, isLanguage, language, t } from '../i18n.ts';
import { chooseLanguage, type ConsoleContext, type Languages } from '../App.tsx';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';
import { atPasskeyAddress, makePasskey, passkeysSupported, type PasskeyOptions, type RelyingParty } from '../passkey.ts';

const ZONES = ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const zoneOptions = ZONES.map((zone) => ({ value: zone, label: zone }));

export function CompanySettings({ ctx }: { ctx: ConsoleContext }) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [window_, retention]: [
      { timezone: string; startHour: number; endHour: number },
      { policy: { eventDays: number; traceDays: number; promptDays: number }; log: Array<{ action: string; rowsAffected: number; throughAt: string }> },
    ] = await Promise.all([
      api('GET', '/api/control/owner-window'),
      api('GET', `/api/companies/${companyId}/retention`),
    ]);
    return { window: window_, retention };
  }, [companyId]);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={4} />;
  const { retention } = view.data;

  const exportCompany = async () => {
    try {
      const dump: unknown = await api('GET', `/api/companies/${companyId}/export`);
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${ctx.company.slug}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  return (
    <Stack gap="lg">
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Your hours')} description={t('Nothing that is not an incident reaches you outside them.')}>
            <ActionForm
              columns={3}
              fields={[
                { name: 'timezone', label: t('Time zone'), type: 'select', required: true, initial: view.data.window.timezone, options: zoneOptions },
                { name: 'startHour', label: t('From'), type: 'number', required: true, initial: view.data.window.startHour },
                { name: 'endHour', label: t('To'), type: 'number', required: true, initial: view.data.window.endHour },
              ]}
              submit={(values) => api('POST', '/api/control/owner-window', values)}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Cheap hours')} description={t('Work marked non-urgent, that only reads, waits for this window.')}>
            <ActionForm
              columns={3}
              fields={[
                { name: 'timezone', label: t('Time zone'), type: 'select', required: true, initial: 'UTC', options: zoneOptions },
                { name: 'startHour', label: t('From'), type: 'number', required: true, initial: 2 },
                { name: 'endHour', label: t('To'), type: 'number', required: true, initial: 5 },
              ]}
              submit={(values) => api('POST', `/api/companies/${companyId}/batch-window`, values)}
            />
          </Section>
        </Grid.Col>
      </Grid>

      <Section title={t('Retention')} description={t("How long the company's history is kept. Events at least a year, prompts at least ninety days; the purge records what it removed.")}>
        <ActionForm
          columns={3}
          fields={[
            { name: 'eventDays', label: t('Events, days'), type: 'number', initial: retention.policy.eventDays },
            { name: 'traceDays', label: t('Traces, days'), type: 'number', initial: retention.policy.traceDays },
            { name: 'promptDays', label: t('Prompts, days'), type: 'number', initial: retention.policy.promptDays },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/retention`, values)}
        />
        {retention.log.length > 0 && (
          <Table mt="md" verticalSpacing={6}>
            <Table.Tbody>
              {retention.log.map((row, index) => (
                <Table.Tr key={index}>
                  <Table.Td>{row.action}</Table.Td>
                  <Table.Td>{t('{count} rows', { count: row.rowsAffected })}</Table.Td>
                  <Table.Td>{t('through {day}', { day: day(row.throughAt) })}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>

      <Section title={t('Alert thresholds')} description={t('When the company tells you something is going wrong, before it becomes an incident.')}>
        <ActionForm
          columns={3}
          fields={[
            { name: 'dailyCostCents', label: t('Daily cost, cents'), type: 'number' },
            { name: 'taskFailureRate', label: t('Failure rate, 0 to 1'), type: 'number' },
            { name: 'policyDenialsPerDay', label: t('Policy denials a day'), type: 'number' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/alert-thresholds`, values)}
        />
      </Section>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Freeze this company')} description={t('Nothing of theirs starts while it is frozen; work in progress stops at its next step. Unfreezing takes your authenticator.')}>
            <Group>
              <ActionButton label={t('Freeze')} color="red" variant="light" leftSection={<IconSnowflake size={16} />}
                run={() => api('POST', `/api/control/company/${companyId}/freeze`, { on: true })}
                done={() => { notifications.show({ color: 'red', message: t('{company} is frozen.', { company: ctx.company.name }) }); void ctx.refreshCompanies(); }} />
              <ActionButton label={t('Unfreeze')} leftSection={<IconSnowflakeOff size={16} />} factor={t('Unfreeze the company')}
                run={(proof) => api('POST', `/api/control/company/${companyId}/freeze`, { on: false, proof })}
                done={() => { notifications.show({ color: 'teal', message: t('{company} is running.', { company: ctx.company.name }) }); void ctx.refreshCompanies(); }} />
            </Group>
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Export')} description={t('The whole company as one file, restorable on another installation with every reference remapped.')}>
            <Group><Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportCompany()}>{t('Download as JSON')}</Button></Group>
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

export function SecuritySettings() {
  const view = useLoad(async () => {
    const answer: { authenticators: Array<{ id: string; label: string; kind: string }>; passkeys: RelyingParty } = await api('GET', '/api/mfa/authenticators');
    return answer;
  }, []);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={2} />;
  const { authenticators, passkeys } = view.data;
  return (
    <Stack gap="lg">
      <Section title={t('Your authenticators')} description={t('What can approve a tier 3 action in your name. Revoking takes a code from a device that is staying, and ends every session the revoked one signed in.')}>
        {authenticators.length === 0 ? <Text size="sm" c="red">{t('None enrolled. No tier 3 action can be approved until one is.')}</Text> : (
          <Table verticalSpacing="sm">
            <Table.Tbody>
              {authenticators.map((one) => (
                <Table.Tr key={one.id}>
                  <Table.Td>
                    <Group gap="xs">
                      {one.kind === 'webauthn' ? <IconFingerprint size={16} /> : <IconShieldCheck size={16} />}
                      <Text size="sm" fw={600}>{one.label}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td><Badge variant="light">{one.kind === 'webauthn' ? t('Passkey') : t('Authenticator app')}</Badge></Table.Td>
                  <Table.Td ta="right">
                    <ActionButton size="xs" color="red" variant="subtle" label={t('Revoke')} factor={t('Revoke {label}', { label: one.label })}
                      run={(proof) => api('POST', `/api/mfa/authenticators/${one.id}/revoke`, { proof })} done={view.reload} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>
      <AddPasskey party={passkeys} added={view.reload} />
      <Section title={t('Sessions')} description={t('Every browser signed in to this console, on every device. Signing out everywhere ends all of them, this one included.')}>
        <ActionButton label={t('Sign out everywhere')} color="red" variant="light" run={() => api('POST', '/api/auth/sign-out-everywhere', {})} done={() => window.location.reload()} />
      </Section>
    </Stack>
  );
}

/**
 * A passkey on the device the owner is using now.
 *
 * Behind a factor the owner already holds, because the API asks for one: a
 * signed-in browser alone must not be able to add a key that outlives its
 * session. When this page cannot make one, it says why, since the fix -- open
 * the console at its own address, over HTTPS -- is not something the button
 * could do.
 */
function AddPasskey({ party, added }: { party: RelyingParty; added: () => void }) {
  const [label, setLabel] = useState('');
  const why = !passkeysSupported()
    ? t('This browser cannot make a passkey here. Passkeys need the console over HTTPS, or on localhost, in a browser that supports them.')
    : !atPasskeyAddress(party)
      ? t('Passkeys for this console are made at {origin}. Open the console there to add one.', { origin: party.origin })
      : null;
  return (
    <Section title={t('Passkeys')} description={t('Sign in and approve with your fingerprint, face or screen lock instead of typing a code. The passkey stays on your device; only its public half is kept here.')}>
      {why ? <Text size="sm" c="dimmed">{why}</Text> : (
        <Group align="flex-end" gap="sm">
          <TextInput
            label={t('Name this device')}
            placeholder={t('For example: work laptop')}
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
            maxLength={80}
            w={280}
          />
          <ActionButton
            label={t('Add a passkey')}
            variant="light"
            leftSection={<IconFingerprint size={16} />}
            factor={t('Add a passkey named {label}', { label: label.trim() || t('Passkey') })}
            run={async (proof) => {
              const options: PasskeyOptions = await api('GET', '/api/mfa/passkeys/options');
              const credential = await makePasskey(options, party);
              await api('POST', '/api/mfa/passkeys', { label: label.trim() || t('Passkey'), credential, proof });
            }}
            done={() => {
              notifications.show({ color: 'teal', message: t('Passkey added. You can sign in with it now.') });
              setLabel('');
              added();
            }}
          />
        </Group>
      )}
    </Section>
  );
}

/**
 * Four languages, because they are four different questions -- and an agent
 * that is not told which is which answers all of them in whatever language
 * the last thing it read was written in.
 *
 * - The panel: what this console is drawn in. The owner's.
 * - The agents' default: what every company's agents use unless the company
 *   says otherwise.
 * - The company's work language: what it produces -- documents, emails,
 *   content, code comments.
 * - The company's talk language: what its agents write to the owner and to
 *   each other -- approvals, questions, reports, handoffs.
 *
 * The last two are told to every run first thing, above the facts and the
 * procedures, with the rule that nothing the run reads can change them.
 */
export function LanguageSettings({ ctx }: { ctx: ConsoleContext }) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const answer: Languages = await api('GET', '/api/control/languages');
    return answer;
  }, []);
  const [agents, setAgents] = useState<string | null>(null);
  const [work, setWork] = useState<string | null>(ctx.company.workLanguage);
  const [talk, setTalk] = useState<string | null>(ctx.company.talkLanguage);
  const [busy, setBusy] = useState<string | null>(null);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={3} />;
  const supported = view.data.supported.map((one) => ({ value: one.code, label: one.native === one.name ? one.name : `${one.native} · ${one.name}` }));
  const nameOf = (code: string) => view.data?.supported.find((one) => one.code === code)?.native ?? code;
  const fallback = agents ?? view.data.agents;

  const save = async (what: string, run: () => Promise<unknown>) => {
    setBusy(what);
    try {
      await run();
      notifications.show({ color: 'teal', message: t('Saved. Agents follow it from their next run.') });
      view.reload();
      void ctx.refreshCompanies();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap="lg">
      <Section title={t('Panel language')} description={t('What this console is written in, on every device you sign in from.')}>
        <Group gap="sm">
          {LANGUAGES.map((one) => (
            <Button
              key={one.code}
              variant={one.code === language() ? 'filled' : 'default'}
              leftSection={<IconLanguage size={16} />}
              onClick={() => void chooseLanguage(one.code).catch((failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }))}
            >
              {one.name}
            </Button>
          ))}
        </Group>
      </Section>

      <Section title={t('Agents, by default')} description={t('The language every company’s agents use unless the company sets its own below.')}>
        <Group align="flex-end" gap="sm">
          <Select data={supported} value={fallback} onChange={setAgents} searchable w={320} allowDeselect={false} />
          <Button loading={busy === 'agents'} disabled={!agents || agents === view.data.agents}
            onClick={() => void save('agents', () => api('POST', '/api/control/languages', { agents }))}>
            {t('Save')}
          </Button>
        </Group>
      </Section>

      <Section
        title={t('{company}: its languages', { company: ctx.company.name })}
        description={t('Empty means the default above.')}
      >
        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
          <Select
            label={t('Work language')}
            description={t('What it produces: documents, emails, content for customers, code comments.')}
            data={supported}
            value={work}
            onChange={setWork}
            placeholder={t('Default: {language}', { language: nameOf(view.data.agents) })}
            searchable
            clearable
          />
          <Select
            label={t('Talk language')}
            description={t('What its agents write to you and to each other: approvals, questions, reports, handoffs.')}
            data={supported}
            value={talk}
            onChange={setTalk}
            placeholder={t('Default: {language}', { language: nameOf(view.data.agents) })}
            searchable
            clearable
          />
        </SimpleGrid>
        <Group mt="md">
          <Button loading={busy === 'company'} disabled={work === ctx.company.workLanguage && talk === ctx.company.talkLanguage}
            onClick={() => void save('company', () => api('POST', `/api/companies/${companyId}/languages`, { work, talk }))}>
            {t('Save')}
          </Button>
        </Group>
      </Section>

      <Alert variant="light" color="brand" title={t('Why agents do not drift')}>
        <Stack gap={6}>
          <Text size="sm">{t('Every run is told its languages first, right after its charter, and told that nothing it reads can change them: not an email, not a web page, not a message asking it to switch.')}</Text>
          <Text size="sm">{t('What an agent writes to you is checked. If it drifts into another language, the slip shows in the activity and the next run of that role is reminded of it.')}</Text>
          <Text size="sm">{t('A task can still ask for another language on purpose, such as a translation. That is the task’s instruction, not something the agent read.')}</Text>
        </Stack>
      </Alert>
      {isLanguage(view.data.console) ? null : (
        <Text size="xs" c="dimmed">{t('The panel follows your browser until you choose a language.')}</Text>
      )}
    </Stack>
  );
}
