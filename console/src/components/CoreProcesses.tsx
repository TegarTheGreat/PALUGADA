/**
 * The company's core processes (F18.14, migration 0143): the handful of
 * skills that are the way it works, each owned by one seat. Drawn on the
 * Team chart beside the seats, and their warnings on the Skills page where
 * one is marked. What is counted -- the age, the runs of the seat's division
 * that read it, the soft limit -- is the server's (`coreProcessesOf`,
 * src/skills/core.ts); this only says it.
 */
import { Alert, Anchor, Badge, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconRoute } from '@tabler/icons-react';
import type { CoreProcess, CoreProcessWarning, CoreProcesses as Report, Role } from '../types.ts';
import { locale, t } from '../i18n.ts';
import { day, relative, roleLabel } from '../format.ts';

/** A warning in the owner's words, naming a seat by its name rather than its code. */
export function coreWarningSaid(warning: CoreProcessWarning, roles: Role[]): string {
  if (warning.kind === 'fewer_than_five') {
    return t('Core processes: {count}. The method this follows names five to twelve; mark the rest as you write them down.', { count: warning.count });
  }
  if (warning.kind === 'more_than_twelve') {
    return t('Core processes: {count}. The method this follows names five to twelve: a handful the work follows does more than many it does not.', { count: warning.count });
  }
  if (warning.kind === 'not_in_force') {
    return warning.reason === 'quarantined'
      ? t('{skill} came from outside and is quarantined, so its seat is not told to follow it and no share is counted. Lift the quarantine on its skill, or let it go as a core process.', { skill: warning.slug })
      : t('{skill} has no version in force, so its seat is not told to follow it and no share is counted until a version passes its checks, a reviewer and you.', { skill: warning.slug });
  }
  if (warning.kind === 'division_cannot_read') {
    const seat = roles.find((role) => role.id === warning.roleId);
    return t('{skill} is owned by {seat}, whose division cannot open it with skill.read, so no share is counted. Grant the division skill.read on Team, or give the process a seat that can read it.', {
      skill: warning.slug, seat: seat ? roleLabel(seat) : t('a seat'),
    });
  }
  return t('{skill} is {lines} lines long. A core process is kept to about sixty: the fifth of the detail that drives most of the result.', { skill: warning.slug, lines: warning.lines });
}

/** The warnings, or nothing: shown, never refused. */
export function CoreWarnings({ report, roles }: { report: Report; roles: Role[] }) {
  if (report.warnings.length === 0) return null;
  return (
    <Alert variant="light" color="yellow" title={t('Core processes')}>
      <Stack gap={4}>
        {report.warnings.map((warning) => (
          <Text key={'slug' in warning ? `${warning.kind}:${warning.slug}` : warning.kind} size="sm">
            {coreWarningSaid(warning, roles)}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}

const percent = (share: number) =>
  new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(share);

/**
 * How far a process is followed, or why nothing is counted: a share is only
 * said where the division's runs could have read it (src/skills/core.ts).
 */
function shareSaid(process: CoreProcess, days: number, since: string): string {
  if (!process.inForce) return t('Not in force: no share is counted');
  if (!process.divisionCanRead) return t('Its division cannot open it with skill.read');
  // One that came into force inside the window counts from then: a run
  // before it could not have read it (src/skills/core.ts).
  const young = Date.parse(process.countedSince) > Date.parse(since);
  const date = young ? day(process.countedSince) : '';
  if (process.followedShare === null) {
    return young ? t('No run of its division since it came into force on {date}', { date }) : t('No run of its division in the last {days} days', { days });
  }
  const counted = { share: percent(process.followedShare), followed: process.followedRuns, runs: process.runs };
  return young
    ? t('Followed in {share} of its division\'s runs ({followed} of {runs}) since it came into force on {date}', { ...counted, date })
    : t('Followed in {share} of its division\'s runs ({followed} of {runs}), last {days} days', { ...counted, days });
}

/** The warning colour for what the owner can fix, dimmed for a quiet division. */
function shareColor(process: CoreProcess): string | undefined {
  if (!process.inForce || !process.divisionCanRead) return 'orange';
  if (process.followedShare === null) return 'dimmed';
  return process.followedShare < 0.5 ? 'orange' : undefined;
}

/**
 * Each core process with its seat, when it last changed, and how much of
 * its division's work read it. Nothing is drawn for a company with none:
 * the Skills page says what one is, where it is marked.
 */
export function CoreProcessesPanel({ report, roles, openRole }: {
  report: Report; roles: Role[]; openRole: (role: Role) => void;
}) {
  if (report.processes.length === 0) return null;
  return (
    <Paper withBorder radius="md" p="md" mb="md">
      <Group gap={6} mb={4}><IconRoute size={16} /><Text size="xs" fw={700} tt="uppercase" c="dimmed">{t('Core processes')}</Text></Group>
      <Text size="xs" c="dimmed" mb="sm">
        {t('The handful of skills that are the way the company works, each kept current by one seat. A skill is made one on the Skills page.')}
      </Text>
      <Stack gap="xs">
        {report.processes.map((process) => {
          const seat = roles.find((role) => role.id === process.ownerRoleId);
          return (
            <Group key={process.skillId} justify="space-between" wrap="wrap" gap="xs">
              <div style={{ minWidth: 0 }}>
                <Group gap={6} wrap="wrap">
                  <Text size="sm" fw={600}>{process.slug}</Text>
                  {seat && <Anchor size="sm" component="button" type="button" onClick={() => openRole(seat)}>{roleLabel(seat)}</Anchor>}
                  {process.stale && <Badge size="sm" color="orange" variant="light">{t('Not changed in a quarter')}</Badge>}
                </Group>
                <Text size="xs" c="dimmed">{t('Changed {when}', { when: relative(process.updatedAt) })}</Text>
              </div>
              <Tooltip label={t('Runs of the seat\'s division that opened it with skill.read, over the last {days} days.', { days: report.windowDays })}>
                <Text size="sm" c={shareColor(process)}>{shareSaid(process, report.windowDays, report.since)}</Text>
              </Tooltip>
            </Group>
          );
        })}
      </Stack>
      {report.warnings.length > 0 && <Stack gap={4} mt="sm"><CoreWarnings report={report} roles={roles} /></Stack>}
    </Paper>
  );
}
