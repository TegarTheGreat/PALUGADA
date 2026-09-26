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
  Accordion, Alert, Anchor, Autocomplete, Badge, Button, Grid, Group, NavLink, Paper, PasswordInput, Select, Stack,
  Table, Text, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrain, IconCheck, IconExternalLink, IconKey, IconListSearch, IconPlugConnected } from '@tabler/icons-react';
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
  about: string;
  group: 'lab' | 'router' | 'cloud' | 'local' | 'custom';
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
];

const GROUPS: Array<{ id: ProviderEntry['group']; label: string }> = [
  { id: 'lab', label: N('Model makers') },
  { id: 'router', label: N('One key, many models') },
  { id: 'cloud', label: N('Clouds and inference hosts') },
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
    setUrl(next?.url ?? '');
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
  const ready = preset !== null && tiersNamed && !keyMissing && (preset.url !== undefined || url.trim() !== '');

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
              <Text size="sm" c="dimmed">
                {preset.about}
                {preset.keyUrl && (
                  <>
                    {' · '}
                    <Anchor href={preset.keyUrl} target="_blank" rel="noreferrer" size="sm">
                      {t('Get a key')} <IconExternalLink size={12} />
                    </Anchor>
                  </>
                )}
              </Text>
              <TextInput
                label={t('Address')}
                description={preset.dockerUrl
                  ? t('Under Docker Compose, the machine\'s own models are at {url}.', { url: preset.dockerUrl })
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
