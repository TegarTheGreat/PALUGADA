import { N, locale, t } from './i18n.ts';

/**
 * An amount, with no currency symbol.
 *
 * The platform stores cents and does not know which currency they are: a
 * company's ledger decides that, and this console serves every company at
 * once. Printing a symbol would be inventing one, and a figure labelled in the
 * wrong currency is worse than a figure labelled in none.
 */
export function money(cents: number): string {
  return (cents / 100).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function count(n: number): string {
  return n.toLocaleString(locale(), n >= 10_000 ? { notation: 'compact', maximumFractionDigits: 1 } : {});
}

const UNITS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Number.POSITIVE_INFINITY, 'year'],
];

/** "5 min ago", "in 2 hr": how far a moment is from now, at a glance, in the owner's language. */
export function relative(iso: string | null | undefined): string {
  if (!iso) return '—';
  let delta = (new Date(iso).getTime() - Date.now()) / 1000;
  if (Math.abs(delta) < 45) return delta > 0 ? t('in a moment') : t('just now');
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'always', style: 'short' });
  for (const [size, unit] of UNITS) {
    if (Math.abs(delta) < size) return format.format(Math.round(delta), unit);
    delta /= size;
  }
  return iso;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(locale(), {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** A time of day, to the second: for lines said a moment apart. */
export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function day(iso: string): string {
  return new Date(iso).toLocaleDateString(locale(), { month: 'short', day: 'numeric' });
}

/** "task.rate_limited" as "Task rate limited". */
export function humanize(code: string): string {
  const words = code.replace(/[._]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Sentences for the events an owner reads most, and a readable fallback for the rest. */
const EVENT_SENTENCES: Record<string, string> = {
  'task.created': N('Task created'),
  'task.checked_out': N('Task picked up by a worker'),
  'task.planned': N('Plan recorded'),
  'task.attempt_failed': N('An attempt failed'),
  'task.rate_limited': N('Parked: a vendor said not now'),
  'task.stranded': N('Task stranded, put to you'),
  'task.lease_expired': N('Worker lost the task; reclaimed'),
  'task.handed_back': N('Handed back when the platform stopped; it resumes where it was'),
  'tool.called': N('Capability used'),
  'tool.cost': N('Capability cost recorded'),
  'approval.requested': N('Approval requested'),
  'approval.used': N('Approved action executed'),
  'approval.superseded': N('Approval replaced by a new proposal'),
  'owner.decided': N('You decided'),
  'owner.asked': N('You asked a question'),
  'owner.answered': N('You answered'),
  'owner.instructed': N('You told it something'),
  'task.rerun': N('Done again as a new task'),
  'owner.notified': N('You were notified'),
  'incident.raised': N('Incident raised'),
  'escalation.raised': N('Escalation raised'),
  'policy.denied': N('Refused by a policy'),
  'review.requested': N('Review requested'),
  'review.decided': N('Review decided'),
  'budget.refused': N('Refused: over budget'),
  'budget.circuit_open': N('Spending circuit breaker opened'),
  'budget.period_exhausted': N('Monthly ceiling reached'),
  'schedule.fired': N('Schedule fired'),
  'schedule.fire_failed': N('Schedule could not fire'),
  'role.frozen': N('Role frozen'),
  'role.unfrozen': N('Role resumed'),
  'wake.queued': N('Role woken'),
  'wake.idle': N('Woke with nothing to do'),
  'model.fell_back': N('Fell back to another model'),
  'memory.distilled': N('Memory distilled'),
  'skill.activated': N('Skill activated'),
  'credential.rotated': N('Credential rotated'),
  'goal.created': N('Goal added'),
  'goal.changed': N('Goal changed'),
  'metric.defined': N('Goal given a measure'),
  'metric.recorded': N('Measure recorded'),
  'structure.changed': N('Structure changed'),
  'gateway.device_registered': N('Device registered'),
  'gateway.device_paired': N('Device paired'),
  'gateway.device_revoked': N('Device revoked'),
  'cost.settled': N('Run cost settled'),
  'handoff.created': N('Work handed off'),
  'language.drifted': N('Wrote in the wrong language'),
  'company.languages_changed': N('Languages changed'),
  'memory.told': N('You told the company something'),
  'company.imported': N('Company imported'),
  'trigger.created': N('Trigger opened for outside events'),
  'trigger.fired': N('An outside event started work'),
  'trigger.rotated': N("Trigger's token replaced"),
  'trigger.opened': N('Trigger opened again'),
  'trigger.closed': N('Trigger closed'),
  'security.hook_refused': N('A trigger refused a caller without its token'),
};

export function eventSentence(type: string): string {
  const sentence = EVENT_SENTENCES[type];
  return sentence ? t(sentence) : humanize(type);
}

/** A task's status as a person says it, rather than as the state machine does. */
export const STATUS_LABELS: Record<string, string> = {
  pending: N('Queued'),
  checked_out: N('Picked up'),
  running: N('Running'),
  waiting_approval: N('Needs you'),
  waiting_review: N('In review'),
  waiting_window: N('Scheduled'),
  completed: N('Done'),
  failed: N('Failed'),
  halted: N('Halted'),
  cancelled: N('Cancelled'),
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

/** Why a task stopped, as the owner would say it (the codes are `HaltReason` in src/domain/task.ts). */
const HALT_REASONS: Record<string, string> = {
  contract_violation: N('Broke its contract'),
  policy_denied: N('Refused by a policy'),
  budget_exhausted: N('Out of budget'),
  hop_limit: N('Handed on too many times'),
  deadline_passed: N('Missed its deadline'),
  verification_failed: N('Its result did not check out'),
  capability_unhealthy: N('A capability it needs is down'),
  runtime_unavailable: N('No runtime could take it'),
  cycle_detected: N('Went in a circle'),
  fan_out_limit: N('Split into too many sub-tasks'),
  run_limit: N('Wrote more than its role allows one run'),
  approval_expired: N('Your approval was not given in time'),
  owner_stop: N('Stopped by you'),
  owner_cancel: N('Cancelled by you'),
  company_frozen: N('The company is frozen'),
  journal_divergence: N('Its record did not match on replay'),
  crash_loop: N('It kept stopping the worker running it'),
};

export function haltReason(code: string): string {
  const sentence = HALT_REASONS[code];
  return sentence ? t(sentence) : humanize(code);
}

export function statusLabel(status: string): string {
  const label = STATUS_LABELS[status];
  return label ? t(label) : humanize(status);
}

const GOAL_KINDS: Record<string, string> = {
  mission: N('Mission'), objective: N('Objective'), key_result: N('Key result'),
};

export function goalKind(kind: string): string {
  const label = GOAL_KINDS[kind];
  return label ? t(label) : humanize(kind);
}
