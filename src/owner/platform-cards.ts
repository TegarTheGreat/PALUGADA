/**
 * What the platform itself tells the owner on a card in the inbox -- an
 * incident, an escalation, an alert -- in the owner's language (the analysis
 * of 3 October, §2.3 item 7).
 *
 * These cards were written in English whatever the owner reads, and with the
 * platform's codes inside them: "Role ops-coordinator is paused", "Capability
 * web.search failed preflight", "spent 3120 of 20000 cents in the period
 * beginning 2026-10-01", "Task 9f3c... has been waiting_approval since
 * 2026-10-02T03:14:00.000Z", "from validate to build". Each is composed here,
 * as the budget halt's is (budget-halt.ts), from facts rather than from
 * English: roles and capabilities by name, stages as the console names them,
 * money in the owner's currency, times in the owner's zone, a task by what
 * it was asked. What a service, a check or the platform said in its own words
 * -- a vendor's error, a refusal's message -- is kept as it was, after.
 */
import type { TenantClient } from '../db/tenant.ts';
import type { MoneyDisplay } from '../domain/money-display.ts';
import type { StrandedShape } from '../engine/liveness.ts';
import type { Goal } from '../domain/goals.ts';
import { capabilitySaid } from './capability-said.ts';
import { haltSaid } from './halt-said.ts';
import { moneySaid } from './money-said.ts';
import { say } from './say.ts';

/** How the owner reads what the platform says: their language, their currency, their clock. */
export interface OwnerReading {
  language: string | null;
  display: MoneyDisplay | null;
  timezone: string;
}

/** Read inside the transaction that raises the card. The application role reads `platform_control`. */
export async function ownerReadingWithin(tx: TenantClient): Promise<OwnerReading> {
  const { rows } = await tx.query<{
    console_language: string | null; display_currency: string | null; display_rate: string | null; owner_timezone: string | null;
  }>('SELECT console_language, display_currency, display_rate, owner_timezone FROM platform_control');
  const row = rows[0];
  return {
    language: row?.console_language ?? null,
    display: row?.display_currency && row.display_rate !== null
      ? { currency: row.display_currency, rate: Number(row.display_rate) } : null,
    timezone: row?.owner_timezone ?? 'UTC',
  };
}

/**
 * A role by the name the owner gave it, and by its title or code when it has
 * none. Read in the company's own transaction (`withTenant`): a code names a
 * role only within one company.
 */
export async function roleCalledWithin(tx: TenantClient, by: { id?: string; slug?: string }): Promise<string> {
  const { rows } = await tx.query<{ called: string }>(
    `SELECT coalesce(display_name, title, slug) AS called FROM roles WHERE ${by.id ? 'id = $1' : 'slug = $1'}`,
    [by.id ?? by.slug]);
  return rows[0]?.called ?? by.slug ?? '';
}

/** What a task was asked, in a line. */
export async function taskCalledWithin(tx: TenantClient, taskId: string): Promise<string> {
  const { rows } = await tx.query<{ goal: string | null }>("SELECT input->>'goal' AS goal FROM tasks WHERE id = $1", [taskId]);
  const goal = (rows[0]?.goal ?? '').replace(/\s+/g, ' ').trim();
  return goal.length > 120 ? `${goal.slice(0, 119).trimEnd()}…` : goal || taskId;
}

export interface Card {
  title: string;
  detail: string;
}

/** A card's own sentences, then the record a service or check gave, as it gave it. */
function withRecord(said: string, record: string | null | undefined): string {
  const kept = record?.trim();
  return kept ? `${said}\n\n${kept}` : said;
}

function day(reading: OwnerReading, at: Date): string {
  return at.toLocaleDateString(reading.language ?? 'en', { dateStyle: 'medium', timeZone: reading.timezone });
}

function moment(reading: OwnerReading, at: Date): string {
  return at.toLocaleString(reading.language ?? 'en', { dateStyle: 'medium', timeStyle: 'short', timeZone: reading.timezone });
}

function number(reading: OwnerReading, value: number, digits = 0): string {
  return value.toLocaleString(reading.language ?? 'en', { maximumFractionDigits: digits });
}

/** A stage as the console names it. */
export function stageSaid(language: string | null, stage: string | null): string {
  switch (stage) {
    case null: return say(language, 'no stage');
    case 'explore': return say(language, 'Explore');
    case 'validate': return say(language, 'Validate');
    case 'build': return say(language, 'Build');
    case 'launch': return say(language, 'Launch');
    case 'grow': return say(language, 'Grow');
    case 'wind_down': return say(language, 'Wind down');
    default: return stage;
  }
}

/* --------------------------------------------------------------- money --- */

export function spendPausedCard(reading: OwnerReading, facts: { spentCents: number; limitCents: number; since: Date }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Monthly budget reached; the company is paused'),
    detail: say(language,
      '{spent} of {limit} spent since {since}. No new task will start and no external action will run until you raise the ceiling or allow spending past it for a while, under Money.',
      { spent: moneySaid(language, facts.spentCents, reading.display), limit: moneySaid(language, facts.limitCents, reading.display), since: monthBegan(reading, facts.since) }),
  };
}

/**
 * The month's first day as the ceiling counts it. The ceiling's month is a
 * calendar month in UTC (spend-guard.ts), so its first day is named in UTC:
 * in the owner's own zone it can fall on the last day of the month before.
 */
function monthBegan(reading: OwnerReading, since: Date): string {
  return day({ ...reading, timezone: 'UTC' }, since);
}

export function spendWarnedCard(reading: OwnerReading, facts: { spentCents: number; limitCents: number; since: Date }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Monthly budget is 80% spent'),
    detail: say(language, '{spent} of {limit} spent since {since}. At 100% the company pauses.',
      { spent: moneySaid(language, facts.spentCents, reading.display), limit: moneySaid(language, facts.limitCents, reading.display), since: monthBegan(reading, facts.since) }),
  };
}

export function roleSpendingFastCard(reading: OwnerReading, facts: { role: string; lastHourCents: number; usualCents: number; multiple: number }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Role {role} is paused for spending too fast', { role: facts.role }),
    detail: say(language,
      '{role} spent {spent} in the last hour, {multiple} times its usual {usual} an hour. It is paused before the monthly ceiling is reached, so there is money left to work with once you have found out why. Resume it when you have.',
      {
        role: facts.role, spent: moneySaid(language, facts.lastHourCents, reading.display),
        usual: moneySaid(language, facts.usualCents, reading.display), multiple: number(reading, facts.multiple, 1),
      }),
  };
}

/* -------------------------------------------------------------- alerts --- */

export type AlertFacts =
  | { kind: 'daily_cost'; costCents: number; limitCents: number }
  | { kind: 'task_failure_rate'; failed: number; finished: number; rate: number; limit: number }
  | { kind: 'policy_denials'; count: number; limit: number }
  | { kind: 'verification_failures'; count: number }
  | { kind: 'preflight_failures'; count: number }
  | { kind: 'orphaned_runs'; count: number };

export function alertCard(reading: OwnerReading, facts: AlertFacts): Card {
  const { language } = reading;
  switch (facts.kind) {
    case 'daily_cost':
      return {
        title: say(language, 'Daily model spend over threshold'),
        detail: say(language, 'Model spend today is {spent}, over the {limit} ceiling.',
          { spent: moneySaid(language, facts.costCents, reading.display), limit: moneySaid(language, facts.limitCents, reading.display) }),
      };
    case 'task_failure_rate':
      return {
        title: say(language, 'Task failure rate over threshold'),
        detail: say(language, '{failed} of {finished} tasks failed or stopped today ({rate}%), over the {limit}% threshold.', {
          failed: number(reading, facts.failed), finished: number(reading, facts.finished),
          rate: number(reading, Math.round(facts.rate * 100)), limit: number(reading, Math.round(facts.limit * 100)),
        }),
      };
    case 'policy_denials':
      return {
        title: say(language, 'Unusual number of policy refusals'),
        detail: say(language,
          'Actions refused by a policy today: {count}, over the threshold of {limit}. Either an agent is probing its limits or a policy is miscalibrated.',
          { count: number(reading, facts.count), limit: number(reading, facts.limit) }),
      };
    case 'verification_failures':
      return {
        title: say(language, 'External writes failed verification'),
        detail: say(language,
          'Writes outside that reported success but read back differently: {count}. Something is changing them other than as asked.',
          { count: number(reading, facts.count) }),
      };
    case 'preflight_failures':
      return {
        title: say(language, 'A capability stopped being usable'),
        detail: say(language,
          'Tasks that could not start today because a capability their role needs failed its check: {count}. A credential has probably expired or a quota is used up.',
          { count: number(reading, facts.count) }),
      };
    case 'orphaned_runs':
      return {
        title: say(language, 'A worker stopped reporting mid-run'),
        detail: say(language,
          'Runs that stopped reporting and were taken back today: {count}. The work was picked up again; the tokens they had already spent were not recovered.',
          { count: number(reading, facts.count) }),
      };
  }
}

/* ---------------------------------------------------------------- roles --- */

export function roleFrozenCard(reading: OwnerReading, facts: { role: string; denials: number; limit: number; capabilities: string[] }): Card {
  const { language } = reading;
  const said = say(language,
    '{role} was refused {denials} times today, at the limit of {limit}. No task will run as this role until you lift the freeze. The usual causes are a missing capability grant, a policy the role\'s charter does not account for, or work the role was never equipped to do.',
    { role: facts.role, denials: number(reading, facts.denials), limit: number(reading, facts.limit) });
  return {
    title: say(language, 'Role {role} is frozen after repeated denials', { role: facts.role }),
    detail: facts.capabilities.length === 0 ? said : `${said}\n\n${say(language, 'What it was refused: {capabilities}',
      { capabilities: facts.capabilities.map((name) => capabilitySaid(language, name)).join(', ') })}`,
  };
}

/* ---------------------------------------------------------------- tasks --- */

export function waitingOnNothingCard(reading: OwnerReading, facts: { task: string; since: Date; shape: StrandedShape }): Card {
  const { language } = reading;
  const why = {
    approval_missing: () => say(language, 'It is waiting for an approval, and none is open, so nothing you can answer will move it.'),
    review_missing: () => say(language, 'It is waiting for a review, and none is pending, so no reviewer and no decision of yours will move it.'),
    wake_missing: () => say(language, 'It is parked until a window reopens, and the window never does.'),
  }[facts.shape]();
  return {
    title: say(language, 'A task is waiting on nothing'),
    detail: say(language,
      '"{task}" has been waiting since {since}. {why} Approve to run it again from where it stopped, or deny to cancel it.',
      { task: facts.task, since: moment(reading, facts.since), why }),
  };
}

export function crashLoopCard(reading: OwnerReading, facts: { task: string; lost: number }): Card {
  const { language } = reading;
  return {
    title: say(language, 'A task keeps stopping the worker running it'),
    detail: say(language,
      '"{task}" lost its worker {lost} times: each time the worker running it stopped answering before the work finished. What it had done is kept. It is halted so it cannot take another worker down; run it again once the cause is found, or cancel it.',
      { task: facts.task, lost: number(reading, facts.lost) }),
  };
}

export function serviceUnreachableCard(reading: OwnerReading, facts: { failures: ReadonlyArray<{ capability: string; detail: string }>; minutes: number }): Card {
  const { language } = reading;
  const services = [...new Set(facts.failures.map((failure) => capabilitySaid(language, failure.capability)))];
  return {
    title: say(language, '{services} stayed unreachable, and the work that needs it stopped', { services: services.join(', ') }),
    detail: withRecord(say(language,
      'The task waited about {minutes} minutes, looking again each time, and has stopped. Once the service answers, run it again.',
      { minutes: number(reading, facts.minutes) }),
    facts.failures.map((failure) => `${capabilitySaid(language, failure.capability)}: ${failure.detail}`).join('\n')),
  };
}

export function modelFailedCard(reading: OwnerReading, facts: { model: string; tries: number; minutes: number; irreversible: boolean; record: string }): Card {
  const { language } = reading;
  const tried = say(language, 'It was tried {tries} times over about {minutes} minutes.',
    { tries: number(reading, facts.tries), minutes: number(reading, facts.minutes) });
  const why = facts.irreversible
    ? say(language, 'This role can take actions that cannot be undone, so the run was not silently moved to a different model.')
    : say(language, 'No fallback model is left for this role.');
  return {
    title: say(language, 'Model {model} failed and the run was not moved', { model: facts.model }),
    detail: withRecord(`${tried} ${why}`, facts.record),
  };
}

/**
 * The model's key was refused (401 or 403). It names the provider, says what
 * stopped and where to put a key that works, and ends with what the provider
 * said in its own words. One sentence, so the assistant's chat answer and the
 * inbox card read the same.
 */
export function modelKeyRefusedSaid(language: string | null, facts: { host: string; status: number; providerSaid: string | null }): string {
  return withRecord(say(language,
    '{host} refused the model key ({status}), so nothing that needs the model can run. Open Settings, This deployment, Model, paste a key that works, test it and save.',
    { host: facts.host, status: String(facts.status) }), facts.providerSaid);
}

export function modelKeyRefusedCard(reading: OwnerReading, facts: { host: string; status: number; providerSaid: string | null }): Card {
  const { language } = reading;
  return {
    title: say(language, '{host} refused the model key, and work is waiting', { host: facts.host }),
    detail: `${modelKeyRefusedSaid(language, facts)}\n\n${say(language, 'What is waiting for the model carries on by itself once a key that works is in use.')}`,
  };
}

/**
 * A root task that ended without being done and has no card of its own
 * (`src/engine/ended.ts`). `record` is what the platform said when it ended.
 */
export function endedBadlyCard(reading: OwnerReading, facts: { task: string; reason: string | null; record: string | null }): Card {
  const { language } = reading;
  return {
    title: say(language, 'A task ended before it was done: {task}', { task: facts.task }),
    detail: withRecord(say(language,
      'It ended as: {reason}. No other card was raised for it, so it is here rather than silent.',
      { reason: haltSaid(language, facts.reason) }), facts.record),
  };
}

export function writeUnverifiedCard(reading: OwnerReading, facts: { record: string }): Card {
  const { language } = reading;
  return {
    title: say(language, 'External write failed verification'),
    detail: withRecord(say(language,
      'The task wrote to an outside service and read it back, and what it read did not match. Look at the place it wrote to before you run it again: the write may have happened.'),
    facts.record),
  };
}

/* -------------------------------------------------------------- reviews --- */

export function reviewDeadlockedCard(reading: OwnerReading, facts: { capability: string; rounds: number; note: string | null; criteria: string }): Card {
  const { language } = reading;
  const capability = capabilitySaid(language, facts.capability);
  return {
    title: say(language, 'Review deadlocked after {rounds} revisions: {capability}', { rounds: number(reading, facts.rounds), capability }),
    detail: [
      say(language, 'The role and its reviewer did not agree on {capability}.', { capability }),
      facts.note ? say(language, 'The reviewer\'s last note: {note}', { note: facts.note }) : say(language, 'The reviewer left no note.'),
      say(language, 'What it was judged against: {criteria}', { criteria: facts.criteria }),
    ].join('\n\n'),
  };
}

/** `record`: what the platform said when the verdict could not be kept, as it said it. */
export function reviewUnreadableCard(reading: OwnerReading, facts: { capability: string; record?: string }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Review produced no usable verdict: {capability}', { capability: capabilitySaid(language, facts.capability) }),
    detail: withRecord(say(language, 'The reviewing task ended without a decision that could be read. The proposed action is still blocked and needs your judgement.'),
      facts.record),
  };
}

/* --------------------------------------------------------------- stages --- */

export function stageMoveStoppedCard(reading: OwnerReading, facts: {
  reviewer: string; from: string | null; to: string | null; reason: string; evidence: string; why: string;
}): Card & { consequence: string } {
  const { language } = reading;
  const to = facts.to ? stageSaid(language, facts.to) : say(language, 'another stage');
  return {
    consequence: `${facts.from
      ? say(language, 'Either answer only closes this: the company stays in the {stage} stage.', { stage: stageSaid(language, facts.from) })
      : say(language, 'Either answer only closes this: the company stays without a stage.')} ${say(language, 'To move it anyway, set the stage on the Overview.')}`,
    title: say(language, '{reviewer} stopped a proposal to move the company from {from} to {to}',
      { reviewer: facts.reviewer, from: stageSaid(language, facts.from), to }),
    detail: [
      say(language, '{reviewer} reviewed it before you and stopped it:', { reviewer: facts.reviewer }),
      facts.reason || say(language, 'No reason was given.'),
      '',
      say(language, 'What was proposed:'),
      facts.evidence,
      ...(facts.why ? ['', facts.why] : []),
    ].join('\n'),
  };
}

export function stageMoveCard(reading: OwnerReading, facts: {
  from: string | null; to: string; evidence: string; why: string; reviewed: { reviewer: string; reason: string } | null;
}): Card & { consequence: string } {
  const { language } = reading;
  return {
    consequence: facts.from
      ? say(language, 'The company stays in the {stage} stage.', { stage: stageSaid(language, facts.from) })
      : say(language, 'The company stays without a stage.'),
    title: say(language, 'Move the company from {from} to {to}?', { from: stageSaid(language, facts.from), to: stageSaid(language, facts.to) }),
    detail: [
      facts.evidence,
      ...(facts.why ? ['', facts.why] : []),
      ...(facts.reviewed
        ? ['', say(language, 'Reviewed by {reviewer} before you:', { reviewer: facts.reviewed.reviewer }), facts.reviewed.reason]
        : []),
    ].join('\n'),
  };
}

/* ------------------------------------------------------------ the rest --- */

export function scheduleRepeatsCard(reading: OwnerReading, facts: { schedule: string; runs: number }): Card {
  const { language } = reading;
  return {
    title: say(language, 'The schedule "{schedule}" keeps producing the same result', { schedule: facts.schedule }),
    detail: say(language,
      'Its last {runs} runs all ended with the same output. That is sometimes exactly right -- a report with nothing new to say -- and often a schedule that stopped doing anything useful while still being paid for. Deny to turn it off; approve to keep it running and not be asked about this result again.',
      { runs: number(reading, facts.runs) }),
  };
}

export function capabilityFailedCard(reading: OwnerReading, facts: { capability: string; record: string }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Capability {capability} failed preflight', { capability: capabilitySaid(language, facts.capability) }),
    detail: withRecord(say(language,
      'Work that needs it is stopped rather than started: fix the cause, then run that work again. The usual causes are an expired or wrongly scoped credential, a quota used up, or an address that is wrong.'),
    facts.record),
  };
}

export function batchStoppedCard(reading: OwnerReading, facts: { capability: string; record: string }): Card {
  const { language } = reading;
  return {
    title: say(language, 'Batch guard stopped {capability}', { capability: capabilitySaid(language, facts.capability) }),
    detail: withRecord(say(language, 'It did not match the plan its run recorded. Nothing was sent, and no service was called.'), facts.record),
  };
}

/** Said under an escalation a division's own role was asked to handle first (F2.1). */
export function askedFirstSaid(reading: OwnerReading, facts: { role: string; minutes: number }): string {
  return say(reading.language, '{role} was asked first and has had {minutes} minutes.',
    { role: facts.role, minutes: number(reading, facts.minutes) });
}

/** Said under an escalation the role it was meant for could not be given, so it came to the owner at once. */
export function handoffFailedSaid(reading: OwnerReading, facts: {
  role: string; why: { kind: 'no_role' } | { kind: 'nowhere' } | { kind: 'refused'; record: string };
}): string {
  const { language } = reading;
  switch (facts.why.kind) {
    case 'no_role':
      return say(language, '{role} is not a role in this company, so this came to you at once.', { role: facts.role });
    case 'nowhere':
      return say(language, '{role} could not be given this: the company has no active goal or project to hang it from.', { role: facts.role });
    case 'refused':
      return say(language, '{role} could not be given this ({record}), so this came to you at once.', { role: facts.role, record: facts.why.record });
  }
}

/** What the role an escalation was handed to did about it, written under it for the owner. */
export function handledSaid(reading: OwnerReading, facts: { role: string; summary: string | null; status: string; haltReason: string | null }): string {
  const { language } = reading;
  if (facts.summary) return `${facts.role}: ${facts.summary}`;
  if (facts.haltReason) {
    return say(language, '{role} stopped without an account of what it did ({why}).', { role: facts.role, why: haltSaid(language, facts.haltReason) });
  }
  switch (facts.status) {
    case 'completed': return say(language, '{role} finished without an account of what it did.', { role: facts.role });
    case 'failed': return say(language, '{role} failed without an account of what it did.', { role: facts.role });
    default: return say(language, '{role} was stopped without an account of what it did.', { role: facts.role });
  }
}

export function goalChangeCard(reading: OwnerReading, facts: {
  kind: string; statement: string; status: string; to: { statement?: string; status?: string }; reason: string;
  /** Where the goal's own measures stand, as the platform reads them: the evidence beside the agent's reason. */
  measures?: ReadonlyArray<{ name: string; target: number; now: { value: number; checked: boolean } | null }>;
}): Card & { consequence: string } {
  const { language } = reading;
  const kind = goalKindSaid(language, facts.kind);
  const status = (value: string) => goalStatusSaid(language, value);
  return {
    title: say(language, 'Proposed change to the {kind} "{goal}"', { kind, goal: facts.statement.length > 80 ? `${facts.statement.slice(0, 79)}…` : facts.statement }),
    detail: [
      facts.status === 'active'
        ? say(language, 'Currently: {statement}', { statement: facts.statement })
        : say(language, 'Currently: {statement} ({status})', { statement: facts.statement, status: status(facts.status) }),
      ...(facts.to.statement ? [say(language, 'Proposed: {statement}', { statement: facts.to.statement })] : []),
      ...(facts.to.status ? [say(language, 'Proposed status: {status}', { status: status(facts.to.status) })] : []),
      say(language, 'Reason given: {reason}', { reason: facts.reason }),
      ...((facts.measures?.length ?? 0) > 0
        ? [
          '',
          say(language, 'Where its measures stand, as the platform reads them:'),
          ...facts.measures!.map((measure) => {
            const target = number(reading, measure.target, 2);
            if (!measure.now) return say(language, '{name}: no value recorded yet, against a target of {target}.', { name: measure.name, target });
            const value = number(reading, measure.now.value, 2);
            return measure.now.checked
              ? say(language, '{name}: {value} against a target of {target}, read back from its source.', { name: measure.name, value, target })
              : say(language, '{name}: {value} against a target of {target}, reported and not checked.', { name: measure.name, value, target });
          }),
        ]
        : []),
      '',
      say(language, 'Approving it changes the goal; until then the work carries on under the goal as it is.'),
    ].join('\n'),
    consequence: say(language, 'The goal stays as it is.'),
  };
}

/**
 * A run's proposal that some work recur (`schedule.propose`): what, who,
 * when -- the expression as written and the next runs in the owner's own
 * time, which say it in any language -- and why.
 */
export function scheduleProposalCard(reading: OwnerReading, facts: {
  name: string; role: string; proposer: string; instruction: string; cron: string; timezone: string; next: Date[]; reason: string;
}): Card & { consequence: string } {
  const { language } = reading;
  const runs = facts.next.map((at) => at.toLocaleString(language ?? 'en', {
    weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: reading.timezone,
  })).join('; ');
  return {
    title: say(language, '{role} proposes the schedule {name}', { role: facts.proposer, name: facts.name }),
    detail: [
      say(language, 'Each run: {instruction}', { instruction: facts.instruction }),
      say(language, 'Done by: {role}', { role: facts.role }),
      say(language, 'When: {cron} ({timezone}); the next runs are {runs}', { cron: facts.cron, timezone: facts.timezone, runs }),
      say(language, 'Reason given: {reason}', { reason: facts.reason }),
      '',
      say(language, 'Approving it makes the schedule and starts it; it can be turned off or changed under Team, Schedules.'),
    ].join('\n'),
    consequence: say(language, 'No schedule is made.'),
  };
}

/* ---------------------------------------------------------------- goals --- */

function goalKindSaid(language: string | null, kind: string): string {
  switch (kind) {
    case 'mission': return say(language, 'mission');
    case 'objective': return say(language, 'objective');
    case 'key_result': return say(language, 'key result');
    default: return kind;
  }
}

function goalStatusSaid(language: string | null, status: string): string {
  switch (status) {
    case 'active': return say(language, 'Active');
    case 'met': return say(language, 'Met');
    case 'abandoned': return say(language, 'Abandoned');
    default: return status;
  }
}

/** The goals a piece of work serves, from the mission down, as `renderAncestry` gives them to an agent. */
function ancestrySaid(language: string | null, chain: ReadonlyArray<Pick<Goal, 'kind' | 'status' | 'statement'>>): string {
  return chain.map((goal) => `${goalKindSaid(language, goal.kind)}${goal.status === 'active' ? '' : ` (${goalStatusSaid(language, goal.status)})`}: ${goal.statement}`)
    .join(' → ');
}

/* ------------------------------------------------------------ approvals --- */

/** Why a call came to the owner, in the order the broker decides it. */
export type ApprovalAsked =
  | { by: 'policy'; policies: string[] }
  | { by: 'outside'; begun: boolean }
  | { by: 'guardian'; allowedBefore: true }
  | { by: 'guardian'; allowedBefore: false; reason: string }
  | { by: 'tier' };

/** What an approval card says about why it was asked, and what a no does. */
export function approvalReasonSaid(reading: OwnerReading, facts: {
  tier: number; asked: ApprovalAsked; interrupted: boolean; chain: ReadonlyArray<Pick<Goal, 'kind' | 'status' | 'statement'>>;
  /** Why the capability's own check did not let it go on its own (STATUS 2.137). */
  checked?: { why: string; detail?: string };
}): { rationale: string; consequence: string } {
  const { language } = reading;
  const tier = number(reading, facts.tier);
  const asked = facts.asked;
  const why = asked.by === 'policy'
    ? say(language, 'This work asked for it at tier {tier}, and policy {policies} requires your approval.', { tier, policies: asked.policies.join(', ') })
    : asked.by === 'outside'
      ? asked.begun
        ? say(language, 'This work asked for it at tier {tier}, and the task began with content from outside the company.', { tier })
        : say(language, 'This work asked for it at tier {tier}, and the work read content from outside the company before asking.', { tier })
      : asked.by === 'guardian'
        ? say(language, 'This work asked for it at tier {tier}, after the work read content from outside the company, and the guardian asked you first: {reason}', {
          tier, reason: asked.allowedBefore ? say(language, 'it doubted this call before, and you allowed it once') : asked.reason,
        })
        : say(language, 'This work asked for it at tier {tier}, which cannot be reversed.', { tier });
  return {
    rationale: [
      ...(facts.interrupted
        ? [say(language, 'You approved this once already, and the worker carrying it out stopped before it could say whether it happened: it may already have happened. Check before approving it again.')]
        : []),
      why,
      ...(facts.checked ? [say(language, 'Not sent on its own: {reason}', { reason: checkedSaid(language, facts.checked) })] : []),
      ...(facts.chain.length > 0 ? [say(language, 'What this is for — {goals}', { goals: ancestrySaid(language, facts.chain) })] : []),
    ].join('\n\n'),
    consequence: say(language, 'The task halts and no external change is made.'),
  };
}

/** Why a reply to a customer did not go on its own (`chat.send`'s check), in the owner's words. */
function checkedSaid(language: string | null, checked: { why: string; detail?: string }): string {
  const detail = checked.detail ?? '';
  switch (checked.why) {
    case 'other_conversation': return say(language, 'it answers a conversation other than the one this work began with');
    case 'no_sources': return say(language, 'it named no passage of a document for customers');
    case 'not_for_customers': return say(language, 'it answers from a document not marked for customers');
    case 'figures': return say(language, 'it says a figure the documents and the customer did not: {detail}', { detail });
    case 'addresses': return say(language, 'it gives an address or link the documents and the customer did not: {detail}', { detail });
    case 'too_many': return say(language, 'there have been six answers on its own in this conversation in the last hour');
    case 'refund': return say(language, 'the check found it is about a refund');
    case 'price': return say(language, 'the check found it offers a price or terms of its own');
    case 'complaint': return say(language, 'the check found it answers a serious complaint');
    case 'legal': return say(language, 'the check found it touches the law');
    case 'personal_data': return say(language, 'the check found it gives or asks for personal data');
    case 'commitment': return say(language, 'the check found it promises something the documents do not');
    case 'check_failed': return say(language, 'the check could not judge it');
    default: return say(language, 'the check found something in it the documents do not say');
  }
}

/* --------------------------------------------------------- role changes --- */

/** The score a proposed role change earned, and what a no keeps (F17.2, F17.3). */
export function roleChangeSaid(reading: OwnerReading, facts: {
  summary: string; minimum: number;
  score: { scored: boolean; passed: number; failed: number; cases: ReadonlyArray<{ name: string; passed: boolean; detail: string }> };
}): { rationale: string; consequence: string } {
  const { language } = reading;
  const { score } = facts;
  const scored = score.scored
    ? [
      say(language, 'Scored against {total} references: {passed} passed, {failed} failed.', {
        total: number(reading, score.passed + score.failed), passed: number(reading, score.passed), failed: number(reading, score.failed),
      }),
      ...score.cases.filter((outcome) => !outcome.passed).map((outcome) => `  - ${outcome.name}: ${outcome.detail}`),
    ].join('\n')
    : say(language, 'This role has fewer than {minimum} accepted references, so the change is unscored. That is not the same as passing.',
      { minimum: number(reading, facts.minimum) });
  return {
    rationale: `${facts.summary}\n\n${scored}`,
    consequence: say(language, 'The role keeps working exactly as it does now.'),
  };
}

/* ------------------------------------------------------------ questions --- */

/** The card a run's question to the owner is put on. The question is the run's words, as it wrote them. */
export function runQuestionCard(reading: OwnerReading, facts: { role: string; question: string; why: string | null }): Card & { consequence: string } {
  const { language } = reading;
  const question = facts.question.length > 140 ? `${facts.question.slice(0, 139)}…` : facts.question;
  return {
    title: say(language, '{role} asks: {question}', { role: facts.role, question }),
    detail: facts.why || say(language, 'The run did not say more than the question.'),
    consequence: say(language, 'The task is stopped, and nothing it was going to do happens.'),
  };
}

/* --------------------------------------------------------------- skills --- */

function authorSaid(language: string | null, author: string): string {
  switch (author) {
    case 'owner': return say(language, 'You proposed it.');
    case 'bundle': return say(language, 'It came with a bundle.');
    case 'agent': return say(language, 'An agent proposed it.');
    case 'distillation': return say(language, 'It was learned from the company\'s work.');
    default: return author;
  }
}

/** A version of a skill a reviewer approved, put to the owner (F15.3). */
export function skillCard(reading: OwnerReading, facts: {
  slug: string; version: number; author: string; changelog: string; reviewerSaid: string | null;
}): Card & { consequence: string } {
  const { language } = reading;
  return {
    title: say(language, 'Skill "{skill}", version {version}', { skill: facts.slug, version: number(reading, facts.version) }),
    detail: [
      authorSaid(language, facts.author),
      facts.changelog,
      facts.reviewerSaid
        ? say(language, 'The reviewer approved it: {note}', { note: facts.reviewerSaid })
        : say(language, 'The reviewer approved it.'),
    ].filter(Boolean).join('\n\n'),
    consequence: say(language, 'Nothing changes; the current version of the skill stays in force.'),
  };
}

/**
 * The skills one bundle brought, after one review, put to the owner as one
 * question (B9): what each is for, what the reviewer said of it, and the
 * ones it turned down.
 */
export function skillsCard(reading: OwnerReading, facts: {
  bundle: string;
  skills: ReadonlyArray<{ slug: string; summary: string; reviewerSaid: string | null }>;
  refused: ReadonlyArray<{ slug: string; reason: string | null }>;
}): Card & { summary: string; consequence: string } {
  const { language } = reading;
  return {
    title: say(language, 'Skills the bundle "{bundle}" brings: {count}', { bundle: facts.bundle, count: number(reading, facts.skills.length) }),
    summary: facts.skills.map((skill) => `• ${skill.slug}: ${skill.summary}`).join('\n'),
    detail: [
      say(language, 'The reviewer read them all and approved these:'),
      ...facts.skills.map((skill) => `• ${skill.slug}: ${skill.reviewerSaid ?? say(language, 'No reason was given.')}`),
      ...(facts.refused.length > 0
        ? ['', say(language, 'It turned these down, and they stay off:'),
          ...facts.refused.map((skill) => `• ${skill.slug}: ${skill.reason ?? say(language, 'No reason was given.')}`)]
        : []),
      '',
      say(language, 'Approve to switch them all on, or deny to turn them all down. To decide one at a time, open the Skills page.'),
    ].join('\n'),
    consequence: say(language, 'Nothing changes; none of these skills is switched on.'),
  };
}
