/**
 * A goal's grade and the company's numbers for a quarter (F18.8), as the
 * platform wrote and counted them (`goal_grades`, 0144; `gradeReportOf` in
 * src/domain/grades.ts). The goal ladder on Organization and the Plan page
 * both draw a grade with `GradeLine`, so a goal reads the same on either; the
 * Plan page shows the quarter's numbers with `GradeNumbers`. What is counted
 * is the server's; this only says it.
 */
import { Badge, Group, Paper, SimpleGrid, Text, Tooltip } from '@mantine/core';
import type { GoalGrade, Plan } from '../types.ts';
import { locale, t, tp } from '../i18n.ts';
import { periodSaid } from '../goals.ts';

const figure = (value: number) => value.toLocaleString(locale(), { maximumFractionDigits: 2 });
const percent = (share: number) => share.toLocaleString(locale(), { style: 'percent', maximumFractionDigits: 0 });

/**
 * A goal's latest grade, as the platform wrote it when a period of it ended:
 * a committed goal done or missed, any other its score, and a learning goal
 * its prediction beside what happened. The period and how the score was
 * reached are in the tooltip. `ps` lines it up under the card's text.
 */
export function GradeLine({ grade, ps = 0 }: { grade: GoalGrade; ps?: number }) {
  const period = periodSaid(grade.periodStartsOn, grade.periodDueOn);
  const how = [
    grade.basis === 'measured' ? t('Graded for {period}, from its numbers.', { period }) : t('Graded for {period}, by whether you marked it met.', { period }),
    ...(grade.note === 'no_reading' ? [t('A measure had no checked reading by the end, and counts as no progress.')] : []),
    ...(grade.note === 'from_key_results' ? [t('From the measures of the key results under it.')] : []),
    ...(grade.note === 'marked_met' ? [t('You marked it met, so it counts as done whatever its numbers say.')] : []),
  ].join(' ');
  return (
    <Group gap={6} mt={6} ps={ps}>
      <Tooltip label={how} multiline w={280}>
        {grade.passed === null
          ? <Badge variant="light" color={grade.score >= 0.6 ? 'teal' : 'gray'} size="sm">{t('Graded {score}', { score: figure(grade.score) })}</Badge>
          : <Badge variant="light" color={grade.passed ? 'teal' : 'red'} size="sm">{grade.passed ? t('Done, as committed') : t('Missed')}</Badge>}
      </Tooltip>
      {grade.predicted !== null && (
        <Text size="xs" c="dimmed">
          {grade.actual === null
            ? t('Predicted {predicted}, no checked reading', { predicted: figure(grade.predicted) })
            : t('Predicted {predicted}, came to {actual}', { predicted: figure(grade.predicted), actual: figure(grade.actual) })}
        </Text>
      )}
    </Group>
  );
}

/** One of the quarter's numbers: what it is, its figure, and what it was read from. */
function Figure({ label, value, detail, color }: { label: string; value: string; detail: string; color?: string }) {
  return (
    <Paper withBorder radius="md" p="sm">
      <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
      <Text size="lg" fw={700} className="tabular" c={color}>{value}</Text>
      <Text size="xs" c="dimmed">{detail}</Text>
    </Paper>
  );
}

/** What the aspirational average says, by the reading the server gave it. */
function aspirationalSaid(aspirational: Plan['grades']['numbers']['aspirational']): string {
  const range = { low: figure(aspirational.expected[0]), high: figure(aspirational.expected[1]) };
  switch (aspirational.reading) {
    case 'too_safe': return t('Close to 1: these goals may be set too safe.');
    case 'too_ambitious': return t('Far under {low}: these goals may be out of reach.', range);
    case 'expected': return t('Within {low} to {high}, a good result.', range);
    case 'between': return t('Near {low} to {high}, a good result.', range);
    default: return t('None graded this quarter yet. A good result is {low} to {high}.', range);
  }
}

/**
 * The fiscal quarter's numbers: the priorities done against the 80% aimed
 * for, the committed goals that passed, the aspirational average with how it
 * reads, and the to-dos finished within a week of being filed.
 */
export function GradeNumbers({ grades }: { grades: Plan['grades'] }) {
  const { priorities, committed, aspirational, todos } = grades.numbers;
  return (
    <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm">
      <Figure
        label={t('Priorities done')}
        value={priorities.share === null ? '—' : percent(priorities.share)}
        color={priorities.share === null ? undefined : priorities.share >= priorities.aim ? 'teal' : 'orange'}
        detail={priorities.total === 0
          ? t('No priority is due this quarter yet.')
          : tp('{done} of {count} priority due this quarter, against the {aim} aimed for.', '{done} of {count} priorities due this quarter, against the {aim} aimed for.',
            priorities.total, { done: priorities.done, aim: percent(priorities.aim) })}
      />
      <Figure
        label={t('Committed goals passed')}
        value={committed.passRate === null ? '—' : percent(committed.passRate)}
        color={committed.passRate === null ? undefined : committed.passRate >= 1 ? 'teal' : 'red'}
        detail={committed.graded === 0
          ? t('No committed goal is graded this quarter yet.')
          : tp('{passed} of {count} committed goal graded this quarter passed.', '{passed} of {count} committed goals graded this quarter passed.',
            committed.graded, { passed: committed.passed })}
      />
      <Figure
        label={t('Aspirational average')}
        value={aspirational.average === null ? '—' : figure(aspirational.average)}
        color={aspirational.reading === 'expected' ? 'teal' : aspirational.reading === null ? undefined : 'orange'}
        detail={aspirationalSaid(aspirational)}
      />
      <Figure
        label={t('To-dos within a week')}
        value={todos.share === null ? '—' : percent(todos.share)}
        detail={todos.total === 0
          ? t('No to-do filed this quarter has had its week yet.')
          : tp('{within} of {count} to-do filed this quarter finished within seven days.', '{within} of {count} to-dos filed this quarter finished within seven days.',
            todos.total, { within: todos.withinWeek })}
      />
    </SimpleGrid>
  );
}
