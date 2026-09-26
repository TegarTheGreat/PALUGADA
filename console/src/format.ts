/**
 * An amount, with no currency symbol.
 *
 * The platform stores cents and does not know which currency they are: a
 * company's ledger decides that, and this console serves every company at
 * once. Printing a symbol would be inventing one, and a figure labelled in the
 * wrong currency is worse than a figure labelled in none.
 */
export function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  return n.toLocaleString('en-US');
}

const UNITS: Array<[number, string]> = [
  [60, 's'], [60, 'm'], [24, 'h'], [30, 'd'], [12, 'mo'], [Number.POSITIVE_INFINITY, 'y'],
];

/** "5m ago", "in 2h": how far a moment is from now, at a glance. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  let delta = (new Date(iso).getTime() - Date.now()) / 1000;
  const future = delta > 0;
  delta = Math.abs(delta);
  if (delta < 45) return future ? 'in a moment' : 'just now';
  for (const [size, unit] of UNITS) {
    if (delta < size) return future ? `in ${Math.round(delta)}${unit}` : `${Math.round(delta)}${unit} ago`;
    delta /= size;
  }
  return iso;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "task.rate_limited" as "Task rate limited". */
export function humanize(code: string): string {
  const words = code.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Sentences for the events an owner reads most, and a readable fallback for the rest. */
const EVENT_SENTENCES: Record<string, string> = {
  'task.created': 'Task created',
  'task.checked_out': 'Task picked up by a worker',
  'task.planned': 'Plan recorded',
  'task.attempt_failed': 'An attempt failed',
  'task.rate_limited': 'Parked: a vendor said not now',
  'task.stranded': 'Task stranded, put to you',
  'task.lease_expired': 'Worker lost the task; reclaimed',
  'tool.called': 'Capability used',
  'tool.cost': 'Capability cost recorded',
  'approval.requested': 'Approval requested',
  'approval.used': 'Approved action executed',
  'approval.superseded': 'Approval replaced by a new proposal',
  'owner.decided': 'You decided',
  'owner.asked': 'You asked a question',
  'owner.answered': 'You answered',
  'owner.notified': 'You were notified',
  'incident.raised': 'Incident raised',
  'escalation.raised': 'Escalation raised',
  'policy.denied': 'Refused by a policy',
  'review.requested': 'Review requested',
  'review.decided': 'Review decided',
  'budget.refused': 'Refused: over budget',
  'budget.circuit_open': 'Spending circuit breaker opened',
  'budget.period_exhausted': 'Monthly ceiling reached',
  'schedule.fired': 'Schedule fired',
  'schedule.fire_failed': 'Schedule could not fire',
  'role.frozen': 'Role frozen',
  'role.unfrozen': 'Role resumed',
  'wake.queued': 'Role woken',
  'wake.idle': 'Woke with nothing to do',
  'model.fell_back': 'Fell back to another model',
  'memory.distilled': 'Memory distilled',
  'skill.activated': 'Skill activated',
  'credential.rotated': 'Credential rotated',
  'goal.created': 'Goal added',
  'goal.changed': 'Goal changed',
  'structure.changed': 'Structure changed',
  'gateway.device_registered': 'Device registered',
  'gateway.device_paired': 'Device paired',
  'gateway.device_revoked': 'Device revoked',
  'cost.settled': 'Run cost settled',
  'handoff.created': 'Work handed off',
};

export function eventSentence(type: string): string {
  return EVENT_SENTENCES[type] ?? humanize(type);
}

/** A task's status as a person says it, rather than as the state machine does. */
export const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  checked_out: 'Picked up',
  running: 'Running',
  waiting_approval: 'Needs you',
  waiting_review: 'In review',
  waiting_window: 'Scheduled',
  completed: 'Done',
  failed: 'Failed',
  halted: 'Halted',
  cancelled: 'Cancelled',
};

export const STATUS_COLORS: Record<string, string> = {
  pending: 'gray',
  checked_out: 'blue',
  running: 'blue',
  waiting_approval: 'orange',
  waiting_review: 'grape',
  waiting_window: 'cyan',
  completed: 'teal',
  failed: 'red',
  halted: 'red',
  cancelled: 'gray',
};
