/**
 * The weekly scorecard (F18.2, 0137): the numbers read every week, one row
 * each, with thirteen weeks drawn as cells -- green on track, red off track,
 * an outlined cell for a number an agent claimed and nobody read from its
 * source, and an empty one for a week nothing was reported.
 *
 * It is the first place a measure's history is drawn rather than only its
 * latest value. A pair is drawn as two rows side by side, or, when the pair is
 * not itself a weekly line, named on the row: the point of a pair is that
 * neither is read alone.
 */
import { useState } from 'react';
import {
  Alert, Anchor, Box, Button, Group, ScrollArea, Table, Text, Tooltip,
} from '@mantine/core';
import { IconLink, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { locale, N, t } from '../i18n.ts';
import { roleLabel } from '../format.ts';
import type { Metric, Scorecard as ScorecardView, Structure, WeekState } from '../types.ts';
import { LoadFailed, Loading, Section } from './ui.tsx';
import { AddMetric, ChangeMetric, RecordValue, metricValue } from './Metrics.tsx';

const STATES: Record<WeekState, { label: string; background: string; border: string }> = {
  on_track: { label: N('On track'), background: 'var(--mantine-color-teal-6)', border: 'var(--mantine-color-teal-6)' },
  off_track: { label: N('Off track'), background: 'var(--mantine-color-red-6)', border: 'var(--mantine-color-red-6)' },
  claimed: { label: N('Claimed, not read from its source'), background: 'var(--mantine-color-orange-light)', border: 'var(--mantine-color-orange-6)' },
  not_reported: { label: N('Not reported'), background: 'transparent', border: 'var(--mantine-color-default-border)' },
};

/** A Monday (`YYYY-MM-DD`) as a short day of the calendar, read at noon so no zone moves it a day. */
function weekOf(week: string, style: 'short' | 'long'): string {
  return new Date(`${week}T12:00:00`).toLocaleDateString(locale(), style === 'short'
    ? { day: 'numeric', month: 'numeric' } : { day: 'numeric', month: 'long', year: 'numeric' });
}

function Cell({ state, value, week, unit }: { state: WeekState; value: number | null; week: string; unit: Metric['unit'] }) {
  const look = STATES[state];
  const said = value === null ? t(look.label) : `${metricValue({ unit }, value)} · ${t(look.label)}`;
  return (
    <Tooltip label={t('Week of {day}: {what}', { day: weekOf(week, 'long'), what: said })}>
      <Box
        aria-label={t('Week of {day}: {what}', { day: weekOf(week, 'long'), what: said })}
        w={20} h={20}
        style={{
          borderRadius: 4,
          background: look.background,
          border: `${state === 'not_reported' ? '1px dashed' : '2px solid'} ${look.border}`,
          margin: '0 auto',
        }}
      />
    </Tooltip>
  );
}

/**
 * The grid. With `structure` it is the owner's to change: a line is added
 * under a goal, and each row opens its measure. Without it (`compact`, on the
 * Overview) it is read only, and draws nothing until there is a line.
 */
export function Scorecard({ companyId, structure, changed, compact, more }: {
  companyId: string;
  structure?: Structure;
  changed?: () => void;
  compact?: boolean;
  /** Where the whole scorecard is, from a compact one. */
  more?: () => void;
}) {
  const view = useLoad(
    () => api('GET', `/api/companies/${companyId}/scorecard`) as Promise<ScorecardView>,
    [companyId], { every: 60_000 },
  );
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState<Metric | null>(null);
  const [editing, setEditing] = useState<Metric | null>(null);

  if (view.error && !view.data) return compact ? null : <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return compact ? null : <Loading rows={3} />;
  const card = view.data;
  if (compact && card.lines.length === 0) return null;

  const metrics = structure?.goals.flatMap((goal) => goal.metrics) ?? [];
  const team = structure ? { roles: structure.roles, metrics } : undefined;
  const goals = structure?.goals.filter((goal) => goal.status === 'active') ?? [];
  const kindOf = (goalId: string) => structure?.goals.find((goal) => goal.id === goalId)?.kind;
  const after = () => {
    view.reload();
    changed?.();
  };
  const shown = compact ? card.lines.slice(0, 8) : card.lines;

  return (
    <Section
      title={t('Weekly scorecard')}
      description={t('The numbers read every week: each week shows its last checked figure against the weekly goal, counted in {zone}.', { zone: card.timezone })}
      actions={compact
        ? (more && <Anchor size="sm" onClick={more}>{t('Whole scorecard')}</Anchor>)
        : (structure && goals.length > 0 && (
          <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('Add a line')}</Button>
        ))}
    >
      {card.warning && !(compact && card.warning.kind === 'too_few') && card.lines.length > 0 && (
        <Alert color="orange" variant="light" mb="md">
          {card.warning.kind === 'too_few'
            ? t('A weekly scorecard reads best with {fewest} to {most} numbers, and this one has {lines}: add the numbers that would tell you something is wrong before it shows in the money.', card.warning)
            : t('A weekly scorecard reads best with {fewest} to {most} numbers, and this one has {lines}: take off the ones nobody acts on.', card.warning)}
        </Alert>
      )}
      {card.lines.length === 0 ? (
        <Text size="sm" c="dimmed">{t('No measure is reviewed every week yet. Add a line here, or mark a measure as weekly from its goal.')}</Text>
      ) : (
        <ScrollArea type="auto" offsetScrollbars>
          <Table verticalSpacing={6} horizontalSpacing="xs" style={{ minWidth: 260 + card.weeks.length * 30 }}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('Measure')}</Table.Th>
                <Table.Th ta="right">{t('Weekly goal')}</Table.Th>
                {card.weeks.map((week) => (
                  <Table.Th key={week} ta="center" w={30}>
                    <Text size="10px" c="dimmed" fw={500} className="tabular">{weekOf(week, 'short')}</Text>
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {shown.map((line, index) => {
                const metric = metrics.find((one) => one.id === line.metricId);
                // The second row of a pair drawn together is joined to the
                // first rather than separated from it.
                const joined = index > 0 && shown[index - 1]!.pairedWith === line.metricId && line.pairedWith === shown[index - 1]!.metricId;
                return (
                  <Table.Tr key={line.metricId} style={joined ? { borderTop: 'none' } : undefined}>
                    <Table.Td style={{ maxWidth: 260 }}>
                      <Group gap={4} wrap="nowrap">
                        {joined && <IconLink size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />}
                        <Text size="sm" fw={600} truncate>{line.name}</Text>
                      </Group>
                      <Text size="xs" c={line.ownerRole ? 'dimmed' : 'orange'} truncate>
                        {line.ownerRole ? roleLabel(line.ownerRole) : t('No seat owns it')}
                        {/* The first row of a pair drawn together says so; a pair
                            that is not a weekly line is named where it is not seen. */}
                        {line.pair && !joined
                          ? ` · ${shown.some((one) => one.metricId === line.pairedWith)
                            ? t('Watch both') : t('Watched with {name}', { name: line.pair.name })}`
                          : ''}
                      </Text>
                      {metric && !compact && (
                        <Group gap={4} mt={2}>
                          <Button size="compact-xs" variant="subtle" onClick={() => setRecording(metric)}>{t('Record a value')}</Button>
                          <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setEditing(metric)}>{t('Change')}</Button>
                        </Group>
                      )}
                    </Table.Td>
                    <Table.Td ta="right" style={{ whiteSpace: 'nowrap' }}>
                      <Text size="sm" className="tabular">{line.direction === 'up' ? '≥' : '≤'} {metricValue(line, line.target)}</Text>
                    </Table.Td>
                    {line.weeks.map((week) => (
                      <Table.Td key={week.week} ta="center" px={2}>
                        <Cell state={week.state} value={week.value} week={week.week} unit={line.unit} />
                      </Table.Td>
                    ))}
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      )}
      {card.lines.length > 0 && (
        <Group gap="md" mt="sm">
          {(Object.keys(STATES) as WeekState[]).map((state) => (
            <Group key={state} gap={6} wrap="nowrap">
              <Box w={12} h={12} style={{
                borderRadius: 3, background: STATES[state].background,
                border: `${state === 'not_reported' ? '1px dashed' : '2px solid'} ${STATES[state].border}`,
              }} />
              <Text size="xs" c="dimmed">{t(STATES[state].label)}</Text>
            </Group>
          ))}
        </Group>
      )}
      {structure && (
        <>
          <AddMetric companyId={companyId} goal={null} goals={goals} weekly team={team!} opened={adding}
            close={() => setAdding(false)} done={after} />
          {recording && (
            <RecordValue companyId={companyId} metric={recording} opened close={() => setRecording(null)} done={after} />
          )}
          {editing && (
            <ChangeMetric companyId={companyId} metric={editing} opened close={() => setEditing(null)} done={after} team={team!}
              {...(kindOf(editing.goalId) ? { goalKind: kindOf(editing.goalId)! } : {})} />
          )}
        </>
      )}
    </Section>
  );
}
