/**
 * The owner's headline metric (0142, F18.13): the one number the company is
 * judged by, after Ellis's north star. The portfolio shows it on the
 * company's card and every run is told it. Until the owner chooses one, the
 * portfolio infers it -- the first measure on the highest goal -- and says
 * which it is.
 *
 * A headline that can be moved directly is easy to buy with something nobody
 * watches, so a measure with no pair is chosen with a warning rather than
 * refused: the pair is made from the measure's own form, under the owner's
 * factor, and the owner may be about to make it.
 */
import { useState } from 'react';
import { Alert, Button, Group, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconLink, IconStar } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';
import type { Company, Structure } from '../types.ts';
import { Section } from './ui.tsx';

export function HeadlineChooser({ companyId, company, structure, changed }: {
  companyId: string; company: Company; structure: Structure; changed: () => void;
}) {
  const measures = structure.goals.flatMap((goal) => goal.metrics.map((metric) => ({ metric, goal })));
  // What the server accepts: a measure aimed at a target, not a weekly line
  // or a retired one.
  const candidates = measures.filter(({ metric }) => !metric.retiredAt && metric.reviewEvery !== 'week');
  const [choice, setChoice] = useState<string | null>(structure.headlineMetricId);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = candidates.find(({ metric }) => metric.id === choice)?.metric;
  const partner = chosen?.pairedWith ? measures.find(({ metric }) => metric.id === chosen.pairedWith)?.metric : undefined;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/headline`, { metricId: choice });
      notifications.show({
        color: 'teal',
        message: choice ? t('Chosen. The portfolio shows it, and every run is told it.') : t('Cleared. The portfolio infers the headline from the goals again.'),
      });
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title={t('Headline metric')}
      description={t('The one number the company is judged by: the portfolio shows it on the company\'s card, and every run is told it.')}
    >
      {candidates.length === 0 ? (
        <Text size="sm" c="dimmed">{t('Measure a goal against a target first: the headline is chosen from those measures.')}</Text>
      ) : (
        <Stack gap="sm">
          <Group align="flex-end" gap="sm" wrap="wrap">
            <Select label={t('The number the company is judged by')} placeholder={t('Inferred from the goals')} clearable searchable
              value={choice} onChange={setChoice} style={{ flex: 1, minWidth: 220 }} leftSection={<IconStar size={14} />}
              data={candidates.map(({ metric, goal }) => ({ value: metric.id, label: `${metric.name} · ${goal.statement}` }))} />
            <Button loading={saving} disabled={choice === structure.headlineMetricId} onClick={() => void save()}>{t('Save')}</Button>
          </Group>
          {!choice && company.headline && !company.headline.chosen && (
            <Text size="xs" c="dimmed">{t('Until you choose one, the portfolio shows {name}, the first measure on the highest goal.', { name: company.headline.name })}</Text>
          )}
          {chosen && partner && (
            <Group gap={4} wrap="nowrap">
              <IconLink size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
              <Text size="xs" c="dimmed">{t('Watched with {name}', { name: partner.name })}</Text>
            </Group>
          )}
          {chosen && !partner && (
            <Alert color="orange" variant="light" icon={<IconLink size={16} />}>
              {t('Nothing is paired with this number. If you can move it directly, it is probably not the number the company is judged by: pair it, from its measure, with the one that would suffer if it were pushed.')}
            </Alert>
          )}
          {error && <Alert color="red" variant="light">{error}</Alert>}
        </Stack>
      )}
    </Section>
  );
}
