/**
 * Starting a company: the first thing an owner does, in one short screen.
 *
 * It used to be a form in a dialog: a name, a short name, two languages and a
 * switch, beneath a paragraph about seven divisions the company would start
 * with, behind a tour of eight steps laid over an empty page. The owner was
 * asked to understand the machinery before the company had a purpose.
 *
 * Now the company starts with its CEO and nothing else, so there is little to
 * ask: its name, and what it is for -- in the owner's own words, which the CEO
 * starts from and builds the team around. When the deployment has no model yet
 * the CEO could not answer, so that is the one other thing, set here and not
 * on a page the owner has to find. Then the company is started, and its CEO
 * speaks first.
 */
import { lazy, Suspense, useEffect, useState } from 'react';
import { Alert, Anchor, Button, Collapse, Group, Loader, Paper, Progress, Select, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowLeft, IconArrowRight, IconChevronDown, IconRocket } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { language, t } from '../i18n.ts';
import type { Languages, SetupReport } from '../types.ts';

// The model's own form, the one This deployment has: fetched only when the
// owner reaches the step that needs it.
const ModelSettings = lazy(() => import('./Deployment.tsx').then((module) => ({ default: module.ModelSettings })));

/** The time zone the owner's browser is in, or null where it does not say. */
function ownTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** A name as a link and an export spell it: lower case, letters and digits, hyphens between. */
function slugOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export function Onboarding({ languages, setup, started, cancel, restore, reloadSetup }: {
  languages: Languages | null;
  setup: SetupReport;
  /** The company is running: its id. */
  started: (companyId: string) => void;
  /** Present when this is one company more, not the first: the way back. */
  cancel?: () => void;
  /** Absent for a staff seat, which restores nothing. */
  restore?: () => void;
  /** Reads what the deployment reports again, so a model just set is seen. */
  reloadSetup: () => void;
}) {
  const requireFactor = useFactor();
  const [step, setStep] = useState<'company' | 'model'>('company');
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [mission, setMission] = useState('');
  const [more, setMore] = useState(false);
  // Null until chosen: the panel's language, which the owner may change while this is open.
  const [work, setWork] = useState<string | null>(null);
  const [talk, setTalk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const supported = (languages?.supported ?? []).map((one) => ({
    value: one.code, label: one.native === one.name ? one.name : `${one.native} · ${one.name}`,
  }));
  const panel = supported.some((one) => one.value === language()) ? language() : null;
  const workLanguage = work ?? panel;
  const talkLanguage = talk ?? panel;

  // The model step is there only while there is none to think with.
  const needsModel = setup.modelMissing === true;
  const steps = needsModel ? 2 : 1;
  const at = step === 'company' ? 1 : 2;
  const last = !needsModel || step === 'model';

  // A model saved restarts PALUGADA a few seconds later: read what it reports until it says one is set.
  useEffect(() => {
    if (step !== 'model' || !needsModel) return;
    const timer = setInterval(reloadSetup, 3_000);
    return () => clearInterval(timer);
  }, [step, needsModel, reloadSetup]);

  const start = async () => {
    setError(null);
    setBusy(true);
    let created: { companyId?: string } = {};
    try {
      const done = await requireFactor(t('Start {company}', { company: name.trim() }), async (proof) => {
        created = await api('POST', '/api/companies', {
          companySlug: slug, name: name.trim(), proof,
          ...(mission.trim() ? { mission: mission.trim() } : {}),
          // Its schedules run on the owner's clock, not UTC.
          ...(ownTimeZone() ? { timezone: ownTimeZone() } : {}),
          ...(workLanguage ? { workLanguage } : {}),
          ...(talkLanguage ? { talkLanguage } : {}),
        });
      });
      if (!done) return;
      notifications.show({ color: 'teal', message: t('{company} is running.', { company: name.trim() }) });
      if (created.companyId) started(created.companyId);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  const ready = name.trim() !== '' && slug !== '';

  return (
    <Stack gap="lg" maw={560} mx="auto" w="100%">
      <div>
        <Title order={2} fz={{ base: 24, sm: 28 }} fw={750}>{t('Let\'s start your company')}</Title>
        <Text c="dimmed" mt={6}>{t('Tell your CEO what it is for. It builds the team around that, and you stay in charge of what matters.')}</Text>
      </div>

      {steps > 1 && (
        <div>
          <Progress value={(at / steps) * 100} size="xs" radius="xl" />
          <Text size="xs" c="dimmed" mt={6}>{t('Step {step} of {steps}', { step: at, steps })}</Text>
        </div>
      )}

      {step === 'company' ? (
        <Paper withBorder radius="lg" p="lg">
          <Stack gap="md">
            <TextInput
              label={t('Name')}
              placeholder={t('e.g. Kopi Nusantara')}
              value={name}
              autoFocus
              data-autofocus
              onChange={(event) => {
                const value = event.currentTarget.value;
                setName(value);
                setSlug(slugOf(value));
              }}
              required
            />
            <Textarea
              label={t('What is it for?')}
              description={t('A sentence or two, in your own words. Your CEO starts from it.')}
              placeholder={t('e.g. We roast Gayo coffee and sell it to cafés and offices in Bandung, delivered the same day.')}
              value={mission}
              onChange={(event) => setMission(event.currentTarget.value)}
              autosize
              minRows={3}
              maxRows={8}
              maxLength={2_000}
            />
            <Anchor component="button" type="button" size="sm" onClick={() => setMore((open) => !open)}>
              <Group gap={4} wrap="nowrap">
                {t('More options')}
                <IconChevronDown size={14} style={{ transform: more ? 'rotate(180deg)' : undefined }} />
              </Group>
            </Anchor>
            <Collapse expanded={more}>
              <Stack gap="md">
                <TextInput label={t('Short name')} description={t('Used in links and exports')} value={slug} onChange={(event) => setSlug(event.currentTarget.value)} />
                {supported.length > 0 && (
                  <>
                    <Select
                      label={t('Work language')}
                      description={t('What it produces: documents, emails, content for customers, code comments.')}
                      data={supported}
                      value={workLanguage}
                      onChange={setWork}
                      searchable
                      allowDeselect={false}
                    />
                    <Select
                      label={t('Talk language')}
                      description={t('What its agents write to you and to each other: approvals, questions, reports, handoffs.')}
                      data={supported}
                      value={talkLanguage}
                      onChange={setTalk}
                      searchable
                      allowDeselect={false}
                    />
                  </>
                )}
              </Stack>
            </Collapse>
          </Stack>
        </Paper>
      ) : (
        <Paper withBorder radius="lg" p="lg">
          <Stack gap="md">
            <div>
              <Text fw={700}>{t('Give your CEO a model')}</Text>
              <Text size="sm" c="dimmed" mt={4}>
                {t('Your CEO thinks with a model, and none is set up yet. Choose a provider and paste its key. You can change it later under This deployment.')}
              </Text>
            </div>
            <Suspense fallback={<Loader size="sm" />}>
              <ModelSettings />
            </Suspense>
            {needsModel && (
              <Alert color="yellow" variant="light">
                {t('Until a model is set, your CEO can read what you write but cannot answer.')}
              </Alert>
            )}
          </Stack>
        </Paper>
      )}

      {error && <Text c="red" size="sm">{error}</Text>}

      <Group justify="space-between" wrap="wrap">
        <Group gap="md">
          {step === 'model' ? (
            <Button variant="default" leftSection={<IconArrowLeft size={16} />} onClick={() => setStep('company')} disabled={busy}>{t('Back')}</Button>
          ) : cancel ? (
            <Button variant="default" onClick={cancel} disabled={busy}>{t('Cancel')}</Button>
          ) : null}
          {step === 'company' && restore && (
            <Anchor component="button" type="button" size="sm" onClick={restore}>{t('Restore from an export')}</Anchor>
          )}
        </Group>
        {last ? (
          <Button size="md" leftSection={<IconRocket size={18} />} loading={busy} disabled={!ready} onClick={() => void start()}>
            {t('Start the company')}
          </Button>
        ) : (
          <Button size="md" rightSection={<IconArrowRight size={18} />} disabled={!ready} onClick={() => setStep('model')}>
            {t('Continue')}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
