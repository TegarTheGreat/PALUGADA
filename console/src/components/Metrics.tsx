/**
 * What a goal is measured by, and where it stands (0053).
 *
 * A number with its target and a bar between baseline and target; and, said
 * in words, whether the latest value is verified -- read from its source, or
 * entered by the owner -- or only an agent's claim. A dashboard that drew both
 * the same way would be asking the owner to trust a number nobody checked.
 *
 * A measure may be a line on the weekly scorecard (0137), owned by a seat and
 * paired with the measure that would suffer if it were pushed; the forms here
 * set all three, and say so when a key result's count has nothing watching it.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Group, Modal, NumberInput, Progress, Select, SimpleGrid, Stack, Text, TextInput, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconCalendarWeek, IconCircleCheck, IconLink, IconPlus } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { locale, t } from '../i18n.ts';
import { numberSeparators, relative, roleLabel } from '../format.ts';
import type { Goal, Metric, Role } from '../types.ts';
import { rhythmChanges, rhythmOf, type Rhythm } from '../rhythm.ts';

/**
 * What the forms choose a seat and a pair from: the company's roles, and every
 * measure it has. Without it the forms leave the scorecard fields out.
 */
export interface MetricTeam {
  roles: Role[];
  metrics: Metric[];
}

/**
 * A key result counted in units or money with nothing paired to it: the kind
 * of number that is easiest to buy with something nobody is watching (Grove's
 * paired indicators).
 */
function wantsPair(metric: Pick<Metric, 'unit' | 'pairedWith' | 'retiredAt'>, goalKind: string | undefined): boolean {
  return goalKind === 'key_result' && (metric.unit === 'count' || metric.unit === 'currency') && !metric.pairedWith && !metric.retiredAt;
}

/** A metric's value as its unit reads. */
export function metricValue(metric: Pick<Metric, 'unit'>, value: number): string {
  if (metric.unit === 'percent') return `${value.toLocaleString(locale(), { maximumFractionDigits: 1 })}%`;
  if (metric.unit === 'ratio') return value.toLocaleString(locale(), { maximumFractionDigits: 2 });
  return value.toLocaleString(locale(), Math.abs(value) >= 100_000 ? { notation: 'compact', maximumFractionDigits: 1 } : {});
}

export function MetricLine({ metric, companyId, changed, team, goalKind }: {
  metric: Metric; companyId: string; changed?: () => void; team?: MetricTeam; goalKind?: string;
}) {
  const [recording, setRecording] = useState(false);
  const [editing, setEditing] = useState(false);
  const percent = metric.progress === null ? 0 : metric.progress * 100;
  const partner = metric.pairedWith ? team?.metrics.find((one) => one.id === metric.pairedWith) : undefined;
  const seat = metric.ownerRoleId ? team?.roles.find((one) => one.id === metric.ownerRoleId) : undefined;
  return (
    <div style={metric.retiredAt ? { opacity: 0.6 } : undefined}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} truncate>{metric.name}</Text>
          {metric.retiredAt && <Badge size="xs" variant="light" color="gray">{t('retired')}</Badge>}
          {metric.reviewEvery === 'week' && !metric.retiredAt && (
            <Tooltip label={t('On the weekly scorecard: the target is the goal for each week.')}>
              <Badge size="xs" variant="light" color="blue" leftSection={<IconCalendarWeek size={10} />}>{t('Weekly')}</Badge>
            </Tooltip>
          )}
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
          {seat ? ` · ${t('owned by {seat}', { seat: roleLabel(seat) })}` : ''}
        </Text>
        {changed && !metric.retiredAt && (
          <Group gap={4}>
            <Button size="compact-xs" variant="subtle" onClick={() => setRecording(true)}>{t('Record a value')}</Button>
            <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setEditing(true)}>{t('Change')}</Button>
          </Group>
        )}
      </Group>
      {partner && (
        <Group gap={4} mt={4} wrap="nowrap">
          <IconLink size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
          <Text size="xs" c="dimmed" truncate>
            {t('Watched with {name}', { name: partner.name })}
            {partner.latest ? `: ${metricValue(partner, partner.latest.value)} / ${metricValue(partner, partner.target)}` : ''}
          </Text>
        </Group>
      )}
      {wantsPair(metric, goalKind) && (
        <Text size="xs" c="orange" mt={4}>{t('Not paired: nothing watches what this number could be bought with.')}</Text>
      )}
      {/* Mounted only while open, so each opening starts from the measure as
          it is now: pairing another measure may have changed this one's
          partner since the form was last open. */}
      {changed && recording && (
        <RecordValue companyId={companyId} metric={metric} opened close={() => setRecording(false)} done={changed} />
      )}
      {changed && editing && (
        <ChangeMetric companyId={companyId} metric={metric} opened close={() => setEditing(false)} done={changed}
          {...(team ? { team } : {})} {...(goalKind ? { goalKind } : {})} />
      )}
    </div>
  );
}

/**
 * The weekly scorecard's three fields (0137). A new measure (no `self`) is
 * offered only partners with no pair: taking one from an existing pair is a
 * change to that measure, made from its own form, under the owner's factor.
 */
function RhythmFields({ value, onChange, team, self, unit, goalKind }: {
  value: Rhythm; onChange: (next: Rhythm) => void; team: MetricTeam; self?: string; unit: string | null; goalKind?: string;
}) {
  const others = team.metrics.filter((one) => one.id !== self && !one.retiredAt && (self !== undefined || !one.pairedWith));
  return (
    <Stack gap="xs">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Select label={t('Reviewed')} value={value.reviewEvery ?? 'target'} allowDeselect={false}
          onChange={(next) => onChange({ ...value, reviewEvery: next === 'week' ? 'week' : null })}
          description={value.reviewEvery === 'week' ? t('The target is then the goal for each week.') : undefined}
          data={[
            { value: 'target', label: t('Against its target, by its date') },
            { value: 'week', label: t('Every week, on the weekly scorecard') },
          ]} />
        <Select label={t('The seat that answers for it')} placeholder={t('No seat yet')} clearable value={value.ownerRoleId}
          onChange={(next) => onChange({ ...value, ownerRoleId: next })}
          data={team.roles.map((role) => ({ value: role.id, label: roleLabel(role) }))} />
      </SimpleGrid>
      <Select label={t('Watched with')} placeholder={t('Not paired')} clearable searchable value={value.pairedWith}
        description={t('The measure that would suffer if this one were pushed: the two are always shown together.')}
        onChange={(next) => onChange({ ...value, pairedWith: next })}
        data={others.map((one) => ({ value: one.id, label: one.name }))} />
      {!value.pairedWith && wantsPair({ unit: (unit ?? 'count') as Metric['unit'], pairedWith: null, retiredAt: null }, goalKind) && (
        <Alert color="orange" variant="light" icon={<IconLink size={16} />}>
          {t('Nothing watches what this number could be bought with. Pair it with the measure that would suffer if it were pushed, such as quality, returns or churn.')}
        </Alert>
      )}
    </Stack>
  );
}

/**
 * Putting a measure right, or retiring it (0069). A target is what every run
 * on the goal aims at, so a change takes the owner's code.
 */
export function ChangeMetric({ companyId, metric, opened, close, done, team, goalKind }: {
  companyId: string; metric: Metric; opened: boolean; close: () => void; done: () => void; team?: MetricTeam; goalKind?: string;
}) {
  const requireFactor = useFactor();
  // What the form opened with, so Save sends only what the owner changed.
  const [started] = useState<Rhythm>(() => rhythmOf(metric));
  const [rhythm, setRhythm] = useState<Rhythm>(started);
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
          <NumberInput label={t('Where it starts')} value={baseline} onChange={setBaseline} allowDecimal {...numberSeparators()} />
          <NumberInput label={t('Target')} value={target} onChange={setTarget} allowDecimal {...numberSeparators()} />
        </SimpleGrid>
        <TextInput label={t('By')} type="date" value={dueOn} onChange={(e) => setDueOn(e.currentTarget.value)} />
        {team && <RhythmFields value={rhythm} onChange={setRhythm} team={team} self={metric.id} unit={metric.unit} {...(goalKind ? { goalKind } : {})} />}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="space-between">
          <Button variant="subtle" color="red" onClick={() => void send({ retired: true }, t('Retired. Its history is kept; agents no longer aim at it.'))}>
            {t('Retire it')}
          </Button>
          <Group gap="xs">
            <Button variant="default" onClick={close}>{t('Cancel')}</Button>
            <Button disabled={!name.trim() || target === ''} onClick={() => void send(
              { name, target: Number(target), baseline: Number(baseline), dueOn: dueOn || null, ...(team ? rhythmChanges(started, rhythm) : {}) },
              t('Changed. Agents working on this goal are told the new figure.'),
            )}>{t('Save')}</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}

export function RecordValue({ companyId, metric, opened, close, done }: {
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
        <NumberInput label={t('Value now')} value={value} onChange={setValue} allowDecimal {...numberSeparators()} />
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

/**
 * The owner saying what a goal is measured by. From the weekly scorecard it
 * is a weekly line by default, and the goal it hangs from is chosen in the
 * form (`goals`), since every measure hangs from one.
 */
export function AddMetric({ companyId, goal, goals, weekly, team, opened, close, done }: {
  companyId: string; goal: Goal | null; goals?: Goal[]; weekly?: boolean; team?: MetricTeam;
  opened: boolean; close: () => void; done: () => void;
}) {
  const [goalId, setGoalId] = useState<string | null>(goal?.id ?? goals?.[0]?.id ?? null);
  const under = goal ?? goals?.find((one) => one.id === goalId) ?? null;
  const [rhythm, setRhythm] = useState<Rhythm>({ reviewEvery: weekly ? 'week' : null, ownerRoleId: null, pairedWith: null });
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
    if (!under) return;
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/goals/${under.id}/metrics`, {
        slug, name, unit, direction, baseline: Number(baseline), target: Number(target),
        ...(dueOn ? { dueOn } : {}), ...(source ? { sourceCapability: source } : {}),
        ...(team ? rhythm : {}),
      });
      notifications.show({ color: 'teal', message: t('Metric added. Agents working on this goal will be told it.') });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={goal ? t('Measure this goal') : t('Add a line to the weekly scorecard')} size="lg" centered>
      <Stack>
        {goal ? <Text size="sm" c="dimmed">{goal.statement}</Text> : (
          <Select label={t('The goal it serves')} value={goalId} onChange={setGoalId} allowDeselect={false} searchable
            data={(goals ?? []).map((one) => ({ value: one.id, label: one.statement }))} />
        )}
        <TextInput label={t('What is measured')} placeholder={t('e.g. Monthly recurring revenue')} value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select label={t('Unit')} value={unit} onChange={setUnit} allowDeselect={false} data={[
            { value: 'currency', label: t('Money') }, { value: 'count', label: t('A count') },
            { value: 'percent', label: t('A percentage') }, { value: 'ratio', label: t('A ratio') },
          ]} />
          <Select label={t('Better is')} value={direction} onChange={setDirection} allowDeselect={false} data={[
            { value: 'up', label: t('Higher') }, { value: 'down', label: t('Lower') },
          ]} />
          <NumberInput label={t('Where it starts')} value={baseline} onChange={setBaseline} allowDecimal {...numberSeparators()} />
          <NumberInput label={t('Target')} value={target} onChange={setTarget} allowDecimal {...numberSeparators()} required />
          <TextInput label={t('By')} type="date" value={dueOn} onChange={(e) => setDueOn(e.currentTarget.value)} />
          <TextInput label={t('Read from')} description={t('The capability whose answer is this number, if there is one')} placeholder="ledger.read" value={source} onChange={(e) => setSource(e.currentTarget.value)} />
        </SimpleGrid>
        {team && <RhythmFields value={rhythm} onChange={setRhythm} team={team} unit={unit} {...(under ? { goalKind: under.kind } : {})} />}
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={!slug || target === '' || !under} onClick={() => void submit()}>{t('Add it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** A goal's metrics as a block, with the owner's two actions. */
export function GoalMetrics({ companyId, goal, changed, team }: { companyId: string; goal: Goal; changed: () => void; team?: MetricTeam }) {
  const [adding, setAdding] = useState(false);
  return (
    <Stack gap="sm" mt="sm">
      {goal.metrics.map((metric) => (
        <MetricLine key={metric.id} metric={metric} companyId={companyId} changed={changed} goalKind={goal.kind} {...(team ? { team } : {})} />
      ))}
      <Group>
        <Button size="compact-xs" variant="light" leftSection={<IconPlus size={12} />} onClick={() => setAdding(true)}>
          {goal.metrics.length === 0 ? t('Measure this goal') : t('Add another measure')}
        </Button>
        {goal.metrics.length === 0 && <Badge variant="light" color="gray">{t('Progress is counted in tasks until then')}</Badge>}
      </Group>
      {adding && (
        <AddMetric companyId={companyId} goal={goal} opened close={() => setAdding(false)} done={changed} {...(team ? { team } : {})} />
      )}
    </Stack>
  );
}
