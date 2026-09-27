/**
 * What a goal is measured by, and where it stands (0053).
 *
 * A number with its target and a bar between baseline and target; and, said
 * in words, whether the latest value is verified -- read from its source, or
 * entered by the owner -- or only an agent's claim. A dashboard that drew both
 * the same way would be asking the owner to trust a number nobody checked.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Group, Modal, NumberInput, Progress, Select, SimpleGrid, Stack, Text, TextInput, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCircleCheck, IconPlus } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { locale, t } from '../i18n.ts';
import { relative } from '../format.ts';
import type { Goal, Metric } from '../types.ts';

/** A metric's value as its unit reads. */
export function metricValue(metric: Pick<Metric, 'unit'>, value: number): string {
  if (metric.unit === 'percent') return `${value.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
  if (metric.unit === 'ratio') return value.toLocaleString(locale(), { maximumFractionDigits: 2 });
  return value.toLocaleString(locale(), Math.abs(value) >= 100_000 ? { notation: 'compact', maximumFractionDigits: 1 } : {});
}

export function MetricLine({ metric, companyId, changed }: { metric: Metric; companyId: string; changed?: () => void }) {
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState(false);
  const percent = metric.progress === null ? 0 : metric.progress * 100;
  return (
    <div style={metric.retiredAt ? { opacity: 0.6 } : undefined}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>{metric.name}</Text>
          {metric.retiredAt && <Badge size="xs" variant="light" color="gray">{t('retired')}</Badge>}
        </Group>
        <Group gap={6} wrap="nowrap">
          {metric.latest ? (
            metric.latest.verified ? (
              <Tooltip label={t('Read from its source, or entered by you')}>
                <IconCircleCheck size={14} color="var(--mantine-color-teal-6)" />
              </Tooltip>
            ) : (
              <Tooltip label={t('An agent reported this and did not read it from the source')}>
                <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" />
              </Tooltip>
            )
          ) : null}
          <Text size="sm" className="tabular" style={{ whiteSpace: 'nowrap' }}>
            {metric.latest ? metricValue(metric, metric.latest.value) : '—'}
            <Text span c="dimmed" size="xs"> / {metricValue(metric, metric.target)}</Text>
          </Text>
        </Group>
      </Group>
      <Progress value={percent} size="sm" mt={6} radius="xl" color={percent >= 100 ? 'teal' : metric.latest?.verified === false ? 'orange' : 'brand'} />
      <Group justify="space-between" mt={4} gap="xs">
        <Text size="xs" c="dimmed">
          {metric.latest ? t('Updated {when}', { when: relative(metric.latest.observedAt) }) : t('No value yet')}
          {metric.dueOn ? ` · ${t('due {day}', { day: metric.dueOn })}` : ''}
        </Text>
        {changed && !metric.retiredAt && (
          <Group gap={4}>
            <Button size="compact-xs" variant="subtle" onClick={() => setRecording(true)}>{t('Record a value')}</Button>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setEditing(true)}>{t('Change')}</Button>
          </Group>
        )}
      </Group>
      {changed && (
        <>
          <RecordValue companyId={companyId} metric={metric} opened={recording} close={() => setRecording(false)} done={changed} />
          <ChangeMetric companyId={companyId} metric={metric} opened={editing} close={() => setEditing(false)} done={changed} />
        </>
      )}
    </div>
  );
}

/**
 * Putting a measure right, or retiring it (0069). A target is what every run
 * on the goal aims at, so a change takes the owner's code.
 */
function ChangeMetric({ companyId, metric, opened, close, done }: {
  companyId: string; metric: Metric; opened: boolean; close: () => void; done: () => void;
}) {
  const requireFactor = useFactor();
  const [name, setName] = useState(metric.name);
  const [target, setTarget] = useState<number | string>(metric.target);
  const [baseline, setBaseline] = useState<number | string>(metric.baseline);
  const [dueOn, setDueOn] = useState(metric.dueOn ?? '');
  const [error, setError] = useState<string | null>(null);
  const send = async (body: Record<string, unknown>, message: string) => {
    setError(null);
    try {
      const sent = await requireFactor(t('Change a measure'), (proof) =>
        api('POST', `/api/companies/${companyId}/metrics/${metric.id}`, { ...body, proof }));
      if (!sent) return;
      notifications.show({ color: 'teal', message });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('Change a measure')} centered>
      <Stack>
        <TextInput label={t('What is measured')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
        <SimpleGrid cols={2}>
          <NumberInput label={t('Where it starts')} value={baseline} onChange={setBaseline} allowDecimal thousandSeparator />
          <NumberInput label={t('Target')} value={target} onChange={setTarget} allowDecimal thousandSeparator />
        </SimpleGrid>
        <TextInput label={t('By')} type="date" value={dueOn} onChange={(e) => setDueOn(e.currentTarget.value)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="space-between">
          <Button variant="subtle" color="red" onClick={() => void send({ retired: true }, t('Retired. Its history is kept; agents no longer aim at it.'))}>
            {t('Retire it')}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={close}>{t('Cancel')}</Button>
            <Button disabled={!name.trim() || target === ''} onClick={() => void send(
              { name, target: Number(target), baseline: Number(baseline), dueOn: dueOn || null },
              t('Changed. Agents working on this goal are told the new figure.'),
            )}>{t('Save')}</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

function RecordValue({ companyId, metric, opened, close, done }: {
  companyId: string; metric: Metric; opened: boolean; close: () => void; done: () => void;
}) {
  const [value, setValue] = useState<number | string>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/metrics/${metric.id}/observations`, { value: Number(value), note });
      notifications.show({ color: 'teal', message: t('Recorded.') });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={metric.name} centered>
      <Stack>
        <NumberInput label={t('Value now')} value={value} onChange={setValue} allowDecimal thousandSeparator />
        <TextInput label={t('Where it comes from')} placeholder={t('e.g. the bank statement for September')} value={note} onChange={(e) => setNote(e.currentTarget.value)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={value === ''} onClick={() => void submit()}>{t('Record it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The owner saying what a goal is measured by. */
export function AddMetric({ companyId, goal, opened, close, done }: {
  companyId: string; goal: Goal; opened: boolean; close: () => void; done: () => void;
}) {
  const [name, setName] = useState('');
  const [unit, setUnit] = useState<string | null>('currency');
  const [direction, setDirection] = useState<string | null>('up');
  const [baseline, setBaseline] = useState<number | string>(0);
  const [target, setTarget] = useState<number | string>('');
  const [dueOn, setDueOn] = useState('');
  const [source, setSource] = useState('');
  const [error, setError] = useState<string | null>(null);
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

  const submit = async () => {
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/goals/${goal.id}/metrics`, {
        slug, name, unit, direction, baseline: Number(baseline), target: Number(target),
        ...(dueOn ? { dueOn } : {}), ...(source ? { sourceCapability: source } : {}),
      });
      notifications.show({ color: 'teal', message: t('Metric added. Agents working on this goal will be told it.') });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Measure this goal')} size="lg" centered>
      <Stack>
        <Text size="sm" c="dimmed">{goal.statement}</Text>
        <TextInput label={t('What is measured')} placeholder={t('e.g. Monthly recurring revenue')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label={t('Unit')} value={unit} onChange={setUnit} allowDeselect={false} data={[
            { value: 'currency', label: t('Money') }, { value: 'count', label: t('A count') },
            { value: 'percent', label: t('A percentage') }, { value: 'ratio', label: t('A ratio') },
          ]} />
          <Select label={t('Better is')} value={direction} onChange={setDirection} allowDeselect={false} data={[
            { value: 'up', label: t('Higher') }, { value: 'down', label: t('Lower') },
          ]} />
          <NumberInput label={t('Where it starts')} value={baseline} onChange={setBaseline} allowDecimal thousandSeparator />
          <NumberInput label={t('Target')} value={target} onChange={setTarget} allowDecimal thousandSeparator required />
          <TextInput label={t('By')} type="date" value={dueOn} onChange={(e) => setDueOn(e.currentTarget.value)} />
          <TextInput label={t('Read from')} description={t('The capability whose answer is this number, if there is one')} placeholder="ledger.read" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
        </SimpleGrid>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={!slug || target === ''} onClick={() => void submit()}>{t('Add it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A goal's metrics as a block, with the owner's two actions. */
export function GoalMetrics({ companyId, goal, changed }: { companyId: string; goal: Goal; changed: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Stack gap="sm" mt="sm">
      {goal.metrics.map((metric) => <MetricLine key={metric.id} metric={metric} companyId={companyId} changed={changed} />)}
      <Group>
        <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setAdding(true)}>
          {goal.metrics.length === 0 ? t('Measure this goal') : t('Add another measure')}
        </Button>
        {goal.metrics.length === 0 && <Badge variant="light" color="gray">{t('Progress is counted in tasks until then')}</Badge>}
      </Group>
      <AddMetric companyId={companyId} goal={goal} opened={adding} close={() => setAdding(false)} done={changed} />
    </Stack>
  );
}
