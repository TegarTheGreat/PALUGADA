/**
 * What the whole deployment runs on, set from the console (0065): the model
 * first, and beside it, in time, the agent CLIs, the tools and the channels.
 *
 * These were environment variables, which only an operator with a shell
 * could change. They belong to no company -- every company thinks with the
 * same model -- so the page lives beside the portfolio rather than under a
 * company's settings, and is reachable before the first company exists,
 * which is exactly when an owner needs it.
 */
import {
  Accordion, Alert, Anchor, Autocomplete, Badge, Button, Code, Grid, Group, NavLink, Paper, PasswordInput,
  Select, SimpleGrid, Stack, Switch, Table, Text, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBrain, IconCheck, IconDownload, IconExternalLink, IconKey, IconListSearch, IconPlugConnected, IconTerminal2, IconWorldSearch,
} from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { N, t } from '../i18n.ts';
import { go, type DeploymentSection } from '../router.ts';
import { LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';

const TIERS = ['fast', 'standard', 'deep'] as const;
type Tier = (typeof TIERS)[number];

interface ProviderEntry {
  id: string;
  name: string;
  about?: string;
  group: 'lab' | 'router' | 'cloud' | 'plan' | 'local' | 'custom';
  protocol: 'anthropic' | 'openai';
  url?: string;
  urlExample?: string;
  dockerUrl?: string;
  key: 'required' | 'optional' | 'none';
  keyUrl?: string;
  example?: string;
}

interface SettingsView {
  model: {
    source: 'console' | 'environment' | null;
    provider: 'anthropic' | 'openai' | null;
    url: string | null;
    tiers: Record<Tier, string | null> | null;
    keySet: boolean;
    chosen: {
      preset: string | null;
      provider: 'anthropic' | 'openai';
      url: string | null;
      model: string | null;
      aliases: Partial<Record<Tier, string>>;
    } | null;
  };
  providers: ProviderEntry[];
  secrets: Array<{ name: string; updatedAt: string }>;
  masterKey: string | null;
  applies: 'now' | 'next_start';
  pending: boolean;
}

const SECTIONS: Array<{ id: DeploymentSection; label: string; hint: string; icon: typeof IconBrain }> = [
  { id: 'model', label: N('Model'), hint: N('What every role thinks with, unless a role is given its own.'), icon: IconBrain },
  { id: 'tools', label: N('Tools'), hint: N('Where roles search the web and read pages: the provider, and its key.'), icon: IconWorldSearch },
  { id: 'agents', label: N('Agent CLIs'), hint: N('Claude Code, Codex, Gemini CLI and others: install them here, sign them in, and let roles run on them.'), icon: IconTerminal2 },
];

const GROUPS: Array<{ id: ProviderEntry['group']; label: string }> = [
  { id: 'lab', label: N('Model makers') },
  { id: 'router', label: N('One key, many models') },
  { id: 'cloud', label: N('Clouds and inference hosts') },
  { id: 'plan', label: N('Plans sold for coding tools') },
  { id: 'local', label: N('On this machine') },
  { id: 'custom', label: N('Anything else') },
];

const TIER_LABEL: Record<Tier, string> = {
  fast: N('Fast: routing, sorting, short answers'),
  standard: N('Standard: most of the work'),
  deep: N('Deep: planning and hard problems'),
};

export function DeploymentSettings({ section }: { section: DeploymentSection }) {
  const current = SECTIONS.find((one) => one.id === section) ?? SECTIONS[0]!;
  return (
    <Stack gap="lg">
      <PageHeader crumbs={[t('This deployment')]} title={t(current.label)} description={t(current.hint)} />
      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Paper withBorder radius="lg" p="xs">
            {SECTIONS.map((one) => (
              <NavLink
                key={one.id}
                label={t(one.label)}
                leftSection={<one.icon size={18} stroke={1.7} />}
                active={one.id === current.id}
                onClick={() => go({ kind: 'deployment', section: one.id })}
                className="nav-link"
              />
            ))}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          {current.id === 'model' && <ModelSettings />}
          {current.id === 'agents' && <AgentSettings />}
          {current.id === 'tools' && <ToolSettings />}
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

function ModelSettings() {
  const view = useLoad(async (): Promise<SettingsView> => api('GET', '/api/control/settings'), []);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={5} />;
  return <ModelForm view={view.data} reload={view.reload} />;
}

function ModelForm({ view, reload }: { view: SettingsView; reload: () => void }) {
  const requireFactor = useFactor();
  const chosen = view.model.chosen;
  const initial = view.providers.find((entry) => entry.id === chosen?.preset)
    ?? view.providers.find((entry) => entry.url === view.model.url && entry.protocol === view.model.provider)
    ?? null;
  const [presetId, setPresetId] = useState<string | null>(initial?.id ?? null);
  const preset = view.providers.find((entry) => entry.id === presetId) ?? null;
  const [url, setUrl] = useState(chosen?.url ?? initial?.url ?? '');
  const [key, setKey] = useState('');
  const [model, setModel] = useState(chosen?.model ?? '');
  const [aliases, setAliases] = useState<Partial<Record<Tier, string>>>(chosen?.aliases ?? {});
  const [models, setModels] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const [listProblem, setListProblem] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ problem: string | null; warning: string | null } | null>(null);

  // A different provider is a different address, key and list of models.
  const pick = (id: string | null) => {
    setPresetId(id);
    const next = view.providers.find((entry) => entry.id === id);
    // A per-account address starts as its template, for the owner to fill in.
    setUrl(next?.url ?? (next?.urlExample?.includes('{') ? next.urlExample : ''));
    setKey('');
    setModels([]);
    setListProblem(null);
    setResult(null);
  };

  const sameProvider = chosen !== null && preset !== null && chosen.provider === preset.protocol;
  const keyKept = sameProvider && view.model.keySet && key === '';
  const body = () => ({
    preset: preset?.id,
    provider: preset?.protocol,
    url: url.trim() || undefined,
    model: model.trim() || undefined,
    aliases: Object.fromEntries(Object.entries(aliases).filter(([, name]) => name && name.trim() !== '')),
    key: key.trim() || undefined,
  });

  const listModels = async () => {
    setListing(true);
    setListProblem(null);
    try {
      const answer: { models: string[]; problem: string | null } = await api('POST', '/api/control/settings/model/models', body());
      setModels(answer.models);
      setListProblem(answer.problem);
    } catch (failure) {
      setListProblem(explain(failure));
    } finally {
      setListing(false);
    }
  };

  // Once the address and the key are there, the list comes by itself.
  useEffect(() => {
    if (!preset || (preset.key === 'required' && !key && !keyKept) || !url) return;
    const timer = setTimeout(() => void listModels(), 600);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presetId, url, key]);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api('POST', '/api/control/settings/model/test', body()));
    } catch (failure) {
      setResult({ problem: explain(failure), warning: null });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const done = await requireFactor(t('Change the model every role runs on'), async (proof) => {
      const answer: { applies: 'now' | 'next_start' } = await api('POST', '/api/control/settings/model', { ...body(), proof });
      notifications.show({
        color: 'teal',
        message: answer.applies === 'now'
          ? t('Saved. PALUGADA is starting again to use it; work in flight carries on where it was.')
          : t('Saved. It counts from the next start of PALUGADA.'),
      });
    });
    if (done) {
      setKey('');
      setTimeout(reload, 3_000);
    }
  };

  const clear = async () => {
    const done = await requireFactor(t('Go back to the model the environment names'), (proof) => api('POST', '/api/control/settings/model/clear', { proof }));
    if (done) setTimeout(reload, 3_000);
  };

  const providerOptions = useMemo(() => GROUPS
    .map((group) => ({
      group: t(group.label),
      items: view.providers.filter((entry) => entry.group === group.id).map((entry) => ({ value: entry.id, label: entry.name })),
    }))
    .filter((group) => group.items.length > 0), [view.providers]);

  const anthropic = preset?.protocol === 'anthropic';
  const tiersNamed = anthropic || model.trim() !== '' || TIERS.every((tier) => (aliases[tier] ?? '').trim() !== '');
  const keyMissing = preset?.key === 'required' && key.trim() === '' && !keyKept;
  const ready = preset !== null && tiersNamed && !keyMissing && (preset.url !== undefined || url.trim() !== '') && !url.includes('{');

  return (
    <Stack gap="lg">
      {view.pending && (
        <Alert color="yellow" variant="light" title={t('Saved, not yet in use')}>
          {view.applies === 'now'
            ? t('PALUGADA is starting again to use it. Refresh in a moment.')
            : t('It counts from the next start of PALUGADA.')}
        </Alert>
      )}

      <Section
        title={t('In use now')}
        actions={<Badge variant="light" color={view.model.source ? 'teal' : 'red'}>
          {view.model.source === 'console' ? t('set in the console') : view.model.source === 'environment' ? t('set by the environment') : t('not set')}
        </Badge>}
      >
        {view.model.provider === null ? (
          <Text size="sm" c="dimmed">{t('No model is set, so no role can work yet. Choose one below.')}</Text>
        ) : (
          <Stack gap="xs">
            <Text size="sm"><Text span fw={600}>{view.model.url}</Text>{view.model.keySet ? ` · ${t('key saved')}` : ''}</Text>
            {view.model.tiers && (
              <Table withRowBorders={false} verticalSpacing={4}>
                <Table.Tbody>
                  {TIERS.map((tier) => (
                    <Table.Tr key={tier}>
                      <Table.Td w={220}><Text size="sm" c="dimmed">{t(TIER_LABEL[tier])}</Text></Table.Td>
                      <Table.Td><Text size="sm" ff="monospace">{view.model.tiers![tier] ?? '—'}</Text></Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
            {view.model.source === 'console' && (
              <Group>
                <Button variant="subtle" color="gray" size="compact-sm" onClick={() => void clear()}>
                  {t('Go back to the environment\'s model')}
                </Button>
              </Group>
            )}
          </Stack>
        )}
      </Section>

      <Section title={t('Choose the model')} description={t('Pick who serves it, paste its key, and pick the model from its own list. Nothing is saved until you test it and confirm.')}>
        <Stack gap="md">
          <Select
            label={t('Provider')}
            placeholder={t('Search a provider')}
            data={providerOptions}
            value={presetId}
            onChange={pick}
            searchable
            nothingFoundMessage={t('Nothing matches: choose "Another OpenAI-compatible API" and type its address')}
            maxDropdownHeight={360}
          />
          {preset && (
            <>
              {(preset.about || preset.keyUrl) && (
                <Text size="sm" c="dimmed">
                  {preset.about}
                  {preset.about && preset.keyUrl ? ' · ' : null}
                  {preset.keyUrl && (
                    <Anchor href={preset.keyUrl} target="_blank" rel="noreferrer" size="sm">
                      {t('Get a key')} <IconExternalLink size={12} />
                    </Anchor>
                  )}
                </Text>
              )}
              {preset.group === 'plan' && (
                <Alert color="yellow" variant="light">
                  {t('This is a subscription sold for use in coding tools. It works here, but its terms may not cover a company run by agents: read them before you save it.')}
                </Alert>
              )}
              <TextInput
                label={t('Address')}
                description={preset.dockerUrl
                  ? t('Under Docker Compose, the machine\'s own models are at {url}.', { url: preset.dockerUrl })
                  : preset.urlExample?.includes('{')
                    ? t('Your own account\'s address: put your values in place of the parts in braces.')
                    : t('Up to /v1, as the provider documents it.')}
                placeholder={preset.url ?? preset.urlExample ?? ''}
                value={url}
                onChange={(event) => setUrl(event.currentTarget.value)}
                required={preset.url === undefined}
              />
              {preset.key !== 'none' && (
                <PasswordInput
                  label={t('API key')}
                  leftSection={<IconKey size={16} />}
                  description={keyKept
                    ? t('A key is saved. Leave this empty to keep it.')
                    : t('Sealed with this deployment\'s master key before it is stored. It is never shown again.')}
                  value={key}
                  onChange={(event) => setKey(event.currentTarget.value)}
                  required={preset.key === 'required' && !keyKept}
                  autoComplete="off"
                />
              )}
              <Group align="flex-end" gap="sm" wrap="nowrap">
                <Autocomplete
                  style={{ flex: 1 }}
                  label={anthropic ? t('One model for every tier (optional)') : t('The model every role runs on')}
                  description={anthropic ? t('Leave empty to use Claude\'s own by tier: Haiku, Sonnet and Opus.') : undefined}
                  placeholder={preset.example ?? (models[0] ?? '')}
                  data={models}
                  limit={50}
                  value={model}
                  onChange={setModel}
                />
                <Button variant="default" leftSection={<IconListSearch size={16} />} loading={listing} onClick={() => void listModels()}>
                  {t('List its models')}
                </Button>
              </Group>
              {models.length > 0 && !listProblem && (
                <Text size="xs" c="dimmed">{t('{count} models found. Type to narrow the list.', { count: models.length })}</Text>
              )}
              {listProblem && <Text size="xs" c="orange">{t('Could not list its models: {problem}. You can still type a name.', { problem: listProblem })}</Text>}

              <Accordion variant="contained" radius="md">
                <Accordion.Item value="tiers">
                  <Accordion.Control>{t('A different model for each tier')}</Accordion.Control>
                  <Accordion.Panel>
                    <Stack gap="sm">
                      <Text size="sm" c="dimmed">{t('A role asks for a tier, not a model. Name one here to put that tier on a cheaper or stronger model; an empty tier uses the model above.')}</Text>
                      {TIERS.map((tier) => (
                        <Autocomplete
                          key={tier}
                          label={t(TIER_LABEL[tier])}
                          data={models}
                          limit={50}
                          value={aliases[tier] ?? ''}
                          onChange={(value) => setAliases((current) => ({ ...current, [tier]: value }))}
                        />
                      ))}
                    </Stack>
                  </Accordion.Panel>
                </Accordion.Item>
              </Accordion>

              {result && (
                result.problem
                  ? <Alert color="red" variant="light" title={t('It did not answer')}>{result.problem}</Alert>
                  : result.warning
                    ? <Alert color="yellow" variant="light" title={t('It answered, but cannot act')}>{t('It did not call the tool it was offered, so a role on it can only answer in words. Choose a model that supports tool calling.')}</Alert>
                    : <Alert color="teal" variant="light" icon={<IconCheck size={18} />} title={t('It answered, and called the tool it was offered')}>{t('A role on this model can do its work.')}</Alert>
              )}

              <Group justify="flex-end">
                <Button variant="default" leftSection={<IconPlugConnected size={16} />} loading={testing} disabled={!ready} onClick={() => void test()}>
                  {t('Test it')}
                </Button>
                <Button disabled={!ready} onClick={() => void save()}>{t('Save')}</Button>
              </Group>
            </>
          )}
        </Stack>
      </Section>

      <Text size="xs" c="dimmed">
        {view.masterKey
          ? t('Keys are sealed with the master key at {where}. Back it up apart from the database: without it, the saved keys cannot be opened.', { where: view.masterKey })
          : t('The first key you save makes this deployment\'s master key, in its state directory. Back it up apart from the database.')}
      </Text>
    </Stack>
  );
}

interface AgentCredentialKind {
  id: string;
  label: string;
  variable: string;
  keyUrl?: string;
  howTo?: string;
  login?: string;
}

interface AgentJob {
  kind: 'install' | 'login';
  state: 'running' | 'succeeded' | 'failed';
  log: string;
  url: string | null;
  waitingForCode: boolean;
  error: string | null;
}

interface AgentRow {
  name: string;
  title: string;
  about: string;
  installed: { command: string; managed: boolean; version: string | null } | null;
  cannotInstall: string | null;
  tested: string | null;
  enabled: boolean;
  inUse: boolean;
  credential: { kind: string | null; variable: string } | null;
  credentialKinds: AgentCredentialKind[];
  models: Partial<Record<Tier, string>>;
  job: AgentJob | null;
}

/** The same words the server sends, here so that they are translated: keyed by CLI, and by CLI and credential. */
const AGENT_ABOUT: Record<string, string> = {
  'claude-code': N('Anthropic\'s agent, on an API key or a Claude subscription'),
  codex: N('OpenAI\'s agent'),
  'gemini-cli': N('Google\'s agent'),
  opencode: N('An open-source agent for any provider'),
  hermes: N('Nous Research\'s agent, for some thirty providers'),
  openclaw: N('An open-source agent gateway'),
};
const CREDENTIAL_LABEL: Record<string, string> = {
  anthropic: N('Anthropic API key'),
  openai: N('OpenAI API key'),
  openrouter: N('OpenRouter API key'),
  gemini: N('Gemini API key'),
  subscription: N('Claude subscription token'),
};
const CREDENTIAL_HOW_TO: Record<string, string> = {
  'claude-code:subscription': N('Run `claude setup-token` on a computer with a browser, sign in with your Claude plan, and paste the token it prints (it starts with sk-ant-oat).'),
};

function AgentSettings() {
  const view = useLoad(async (): Promise<{ agents: AgentRow[]; applies: 'now' | 'next_start' }> => api('GET', '/api/control/agents'), []);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={6} />;
  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        {t('A role can be done by an agent CLI instead of PALUGADA\'s own loop. Each run gets a directory of its own, none of the CLI\'s own shell, file or web tools, and the role\'s capabilities as its only tools.')}
      </Text>
      {view.data.agents.map((agent) => <AgentCard key={agent.name} agent={agent} reload={view.reload} />)}
    </Stack>
  );
}

function AgentCard({ agent, reload }: { agent: AgentRow; reload: () => void }) {
  const requireFactor = useFactor();
  const [job, setJob] = useState<AgentJob | null>(agent.job);
  const [kindId, setKindId] = useState(agent.credential?.kind ?? agent.credentialKinds[0]?.id ?? '');
  const [value, setValue] = useState('');
  const [enabled, setEnabled] = useState(agent.enabled);
  const [models, setModels] = useState<Partial<Record<Tier, string>>>(agent.models);
  const kind = agent.credentialKinds.find((one) => one.id === kindId) ?? null;

  // An install runs on after it is started; follow it until it ends.
  useEffect(() => {
    if (job?.state !== 'running') return;
    const timer = setInterval(() => {
      void api('GET', `/api/control/agents/${agent.name}/job`).then((answer: { job: AgentJob | null }) => {
        setJob(answer.job);
        if (answer.job?.state !== 'running') reload();
      }).catch(() => undefined);
    }, 1_000);
    return () => clearInterval(timer);
  }, [job?.state, agent.name, reload]);

  const install = async (version: 'tested' | 'latest') => {
    await requireFactor(t('Install {agent} on this server', { agent: agent.title }), async (proof) => {
      const answer: { job: AgentJob } = await api('POST', `/api/control/agents/${agent.name}/install`, { version, proof });
      setJob(answer.job);
    });
  };

  const signIn = async () => {
    const done = await requireFactor(t('Sign {agent} in', { agent: agent.title }), (proof) =>
      api('POST', `/api/control/agents/${agent.name}/credential`, { kind: kindId, value, proof }));
    if (done) {
      setValue('');
      notifications.show({ color: 'teal', message: t('{agent} is signed in.', { agent: agent.title }) });
      reload();
    }
  };

  const [code, setCode] = useState('');
  const startLogin = async () => {
    await requireFactor(t('Sign {agent} in with your subscription', { agent: agent.title }), async (proof) => {
      const answer: { job: AgentJob } = await api('POST', `/api/control/agents/${agent.name}/login`, { proof });
      setJob(answer.job);
    });
  };
  const sendCode = async () => {
    try {
      const answer: { job: AgentJob } = await api('POST', `/api/control/agents/${agent.name}/login/code`, { code });
      setCode('');
      setJob(answer.job);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };
  const cancelLogin = async () => {
    const answer: { job: AgentJob | null } = await api('POST', `/api/control/agents/${agent.name}/login/cancel`, {});
    setJob(answer.job);
  };
  const signingIn = job?.kind === 'login' && job.state === 'running';

  const signOut = async () => {
    const done = await requireFactor(t('Sign {agent} out', { agent: agent.title }), (proof) =>
      api('POST', `/api/control/agents/${agent.name}/credential/clear`, { proof }));
    if (done) reload();
  };

  const save = async () => {
    const done = await requireFactor(t('Change whether roles run on {agent}', { agent: agent.title }), (proof) =>
      api('POST', `/api/control/agents/${agent.name}/settings`, { enabled, models, proof }));
    if (done) {
      notifications.show({ color: 'teal', message: t('Saved. PALUGADA is starting again to use it; work in flight carries on where it was.') });
      setTimeout(reload, 3_000);
    }
  };

  const changed = enabled !== agent.enabled || JSON.stringify(models) !== JSON.stringify(agent.models);

  return (
    <Section
      title={agent.title}
      description={AGENT_ABOUT[agent.name] ? t(AGENT_ABOUT[agent.name]!) : agent.about}
      actions={
        <Group gap={6}>
          <Badge variant="light" color={agent.installed ? 'teal' : 'gray'}>
            {agent.installed ? (agent.installed.version ?? t('installed')) : t('not installed')}
          </Badge>
          <Badge variant="light" color={agent.credential ? 'teal' : 'gray'}>{agent.credential ? t('signed in') : t('not signed in')}</Badge>
          <Badge variant="light" color={agent.inUse ? 'teal' : agent.enabled ? 'yellow' : 'gray'}>
            {agent.inUse ? t('roles can use it') : agent.enabled ? t('starting') : t('off')}
          </Badge>
        </Group>
      }
    >
      <Stack gap="md">
        {agent.installed ? (
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Text size="xs" c="dimmed" ff="monospace" truncate style={{ minWidth: 0, flex: 1 }} title={agent.installed.command}>{agent.installed.command}</Text>
            {agent.installed.managed && (
              <Button size="compact-sm" variant="subtle" style={{ flexShrink: 0 }} leftSection={<IconDownload size={14} />} loading={job?.state === 'running'} onClick={() => void install('latest')}>
                {t('Update to the newest')}
              </Button>
            )}
          </Group>
        ) : agent.cannotInstall ? (
          <Alert color="gray" variant="light">{agent.cannotInstall}</Alert>
        ) : (
          <Group gap="sm">
            <Button leftSection={<IconDownload size={16} />} loading={job?.state === 'running'} onClick={() => void install('tested')}>
              {t('Install {agent}', { agent: agent.title })}
            </Button>
            <Text size="xs" c="dimmed">{t('Version {version}, the one PALUGADA was checked against. It goes in this deployment\'s own directory.', { version: agent.tested ?? '' })}</Text>
          </Group>
        )}
        {job?.kind === 'install' && job.state !== 'succeeded' && (
          <div>
            <Text size="xs" fw={600} c={job.state === 'failed' ? 'red' : 'dimmed'} mb={4}>
              {job.state === 'running' ? t('Installing…') : t('The install failed: {error}', { error: job.error ?? '' })}
            </Text>
            <Code block style={{ maxHeight: 180, overflow: 'auto', fontSize: 11 }}>{job.log || '…'}</Code>
          </div>
        )}

        <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="md">
          <Stack gap="xs">
            <Text size="sm" fw={600}>{t('Sign in')}</Text>
            {agent.credentialKinds.length > 1 && (
              <Select size="xs" value={kindId} onChange={(next) => next && setKindId(next)} allowDeselect={false}
                data={agent.credentialKinds.map((one) => ({ value: one.id, label: CREDENTIAL_LABEL[one.id] ? t(CREDENTIAL_LABEL[one.id]!) : one.label }))} />
            )}
            {kind?.login && agent.installed && (
              signingIn ? (
                <Paper withBorder radius="md" p="sm">
                  {job?.url ? (
                    <Stack gap={6}>
                      <Text size="xs">{t('1. Open the sign-in page, and sign in with your plan.')}</Text>
                      <Anchor href={job.url} target="_blank" rel="noreferrer" size="sm" fw={600}>{t('Open the sign-in page')} <IconExternalLink size={12} /></Anchor>
                      <Text size="xs">{t('2. Paste the code the page shows you.')}</Text>
                      <Group gap="xs" wrap="nowrap">
                        <TextInput size="xs" style={{ flex: 1 }} value={code} onChange={(event) => setCode(event.currentTarget.value)} autoComplete="off" />
                        <Button size="xs" disabled={code.trim() === '' || !job.waitingForCode} onClick={() => void sendCode()}>{t('Finish signing in')}</Button>
                      </Group>
                      {!job.waitingForCode && <Text size="xs" c="dimmed">{t('Checking the code…')}</Text>}
                    </Stack>
                  ) : <Text size="xs" c="dimmed">{t('Starting the sign-in…')}</Text>}
                  <Button size="compact-xs" variant="subtle" color="gray" mt={6} onClick={() => void cancelLogin()}>{t('Cancel')}</Button>
                </Paper>
              ) : (
                <Button size="xs" variant="light" onClick={() => void startLogin()}>{t('Sign in with your Claude plan')}</Button>
              )
            )}
            {job?.kind === 'login' && job.state === 'failed' && <Text size="xs" c="red">{job.error}</Text>}
            {kind?.howTo && (
              <Text size="xs" c="dimmed">
                {kind.login ? t('Or paste a token you made elsewhere:') : null}{' '}
                {CREDENTIAL_HOW_TO[`${agent.name}:${kind.id}`] ? t(CREDENTIAL_HOW_TO[`${agent.name}:${kind.id}`]!) : kind.howTo}
              </Text>
            )}
            <PasswordInput
              size="sm"
              leftSection={<IconKey size={16} />}
              placeholder={agent.credential ? t('Signed in. Paste a new one to replace it.') : kind && CREDENTIAL_LABEL[kind.id] ? t(CREDENTIAL_LABEL[kind.id]!) : (kind?.label ?? '')}
              value={value}
              onChange={(event) => setValue(event.currentTarget.value)}
              autoComplete="off"
            />
            <Group gap="xs">
              <Button size="xs" disabled={value.trim().length < 8} onClick={() => void signIn()}>{t('Save and sign in')}</Button>
              {kind?.keyUrl && (
                <Anchor href={kind.keyUrl} target="_blank" rel="noreferrer" size="xs">{t('Get a key')} <IconExternalLink size={11} /></Anchor>
              )}
              {agent.credential && <Button size="xs" variant="subtle" color="gray" onClick={() => void signOut()}>{t('Sign out')}</Button>}
            </Group>
            <Text size="xs" c="dimmed">{t('Given to each run as {variable}, and to nothing else.', { variable: kind?.variable ?? '' })}</Text>
          </Stack>

          <Stack gap="xs">
            <Text size="sm" fw={600}>{t('What each tier runs on')}</Text>
            {TIERS.map((tier) => (
              <TextInput key={tier} size="xs" label={t(TIER_LABEL[tier])} placeholder={t('its own default')}
                value={models[tier] ?? ''} onChange={(event) => { const next = event.currentTarget.value; setModels((current) => ({ ...current, [tier]: next })); }} />
            ))}
          </Stack>
        </SimpleGrid>

        <Group justify="space-between">
          <Switch label={t('Roles may run on it')} checked={enabled} disabled={!agent.installed && !agent.enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)} />
          <Button disabled={!changed} onClick={() => void save()}>{t('Save')}</Button>
        </Group>
        {enabled && !agent.credential && (
          <Text size="xs" c="orange">{t('It is not signed in here: a run uses whatever login the CLI already has on this machine, or fails.')}</Text>
        )}
      </Stack>
    </Section>
  );
}

type ToolKind = 'search' | 'extract';

interface ToolProvider {
  id: string;
  name: string;
  about?: string;
  key: 'required' | 'optional' | 'none';
  keyUrl?: string;
  urlExample?: string;
  reserveCents: number;
  checked?: 'unverified';
}

interface ToolState {
  capability: string;
  source: 'console' | 'environment' | null;
  provider: string | null;
  url: string | null;
  keySet: boolean;
  inUse: boolean;
}

interface ToolsView {
  kinds: Record<ToolKind, ToolState>;
  providers: Record<ToolKind, ToolProvider[]>;
  applies: 'now' | 'next_start';
}

const TOOL_TEXT: Record<ToolKind, { title: string; hint: string }> = {
  search: { title: N('Web search'), hint: N('Lets a role find pages: a title, an address and a snippet of each. Its queries go to the provider you choose.') },
  extract: { title: N('Reading pages'), hint: N('Lets a role read one page as clean text, fetched by the provider rather than by this server.') },
};

/** The same words the server sends about each provider, here so that they are translated. */
const TOOL_ABOUT: Record<string, string> = {
  'search:brave': N('An independent index'),
  'search:tavily': N('Built for agents; a free tier without a key'),
  'search:exa': N('Semantic search, with highlights from each page'),
  'search:firecrawl': N('A free tier without a key'),
  'search:perplexity': N('Ranked results with dated snippets'),
  'search:parallel': N('Search with excerpts chosen for the question'),
  'search:keenable': N('An independent index; a free tier without a key, shared by IP'),
  'search:serpapi': N('Google\'s results'),
  'search:serper': N('Google\'s results, cheaply'),
  'search:searxng': N('Your own metasearch server'),
  'search:firecrawl-self-hosted': N('A Firecrawl you run'),
  'extract:jina': N('Any page as clean text; 20 a minute without a key'),
  'extract:firecrawl': N('A free tier without a key'),
  'extract:tavily': N('A free tier without a key'),
  'extract:keenable': N('A free tier without a key, shared by IP'),
};

function ToolSettings() {
  const view = useLoad(async (): Promise<ToolsView> => api('GET', '/api/control/tools'), []);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={5} />;
  return (
    <Stack gap="lg">
      {(['search', 'extract'] as const).map((kind) => (
        <ToolCard key={kind} kind={kind} state={view.data!.kinds[kind]} providers={view.data!.providers[kind]} reload={view.reload} />
      ))}
    </Stack>
  );
}

function ToolCard({ kind, state, providers, reload }: { kind: ToolKind; state: ToolState; providers: ToolProvider[]; reload: () => void }) {
  const requireFactor = useFactor();
  const [providerId, setProviderId] = useState<string | null>(state.provider);
  const provider = providers.find((one) => one.id === providerId) ?? null;
  const [url, setUrl] = useState(state.url ?? '');
  const [key, setKey] = useState('');
  const [probe, setProbe] = useState(kind === 'search' ? 'PALUGADA' : 'https://example.com/');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{
    problem: string | null;
    results?: Array<{ title: string; url: string; snippet: string }>;
    page?: { url: string; title: string | null; excerpt: string };
  } | null>(null);
  const keyKept = state.keySet && state.provider === providerId && key === '';

  const options = [
    { group: t('Free to start, no key needed'), items: providers.filter((one) => one.key !== 'required' && !one.urlExample) },
    { group: t('Needs a key'), items: providers.filter((one) => one.key === 'required') },
    { group: t('Your own server'), items: providers.filter((one) => one.urlExample) },
  ].filter((group) => group.items.length > 0).map((group) => ({ group: group.group, items: group.items.map((one) => ({ value: one.id, label: one.name })) }));

  const body = () => ({ provider: providerId, url: url.trim() || undefined, key: key.trim() || undefined });

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api('POST', `/api/control/tools/${kind}/test`, { ...body(), ...(kind === 'search' ? { query: probe } : { url: probe }), ...(provider?.urlExample ? { url: url.trim() } : {}) }));
    } catch (failure) {
      setResult({ problem: explain(failure) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const done = await requireFactor(t('Choose where {capability} goes', { capability: state.capability }), (proof) =>
      api('POST', `/api/control/tools/${kind}`, { ...body(), proof }));
    if (done) {
      setKey('');
      notifications.show({ color: 'teal', message: t('Saved. PALUGADA is starting again to use it; work in flight carries on where it was.') });
      setTimeout(reload, 3_000);
    }
  };

  const clear = async () => {
    const done = await requireFactor(t('Choose where {capability} goes', { capability: state.capability }), (proof) =>
      api('POST', `/api/control/tools/${kind}/clear`, { proof }));
    if (done) setTimeout(reload, 3_000);
  };

  const ready = provider !== null && (!provider.urlExample || url.trim() !== '') && (provider.key !== 'required' || key.trim() !== '' || keyKept);
  const about = provider ? (TOOL_ABOUT[`${kind}:${provider.id}`] ? t(TOOL_ABOUT[`${kind}:${provider.id}`]!) : provider.about) : null;

  return (
    <Section
      title={t(TOOL_TEXT[kind].title)}
      description={t(TOOL_TEXT[kind].hint)}
      actions={<Badge variant="light" color={state.inUse ? 'teal' : state.provider ? 'yellow' : 'gray'}>
        {state.inUse ? t('roles can use it') : state.provider ? t('saved, starting') : t('not set')}
      </Badge>}
    >
      <Stack gap="sm">
        <Select label={t('Provider')} placeholder={t('Choose a provider')} data={options} value={providerId} searchable
          onChange={(next) => { setProviderId(next); setResult(null); setKey(''); }} />
        {provider && (
          <>
            {(about || provider.keyUrl) && (
              <Text size="sm" c="dimmed">
                {about}
                {about && provider.keyUrl ? ' · ' : null}
                {provider.keyUrl && <Anchor href={provider.keyUrl} target="_blank" rel="noreferrer" size="sm">{t('Get a key')} <IconExternalLink size={12} /></Anchor>}
              </Text>
            )}
            {provider.checked === 'unverified' && (
              <Text size="xs" c="orange">{t('Its request was taken from other people\'s write-ups, not from its own reference: try it before you rely on it.')}</Text>
            )}
            {provider.urlExample && (
              <TextInput label={t('Address')} placeholder={provider.urlExample} value={url} onChange={(event) => setUrl(event.currentTarget.value)} required />
            )}
            {provider.key !== 'none' && (
              <PasswordInput
                label={t('API key')}
                leftSection={<IconKey size={16} />}
                description={keyKept ? t('A key is saved. Leave this empty to keep it.')
                  : provider.key === 'optional' ? t('Optional: without one, its free tier is used, at its limits.') : undefined}
                value={key}
                onChange={(event) => setKey(event.currentTarget.value)}
                required={provider.key === 'required' && !keyKept}
                autoComplete="off"
              />
            )}
            <Group align="flex-end" gap="sm" wrap="nowrap">
              <TextInput style={{ flex: 1 }} label={kind === 'search' ? t('Try a search') : t('Try a page')} value={probe} onChange={(event) => setProbe(event.currentTarget.value)} />
              <Button variant="default" leftSection={<IconPlugConnected size={16} />} loading={testing} disabled={!ready} onClick={() => void test()}>{t('Test it')}</Button>
            </Group>
            {result && (result.problem
              ? <Alert color="red" variant="light" title={t('It did not answer')}>{result.problem}</Alert>
              : (
                <Paper withBorder radius="md" p="sm">
                  {result.results?.map((row) => (
                    <div key={row.url} style={{ marginBottom: 8 }}>
                      <Anchor href={row.url} target="_blank" rel="noreferrer" size="sm" fw={600}>{row.title || row.url}</Anchor>
                      <Text size="xs" c="dimmed" lineClamp={2}>{row.snippet}</Text>
                    </div>
                  ))}
                  {result.results?.length === 0 && <Text size="sm" c="dimmed">{t('It answered, with no results for that search.')}</Text>}
                  {result.page && (
                    <>
                      <Text size="sm" fw={600}>{result.page.title ?? result.page.url}</Text>
                      <Text size="xs" c="dimmed" lineClamp={4}>{result.page.excerpt}</Text>
                    </>
                  )}
                </Paper>
              ))}
            <Group justify="space-between">
              {state.source === 'console'
                ? <Button variant="subtle" color="gray" size="compact-sm" onClick={() => void clear()}>{t('Go back to the environment\'s choice')}</Button>
                : <span />}
              <Button disabled={!ready} onClick={() => void save()}>{t('Save')}</Button>
            </Group>
          </>
        )}
      </Stack>
    </Section>
  );
}
