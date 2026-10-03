import { N, locale, t } from './i18n.ts';

/**
 * An amount, in US dollars, the way the owner's language writes them.
 *
 * Every amount the platform keeps is in US cents: providers price their
 * models in dollars per million tokens, runtimes report dollars, and the
 * catalogue estimates in cents. Printed without its currency, "0,75" in an
 * Indonesian console read as rupiah (the analysis of 3 October, §2.3 item 3).
 */
export function money(cents: number): string {
  return (cents / 100).toLocaleString(locale(), { style: 'currency', currency: 'USD' });
}

/**
 * Where the dollar sign goes around a typed amount, as `money` writes it:
 * "US$" before it in Indonesian, "$" after it in German.
 */
export function currencyAffix(): { prefix?: string; suffix?: string } {
  const parts = new Intl.NumberFormat(locale(), { style: 'currency', currency: 'USD' }).formatToParts(1);
  const at = parts.findIndex((part) => part.type === 'currency');
  const sign = parts[at]!.value;
  const number = parts.findIndex((part) => part.type === 'integer');
  return at < number ? { prefix: `${sign} ` } : { suffix: ` ${sign}` };
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

/**
 * A sentence for every event the server writes (`test/documents/console-events.test.ts`):
 * an event shown as its code was English in every language, and read as a log.
 */
const EVENT_SENTENCES: Record<string, string> = {
  'task.created': N('Task created'),
  'task.checked_out': N('Task picked up by a worker'),
  'task.planned': N('Plan recorded'),
  'task.attempt_failed': N('An attempt failed'),
  'task.rate_limited': N('Parked: a vendor said not now'),
  'task.waiting_slot': N('Parked: waiting for a call to the same capability to finish'),
  'task.model_waited': N('Parked: the model did not answer; it is tried again shortly'),
  'task.stranded': N('Task stranded, put to you'),
  'task.lease_expired': N('Worker lost the task; reclaimed'),
  'task.handed_back': N('Handed back when the platform stopped; it resumes where it was'),
  'agent_run.leftover_ended': N("A process left running by this task's run was ended"),
  'tool.called': N('Capability used'),
  'tool.cost': N('Capability cost recorded'),
  'tool.not_repeated': N('Not done again: an earlier attempt had already done it'),
  'approval.requested': N('Approval requested'),
  'approval.used': N('Approved action executed'),
  'approval.superseded': N('Approval replaced by a new proposal'),
  'approval.standing_granted': N('Allowed for a while by the owner'),
  'approval.standing_used': N('Ran on a yes the owner gave for a while'),
  'approval.standing_revoked': N('A yes for a while taken back'),
  'owner.decided': N('You decided'),
  'owner.asked': N('You asked a question'),
  'owner.answered': N('You answered'),
  'owner.instructed': N('You told it something'),
  'task.rerun': N('Done again as a new task'),
  'task.question_answered_by_platform': N('Asked how to set up a tool; told it is not connected'),
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
  'schedule.skipped': N('Schedule skipped a run: the last one was still going'),
  'schedule.nothing_to_review': N('Schedule skipped a run: nothing happened that week to review'),
  'schedule.held': N('Schedule waiting for its last run to finish'),
  'schedule.missed': N('Schedule missed a run: too late to be worth running'),
  'schedule.run_by_owner': N('You ran the schedule now'),
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
  'agent_run.orphaned': N('A run was left behind by a worker that stopped'),
  'alert.raised': N('An alert was raised'),
  'approval.answered': N('The agent answered your question on an approval'),
  'approval.expired': N('An approval expired unanswered'),
  'approval.returned': N('Your yes was kept for another try: the action failed'),
  'budget.halt_raised': N('Stopped by its budget, and put to you'),
  'budget.override_granted': N('You allowed spending past the limit for a while'),
  'budget.period_resumed': N('A new month began, and spending resumed'),
  'bundle.installed': N('Bundle installed'),
  'capability.healthy': N('A capability passed its check'),
  'capability.unhealthy': N('A capability failed its check'),
  'capability.window_closed': N('Put off: outside the hours it may run'),
  'company.closing': N('The company is being closed'),
  'company.kept': N('The company was kept, not closed'),
  'company.stage_changed': N('The company moved to another stage'),
  'config.restored': N('An earlier setting was restored'),
  'content.read_outside': N('Read content from outside the company'),
  'cost.drift': N('A capability cost more than estimated'),
  'cost.estimated': N('Cost estimated'),
  'credential.added': N('A key was added'),
  'credential.removed': N('A key was removed'),
  'division.escalation_set': N("A division's escalation rule was set"),
  'document.added': N('Document added'),
  'document.archived': N('Document archived'),
  'document.restored': N('Document restored'),
  'eval.negative_candidate': N('A run was kept as an example of what not to do'),
  'goal.work_paused': N('Work for a closed goal was paused'),
  'guardian.judged': N('The guardian checked an action'),
  'handoff.refused': N('A handoff was refused'),
  'handoff_rule.closed': N('A handoff rule was turned off'),
  'handoff_rule.created': N('Handoff rule added'),
  'handoff_rule.opened': N('A handoff rule was turned on'),
  'hook.post_run': N("A check refused the run's result"),
  'hook.post_tool': N("A check refused a tool's answer"),
  'hook.pre_run': N('A check refused to start the run'),
  'hook.pre_tool': N('A check refused a tool call'),
  'inbox.withdrawn': N('An inbox item was withdrawn'),
  'memory.distillation_failed': N('Learning from recent work failed'),
  'memory.retracted': N('You took back something the company knew'),
  'metric.changed': N('Measure changed'),
  'metric.retired': N('Measure retired'),
  'model.fallback_refused': N('Did not switch to another model'),
  'owner.decided_batch': N('You decided several at once'),
  'owner.decision_moot': N('Your decision came after the work had moved on'),
  'owner.feedback': N('You gave your word on the result'),
  'owner.notification_failed': N('A message to you could not be sent'),
  'owner.snoozed': N('You put an item off'),
  'owner.woke': N('You brought an item back'),
  'project.changed': N('Project changed'),
  'project.created': N('Project created'),
  'review.same_model': N('Reviewed by the same model that did the work'),
  'role.appointed_ceo': N('A role was made CEO'),
  'role.changed': N('Role changed'),
  'role.freeze_check_failed': N('The check that freezes a role failed'),
  'schedule.disabled': N('Schedule turned off'),
  'schedule.kept': N('Schedule kept'),
  'schedule.paused': N('Schedule paused: its goal is closed'),
  'schedule.removed': N('Schedule removed'),
  'schedule.repetition_noticed': N('A schedule keeps giving the same result'),
  'schedule.turned': N('Schedule turned on or off'),
  'security.chat_stranger_refused': N('A message from a stranger in chat was refused'),
  'security.gateway_bad_signature': N('A device message with a bad signature was refused'),
  'security.rls_denied': N("An attempt to read another company's data was refused"),
  'skill.candidate_rejected': N('A proposed skill failed its checks'),
  'skill.imported': N('Skill imported'),
  'skill.proposed': N('Skill proposed'),
  'skill.quarantine_lifted': N('You let a skill be used again'),
  'skill.rejected': N('Skill rejected'),
  'skill.review_rejected': N('A skill was turned down in review'),
  'skill.review_requested': N('A skill was sent for review'),
  'skill.scope_changed': N("A skill's reach was changed"),
  'sop.approved': N('Procedure approved'),
  'sop.proposed': N('Procedure proposed'),
  'sop.rejected': N('Procedure rejected'),
  'task.batched': N('Waiting for its batch window'),
  'task.cancelled': N('Task cancelled'),
  'task.capability_waited': N('Parked: a service did not answer; it is tried again shortly'),
  'task.completed': N('Task done'),
  'task.continued': N('Went on after its budget was raised'),
  'task.failed': N('Task failed'),
  'task.halted': N('Task stopped'),
  'task.pending': N('Back in the queue'),
  'task.running': N('Working on it'),
  'task.waiting_approval': N('Waiting for you'),
  'task.waiting_review': N('Waiting for review'),
  'task.waiting_window': N('Waiting for its hours'),
  'ticket.closed': N('Ticket closed'),
  'ticket.done': N('Ticket done'),
  'ticket.opened': N('Ticket opened'),
  'ticket.reopened': N('Ticket reopened'),
  'ticket.started': N('Work on a ticket started'),
  'tool.verified': N('Read back, and it matched'),
  'tool.verify_failed': N('Read back, and it did not match'),
  'trigger.secret_unavailable': N('A trigger could not read its secret, so events are not arriving'),
  'wake.coalesced': N('Woken once for several reasons'),
};

export function eventSentence(type: string): string {
  const sentence = EVENT_SENTENCES[type];
  return sentence ? t(sentence) : humanize(type);
}

/**
 * A step of a task's journal, or an event in its trace, as the owner says it.
 * The journal names its steps for the engine (`src/engine/journal.ts`), and
 * "model:turn 2" was shown as "Model:turn 2".
 */
export function stepSaid(name: string): string {
  const turn = /^model:turn (\d+)$/.exec(name);
  if (turn) return t('Thinking, turn {n}', { n: Number(turn[1]) });
  if (name === 'llm') return t('Thinking');
  if (name.startsWith('capability:')) return capabilitySaid(name.slice('capability:'.length));
  if (name.startsWith('await:')) return t('Waiting for {role}', { role: name.slice('await:'.length) });
  return eventSentence(name);
}

/**
 * What each capability the catalogue knows does, as the owner says it
 * (`test/documents/console-events.test.ts`). An approval asked the owner to
 * approve "record.delete", and the timeline badged events "crm.note"
 * (§2.3 item 7). A capability from outside the catalogue -- a vendor's, an
 * MCP server's tool -- keeps its own name.
 */
const CAPABILITY_NAMES: Record<string, string> = {
  'ads.campaign.start': N('Start an ad campaign'),
  'calendar.hold': N('Block time on the calendar'),
  'calendar.read': N('Read the calendar'),
  'code.execute': N('Run code'),
  'crm.note': N('Add a note to a customer'),
  'crm.read': N('Read customer records'),
  'deploy.production': N('Release to the live site'),
  'deploy.staging': N('Release to the test site'),
  'dns.nameservers': N("Change a domain's nameservers"),
  'dns.read': N("Read a domain's records"),
  'dns.update': N("Change a domain's record"),
  'doc.draft': N('Write a document'),
  'document.sign': N('Sign a document'),
  'domain.purchase': N('Buy a domain'),
  'domain.transfer': N('Transfer a domain'),
  'email.draft': N('Draft an email'),
  'email.send': N('Send an email'),
  'files.list': N('List files'),
  'funds.transfer': N('Transfer money'),
  'goal.propose': N('Propose a goal change'),
  'image.generate': N('Make a picture'),
  'invoice.issue': N('Issue an invoice'),
  'invoice.pay': N('Pay an invoice'),
  'ledger.read': N('Read the books'),
  'mailbox.read': N('Read the mailbox'),
  'memory.search': N('Search what the company knows'),
  'metric.record': N('Record a measure'),
  'metrics.read': N('Read product numbers'),
  'owner.ask': N('Ask you a question'),
  'plan.record': N('Write down a plan'),
  'record.delete': N('Delete a record'),
  'repo.branch': N('Propose a code change'),
  'repo.read': N('Read the code'),
  'server.destroy': N('Destroy a server'),
  'skill.read': N('Read a skill'),
  'social.publish': N('Publish a post'),
  'speech.synthesize': N('Read text aloud'),
  'speech.transcribe': N('Turn speech into text'),
  'stage.propose': N('Propose a new stage'),
  'task.await': N('Wait for work handed on'),
  'task.delegate': N('Hand work to another role'),
  'ticket.create': N('File a ticket'),
  'ticket.list': N('List tickets'),
  'uptime.check': N('Check a service is up'),
  'web.extract': N('Read a web page'),
  'web.fetch': N('Open a web page'),
  'web.search': N('Search the web'),
};

export function capabilitySaid(name: string): string {
  const said = CAPABILITY_NAMES[name];
  return said ? t(said) : name;
}

/** Who wrote an event, as the owner says it: never the part of the platform that did. */
const ACTORS: Record<string, string> = {
  owner: N('You'),
  agent_run: N('The agent'),
  scheduler: N('A schedule'),
};

export function actorSaid(actor: string): string {
  return t(ACTORS[actor] ?? N('The platform'));
}

/** A task's status as a person says it, rather than as the state machine does. */
export const STATUS_LABELS: Record<string, string> = {
  pending: N('Queued'),
  checked_out: N('Picked up'),
  running: N('Running'),
  waiting_approval: N('Needs you'),
  waiting_review: N('In review'),
  // Several kinds of wait, not one schedule: `waitingFor` says which (N9).
  waiting_window: N('Waiting'),
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
  // Its run said so, with why (N9): the reason is on the task.
  not_done: N('Not done'),
};

export function haltReason(code: string): string {
  const sentence = HALT_REASONS[code];
  return sentence ? t(sentence) : humanize(code);
}

/** Why a task waits, as the owner would say it (`WaitReason` in src/engine/tasks.ts). */
const WAIT_REASONS: Record<string, string> = {
  child: N('Waiting for work it handed on'),
  window: N('Waiting for its work hours'),
  cheap_hours: N('Waiting for cheaper hours'),
  vendor: N('A service asked it to wait'),
  slot: N('Waiting its turn at a tool'),
  model: N('Waiting for the model to answer'),
  service: N('Waiting for a service to answer again'),
  retry: N('Trying again shortly'),
};

/** A role a waiting task is held up by, as the work view sends it. */
interface HeldBy {
  role: string;
  roleName: string | null;
}

/**
 * What a waiting task waits for, in a line, and whether it is the owner
 * (N9); null when it is not waiting or did not say. The owner first, when
 * something below waits on them: that is what the whole chain waits for.
 */
export function waitingFor(
  waiting: { reason: string | null; on: HeldBy | null; needsYou: HeldBy | null } | null,
): { text: string; onYou: boolean } | null {
  if (!waiting) return null;
  const who = (held: HeldBy) => held.roleName ?? held.role;
  // Work below matters only to a task waiting on it; one parked for its
  // model has children that are not what it waits for. A wait from before
  // the reason was kept may be either.
  const onWork = waiting.reason === 'child' || waiting.reason === null;
  if (onWork && waiting.needsYou) {
    return { text: t('Waiting until you answer {role}', { role: who(waiting.needsYou) }), onYou: true };
  }
  if (onWork && waiting.on) return { text: t('Waiting for {role}', { role: who(waiting.on) }), onYou: false };
  const sentence = waiting.reason ? WAIT_REASONS[waiting.reason] : undefined;
  return sentence ? { text: t(sentence), onYou: false } : null;
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
