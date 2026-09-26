/**
 * Where the company is in its life (0057): explore, validate, build, launch,
 * grow -- and winding down, off to the side because it is not a step forward.
 *
 * The owner's to move. A move forward loosens whatever the stage policies
 * hold back (paid reach opens at launch), so it asks for the device; going
 * back, or winding down, only closes things. A run that thinks the company
 * should move proposes it, and that proposal is an item in the inbox, not a
 * button here.
 */
import { useState } from 'react';
import { Alert, Button, Group, Menu, Stepper, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronDown } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { N, t } from '../i18n.ts';
import type { Stage } from '../types.ts';
import { Section } from './ui.tsx';

const PATH: Array<{ stage: Stage; label: string; purpose: string }> = [
  { stage: 'explore', label: N('Explore'), purpose: N('Find a problem worth solving.') },
  { stage: 'validate', label: N('Validate'), purpose: N('Find out whether people will pay.') },
  { stage: 'build', label: N('Build'), purpose: N('Build what the paying customers asked for.') },
  { stage: 'launch', label: N('Launch'), purpose: N('Put it in front of customers.') },
  { stage: 'grow', label: N('Grow'), purpose: N('Grow what is working; stop what is not.') },
];

const order = (stage: Stage | null) => (stage === null ? -1 : PATH.findIndex((step) => step.stage === stage));

export function StageCard({ companyId, stage, changed }: { companyId: string; stage: Stage | null; changed: () => void }) {
  const requireFactor = useFactor();
  // Five steps side by side do not fit a phone; down the page they do.
  const narrow = useMediaQuery('(max-width: 48em)') ?? false;
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = order(stage);
  const next = stage === 'wind_down' ? null : PATH[at + 1] ?? null;

  const move = async (to: Stage) => {
    setBusy(true);
    setError(null);
    try {
      // Forward is a loosening, and the API asks for the device; asked here
      // first so the owner is not told no after pressing.
      const forward = to !== 'wind_down' && (stage === null || stage === 'wind_down' || order(to) > at);
      if (forward) {
        const label = PATH.find((step) => step.stage === to)?.label ?? to;
        const ok = await requireFactor(t('Move the company to {stage}', { stage: t(label) }), (proof) =>
          api('POST', `/api/companies/${companyId}/stage`, { stage: to, note, proof }));
        if (!ok) return;
      } else {
        await api('POST', `/api/companies/${companyId}/stage`, { stage: to, note });
      }
      notifications.show({ color: 'teal', message: t('The stage is changed. Every run from now on is told it.') });
      setNote('');
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t('Stage')}
      description={t('Where the company is in its life. Runs are told it, and policies can hold things back until a stage: no paid reach before launch, for one.')}
      actions={(
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button size="compact-sm" variant="subtle" rightSection={<IconChevronDown size={14} />}>{t('Other stage')}</Button>
          </Menu.Target>
          <Menu.Dropdown>
            {PATH.filter((step) => step.stage !== stage).map((step) => (
              <Menu.Item key={step.stage} onClick={() => move(step.stage)}>{t(step.label)}</Menu.Item>
            ))}
            <Menu.Divider />
            <Menu.Item color="red" disabled={stage === 'wind_down'} onClick={() => move('wind_down')}>{t('Wind down')}</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      )}
    >
      {stage === 'wind_down' ? (
        <Alert color="red" variant="light" title={t('Winding down')}>
          {t('Finishing what is owed to customers, and starting nothing new.')}
        </Alert>
      ) : (
        <Stepper
          active={Math.max(at, 0)}
          size="sm"
          iconSize={28}
          allowNextStepsSelect={false}
          orientation={narrow ? 'vertical' : 'horizontal'}
        >
          {PATH.map((step, index) => (
            <Stepper.Step
              key={step.stage}
              label={t(step.label)}
              description={index === at ? t(step.purpose) : undefined}
              color={index <= at ? 'brand' : 'gray'}
            />
          ))}
        </Stepper>
      )}
      {stage === null && <Text size="sm" c="dimmed" mt="sm">{t('No stage set. Until one is, stage policies treat the company as having proved nothing yet.')}</Text>}
      {next && (
        <Group mt="md" align="flex-end" wrap={narrow ? 'wrap' : 'nowrap'}>
          <Textarea
            style={{ flex: 1, minWidth: 220 }}
            size="xs"
            autosize
            minRows={1}
            placeholder={t('Why now: the evidence, in a sentence (kept on the record)')}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
          <Button size="xs" variant="light" loading={busy} onClick={() => move(next.stage)}>
            {t('Move to {stage}', { stage: t(next.label) })}
          </Button>
        </Group>
      )}
      {error && <Alert color="red" variant="light" mt="sm">{error}</Alert>}
    </Section>
  );
}
