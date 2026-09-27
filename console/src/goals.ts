/**
 * The goals work can still be started under: active, and under nothing the
 * owner has closed -- the same rule the server holds (domain/goals.ts), so a
 * form offers only what it will accept.
 */
import type { Goal } from './types.ts';

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
