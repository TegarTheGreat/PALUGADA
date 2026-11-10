/**
 * The company's settings, and the owner's own (F1.5, F9.5, F9.6, F11.5,
 * F11.6, F12.5): hours, cheap hours, retention, alert thresholds, freezing
 * and exporting; languages; authenticators and sessions.
 *
 * Each is a section of the settings page (SettingsHub), not a page of its
 * own: an owner changes these rarely and should find them all in one place.
 */
import { Alert, Badge, Button, Code, CopyButton, Grid, Group, NumberInput, Select, SimpleGrid, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCheck, IconCopy, IconDownload, IconFingerprint, IconKey, IconLanguage, IconShieldCheck, IconSnowflake, IconSnowflakeOff } from '@tabler/icons-react';
import { useState } from 'react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { centsFrom, currencyName, day, type MoneyDisplay, numberSeparators, retentionSaid, setMoneyDisplay } from '../format.ts';
import { LANGUAGES, isLanguage, language, t } from '../i18n.ts';
import { chooseLanguage, type ConsoleContext } from '../App.tsx';
import type { Languages } from '../types.ts';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';
import { OfficeHoursForm, type Hours } from '../components/OfficeHours.tsx';
import { atPasskeyAddress, makePasskey, passkeysSupported, type PasskeyOptions, type RelyingParty } from '../passkey.ts';

const ZONES = ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const zoneOptions = ZONES.map((zone) => ({ value: zone, label: zone }));

export function CompanySettings({ ctx }: { ctx: ConsoleContext }) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [window_, retention, office]: [
      { timezone: string; startHour: number; endHour: number },
      { policy: { eventDays: number; traceDays: number; promptDays: number }; log: Array<{ action: string; rowsAffected: number; throughAt: string }> },
      { hours: Hours | null },
    ] = await Promise.all([
      api('GET', '/api/control/owner-window'),
      api('GET', `/api/companies/${companyId}/retention`),
      api('GET', `/api/companies/${companyId}/office-hours`),
    ]);
    return { window: window_, retention, office: office.hours };
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
                { name: 'startHour', label: t('Start hour'), type: 'number', required: true, initial: view.data.window.startHour },
                { name: 'endHour', label: t('End hour'), type: 'number', required: true, initial: view.data.window.endHour },
              ]}
              submit={(values) => api('POST', '/api/control/owner-window', values)}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={12}>
          <Section
            title={t('Office hours')}
            description={t('When emails, posts and replies may go out. Outside them they wait for the next opening; reading, writing and planning carry on at any hour.')}
          >
            <OfficeHoursForm
              companyId={companyId}
              hours={view.data.office}
              zones={ZONES}
              ownerZone={view.data.window.timezone}
              reload={view.reload}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Cheap hours')} description={t('Work marked non-urgent, that only reads, waits for this window.')}>
            <ActionForm
              columns={3}
              fields={[
                { name: 'timezone', label: t('Time zone'), type: 'select', required: true, initial: 'UTC', options: zoneOptions },
                { name: 'startHour', label: t('Start hour'), type: 'number', required: true, initial: 2 },
                { name: 'endHour', label: t('End hour'), type: 'number', required: true, initial: 5 },
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
                  <Table.Td>{retentionSaid(row.action)}</Table.Td>
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
            { name: 'dailyCost', label: t('Daily cost'), type: 'money' },
            { name: 'taskFailureRate', label: t('Failure rate, 0 to 1'), type: 'number' },
            { name: 'policyDenialsPerDay', label: t('Policy denials a day'), type: 'number' },
          ]}
          submit={({ dailyCost, ...values }) => api('POST', `/api/companies/${companyId}/alert-thresholds`, {
            ...values,
            // Typed in dollars; kept, like every amount, in cents.
            ...(dailyCost === undefined || dailyCost === '' ? {} : { dailyCostCents: centsFrom(dailyCost) }),
          })}
        />
      </Section>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Freeze this company')} description={t('Nothing of theirs starts while it is frozen; work in progress stops at its next step.')}>
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

      <Guardian ctx={ctx} />

      <CloseCompany ctx={ctx} />
    </Stack>
  );
}

/**
 * The guardian (0092): on, a model looks at each low-tier call the work
 * makes after reading something from outside, and may send it to the owner
 * first. It only ever asks more; turning it off takes the owner's device.
 */
function Guardian({ ctx }: { ctx: ConsoleContext }) {
  const { companyId, company } = ctx;
  return (
    <Section title={t('The guardian')} description={t('After the work reads something from outside the company, such as an email or a web page, a model looks at each small action it then takes and sends you the doubtful ones. It never lets through what would otherwise ask you. Each look is a model call the company pays for.')}>
      <Group>
        <Badge color={company.guardian ? 'teal' : 'gray'} variant="light">{company.guardian ? t('On') : t('Off')}</Badge>
        {company.guardian
          ? <ActionButton label={t('Turn it off')} factor={t('Turn the guardian off for {company}', { company: company.name })}
              run={(proof) => api('POST', `/api/companies/${companyId}/guardian`, { on: false, proof })}
              done={() => { notifications.show({ message: t('The guardian is off for {company}.', { company: company.name }) }); void ctx.refreshCompanies(); }} />
          : <ActionButton label={t('Turn it on')} leftSection={<IconShieldCheck size={16} />}
              run={() => api('POST', `/api/companies/${companyId}/guardian`, { on: true })}
              done={() => { notifications.show({ color: 'teal', message: t('The guardian is on for {company}.', { company: company.name }) }); void ctx.refreshCompanies(); }} />}
      </Group>
    </Section>
  );
}

/**
 * Closing the company (0088): frozen now, and every row of it erased on a
 * day 7 to 90 days away. Until then it can be kept; after, nothing of it
 * comes back, so the form asks for its name typed out and the owner's device.
 */
function CloseCompany({ ctx }: { ctx: ConsoleContext }) {
  const { companyId, company } = ctx;
  if (company.eraseAfter) {
    return (
      <Section title={t('This company is closing')} description={t('It is frozen, and everything of it is erased on {day}: its work, history, memory, documents and the keys its divisions hold. Until then you can keep it.', { day: day(company.eraseAfter) })}>
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={16} />}>
          {t('Export it first if you want a copy: nothing erased can be brought back.')}
        </Alert>
        <Group mt="md">
          <ActionButton label={t('Keep this company')} run={() => api('POST', `/api/companies/${companyId}/close/keep`, {})}
            done={() => { notifications.show({ color: 'teal', message: t('{company} is kept. It is still frozen; unfreeze it when you want it working.', { company: company.name }) }); void ctx.refreshCompanies(); }} />
        </Group>
      </Section>
    );
  }
  return (
    <Section title={t('Close this company')} description={t('It is frozen at once, and every row of it is erased when the days you choose are over: work, history, memory, documents and the keys its divisions hold. Until then you can keep it.')}>
      <ActionForm
        columns={2}
        fields={[
          { name: 'days', label: t('Erase after, days (7 to 90)'), type: 'number', required: true, initial: 30 },
          { name: 'name', label: t('Type its name to confirm'), required: true, placeholder: company.name },
        ]}
        action={t('Close the company')}
        color="red"
        factor={t('Close {company}', { company: company.name })}
        submit={(values, proof) => api('POST', `/api/companies/${companyId}/close`, { ...values, proof })}
        success={t('{company} is closing.', { company: company.name })}
        done={() => void ctx.refreshCompanies()}
      />
    </Section>
  );
}

export function SecuritySettings() {
  const view = useLoad(async () => {
    const answer: { authenticators: Array<{ id: string; label: string; kind: string; left?: number }>; passkeys: RelyingParty } = await api('GET', '/api/mfa/authenticators');
    return answer;
  }, []);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={2} />;
  const { passkeys } = view.data;
  // The codes are a way back in, not a device: listed apart, below.
  const authenticators = view.data.authenticators.filter((one) => one.kind !== 'recovery');
  const recovery = view.data.authenticators.find((one) => one.kind === 'recovery') ?? null;
  return (
    <Stack gap="lg">
      <Section title={t('Your authenticators')} description={t('What can sign you in, and so approve a tier 3 action in your name. Revoking takes a code from a device that is staying, and ends every session the revoked one signed in.')}>
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
      <RecoveryCodes recovery={recovery} changed={view.reload} />
      <Section title={t('Sessions')} description={t('Every browser signed in to this console, on every device. Signing out everywhere ends all of them, this one included.')}>
        <ActionButton label={t('Sign out everywhere')} color="red" variant="light" run={() => api('POST', '/api/auth/sign-out-everywhere', {})} done={() => window.location.reload()} />
      </Section>
    </Stack>
  );
}

/**
 * Codes for the day the phone is gone.
 *
 * Shown once, when made, with a way to copy them and to save them as a file
 * the owner keeps; nothing here keeps them, and the API cannot show them
 * again. A code signs in and puts a new device in the lost one's place, and
 * approves nothing.
 */
function RecoveryCodes({ recovery, changed }: { recovery: { id: string; left?: number } | null; changed: () => void }) {
  const [codes, setCodes] = useState<string[] | null>(null);
  const text = (codes ?? []).join('\n');
  const save = () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([`PALUGADA recovery codes\n\n${text}\n`], { type: 'text/plain' }));
    link.download = 'palugada-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <Section title={t('Recovery codes')} description={t('For the day your phone is gone: each code signs you in once, so you can add a new device and take the lost one off. A code approves nothing.')}>
      <Stack gap="sm">
        <Group justify="space-between">
          {recovery ? (
            <Text size="sm" c={(recovery.left ?? 0) <= 2 ? 'orange' : undefined}>{t('{left} of 10 codes left.', { left: String(recovery.left ?? 0) })}</Text>
          ) : (
            <Text size="sm" c="orange">{t('None made yet. Without them, a lost phone needs whoever runs the server.')}</Text>
          )}
          <ActionButton
            label={recovery ? t('Make new codes') : t('Make recovery codes')}
            variant="light"
            leftSection={<IconKey size={16} />}
            factor={t('Make new recovery codes; the old ones stop working')}
            run={async (proof) => {
              const answer: { codes: string[] } = await api('POST', '/api/mfa/recovery-codes', { proof });
              setCodes(answer.codes);
            }}
            done={changed}
          />
        </Group>
        {codes && (
          <Alert color="yellow" variant="light" title={t('Write these down now. They are not shown again.')}>
            <SimpleGrid cols={2} spacing={4} my="xs">
              {codes.map((code) => <Code key={code} fz="sm">{code}</Code>)}
            </SimpleGrid>
            <Group gap="xs">
              <CopyButton value={text}>
                {({ copied, copy }) => (
                  <Button size="xs" variant="default" onClick={copy} leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}>
                    {copied ? t('Copied') : t('Copy')}
                  </Button>
                )}
              </CopyButton>
              <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={save}>{t('Save as a file')}</Button>
              <Button size="xs" onClick={() => setCodes(null)}>{t('I have written them down')}</Button>
            </Group>
          </Alert>
        )}
      </Stack>
    </Section>
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
  // Undefined until the owner touches it; null is an answer: follow the panel.
  const [agents, setAgents] = useState<string | null | undefined>(undefined);
  const [work, setWork] = useState<string | null>(ctx.company.workLanguage);
  const [talk, setTalk] = useState<string | null>(ctx.company.talkLanguage);
  const [busy, setBusy] = useState<string | null>(null);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={3} />;
  const supported = view.data.supported.map((one) => ({ value: one.code, label: one.native === one.name ? one.name : `${one.native} · ${one.name}` }));
  const nameOf = (code: string) => view.data?.supported.find((one) => one.code === code)?.native ?? code;
  const chosenAgents = view.data.agentsChosen ? view.data.agents : null;
  const fallback = agents === undefined ? chosenAgents : agents;

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

      <Section title={t('How you read money')} description={t('PALUGADA counts in US dollars, as providers price in them. You may read every amount in your own currency, at a rate you set; nothing is charged in it.')}>
        <MoneyDisplayForm />
      </Section>

      <Section title={t('Agents, by default')} description={t('The language every company’s agents use unless the company sets its own below.')}>
        <Group align="flex-end" gap="sm">
          <Select data={supported} value={fallback} onChange={setAgents} searchable clearable w={320}
            placeholder={t('Follows the panel: {language}', { language: nameOf(view.data.console ?? 'en') })} />
          <Button loading={busy === 'agents'} disabled={agents === undefined || agents === chosenAgents}
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

/**
 * The currency the owner reads money in, and the rate (0106). US dollars
 * are what PALUGADA counts in; any other is only how amounts are shown and
 * typed, at the owner's own rate, which the platform never fetches.
 */
function MoneyDisplayForm() {
  const view = useLoad(async (): Promise<{ currency: string | null; rate: number | null }> =>
    api('GET', '/api/control/money-display'), []);
  const [currency, setCurrency] = useState<string | null>(null);
  const [rate, setRate] = useState<number | string | null>(null);
  const [busy, setBusy] = useState(false);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={1} />;
  const chosen = currency ?? view.data.currency ?? 'USD';
  const typed = rate ?? view.data.rate ?? '';
  const options = [
    { value: 'USD', label: t('US dollars, as PALUGADA counts') },
    ...Intl.supportedValuesOf('currency').filter((code) => code !== 'USD')
      .map((code) => ({ value: code, label: `${currencyName(code)} (${code})` })),
  ];
  const unchanged = chosen === (view.data.currency ?? 'USD') && (chosen === 'USD' || Number(typed) === view.data.rate);

  const save = async () => {
    setBusy(true);
    try {
      const saved: { currency: string | null; rate: number | null } = await api('POST', '/api/control/money-display',
        chosen === 'USD' ? { currency: null } : { currency: chosen, rate: Number(typed) });
      setMoneyDisplay(saved.currency && saved.rate ? { currency: saved.currency, rate: saved.rate } as MoneyDisplay : null);
      notifications.show({ color: 'teal', message: t('Saved. Every amount is shown this way now.') });
      view.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group align="flex-end" gap="sm" wrap="wrap">
      <Select label={t('Show amounts in')} data={options} value={chosen} onChange={(next) => { setCurrency(next ?? 'USD'); setRate(null); }}
        searchable allowDeselect={false} w={{ base: '100%', sm: 320 }} />
      {chosen !== 'USD' && (
        <NumberInput label={t('{currency} for one US dollar', { currency: chosen })} value={typed} onChange={setRate}
          min={0} decimalScale={6} {...numberSeparators()} w={{ base: '100%', sm: 220 }} />
      )}
      <Button loading={busy} disabled={unchanged || (chosen !== 'USD' && !(Number(typed) > 0))} onClick={() => void save()}>
        {t('Save')}
      </Button>
    </Group>
  );
}
