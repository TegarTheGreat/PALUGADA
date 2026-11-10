/**
 * What the console says of a goal, wherever it shows one: the Goals tab and
 * the Plan page say its status, period and commitment the same way.
 */
import { N, locale, t } from './i18n.ts';
import type { Goal } from './types.ts';

const GOAL_STATUS: Record<string, string> = { active: N('Active'), met: N('Met'), abandoned: N('Abandoned') };

export function goalStatus(status: string): string {
  const label = GOAL_STATUS[status];
  return label ? t(label) : status;
}

export const COMMITMENT: Record<string, string> = { committed: N('Committed'), aspirational: N('Aspirational'), learning: N('Learning') };

/** A goal's period as the owner's calendar writes a range of days. */
export function periodSaid(startsOn: string, dueOn: string): string {
  // Read as days, in UTC: a day read as midnight here is the day before west of UTC.
  const format = new Intl.DateTimeFormat(locale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return format.formatRange(new Date(`${startsOn}T00:00:00Z`), new Date(`${dueOn}T00:00:00Z`));
}

/**
 * The goals work can still be started under: active, and under nothing the
 * owner has closed -- the same rule the server holds (domain/goals.ts), so a
 * form offers only what it will accept.
 */
export function openGoals(goals: Goal[]): Goal[] {
  const byId = new Map(goals.map((goal) => [goal.id, goal]));
  const open = (goal: Goal, seen = new Set<string>()): boolean => {
    if (goal.status !== 'active') return false;
    if (!goal.parentId || seen.has(goal.id)) return true;
    seen.add(goal.id);
    const parent = byId.get(goal.parentId);
    return parent ? open(parent, seen) : true;
  };
  return goals.filter((goal) => open(goal));
}
