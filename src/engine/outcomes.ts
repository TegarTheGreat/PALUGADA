/**
 * The measures the owner set are looked at against their numbers, without
 * being asked (the audit of 6 October, section 8.1, limit L1: "nothing looks
 * at a measure").
 *
 * The owner gives a goal a measure: a target, a date, a source. Until now a
 * figure could pass its target, or its date, or go a month unread, and nobody
 * was woken: the weekly review read it back if the owner happened to look,
 * and a run read it only when something else had started that run. Now one
 * task is made for the CEO when a measure
 *
 *  - **reached** its target (the latest checked reading is at or past it),
 *  - is **overdue** (its due date has passed in the owner's day and the target
 *    has not been reached), or
 *  - is **stale** (it has a source and nothing was read from it in a week).
 *
 * What keeps it from becoming a meter running on nothing:
 *
 *  - **Nothing owed, nothing made.** Three small reads; no task, no event, no
 *    model call, no tokens (F9.10: dormant is the normal state). The function
 *    takes no model client at all.
 *  - **Each milestone once.** The key is made from the owner's own definition
 *    of the milestone, not from the moving figure: the target and direction
 *    for a reached measure, the date for an overdue one, the latest checked
 *    reading and the source for a stale one. A figure that hovers round its
 *    target is one look, not one per crossing, and the number of tasks a
 *    measure can ever cost is bounded by what the owner edits and by weeks
 *    that pass with a checked reading in them. The key outlives its task: a
 *    look that came to nothing is not repeated every ten minutes.
 *  - **Only a checked reading counts.** An agent's typed number is a claim, not
 *    a reading (`recordObservation`): it cannot reach a target, hide a missed
 *    date, or keep a source looking fresh.
 *  - **One every ten minutes,** most pressing first -- reached, then overdue,
 *    then stale -- so a company with a backlog of states is looked at in turn.
 *  - **The brief holds nothing an agent or a stranger wrote** (F8.9): the
 *    platform's numbers and dates, the owner's own name for the measure, and
 *    words of the platform's own. Never an observation's note, a goal's
 *    statement, a role's prompt, a ticket or a task's text.
 *  - **Not while the company winds down,** and not for a goal that is closed.
 *
 * Two workers that decide at once make one task between them: the key is
 * computed in the database, in the same statement that chooses the measure,
 * and the unique index on it does the rest.
 */
import { withTenant } from '../db/tenant.ts';
import { isPalugadaError } from '../errors.ts';
import { languageName, languagesFor } from '../domain/language.ts';
import { withoutTemplateTokens } from '../context/builder.ts';
import { createRootTask } from './tasks.ts';

/** The least time between one outcome task and the next for a company. */
export const OUTCOME_EVERY_MS = 10 * 60_000;
/** A source nobody has read for this many days is owed a look. */
export const STALE_AFTER_DAYS = 7;
/** A measure's name is a line: the owner's words, cut where they run on. */
const NAME_SHOWN = 100;
/** What a source capability's name looks like, and the most that is repeated of it. */
const SOURCE_SHAPE = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+){1,3}$/;
const SOURCE_LONGEST = 64;
/** What a role's slug looks like; the database holds them to it, and a brief repeats no other. */
const SLUG_SHAPE = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** The most roles a brief names. */
const MOST_READERS = 5;

type State = 'reached' | 'overdue' | 'stale';

interface Owed {
  id: string;
  goal_id: string;
  slug: string;
  name: string;
  unit: string;
  direction: 'up' | 'down';
  state: State;
  task_key: string;
  source_capability: string | null;
  baseline: string;
  target: string;
  due_on: string | null;
  read_value: string | null;
  read_on: string | null;
  read_days: number | null;
}

/**
 * The one measure whose milestone has no task yet, most pressing first.
 *
 * Every state is judged from the latest VERIFIED observation. The key is built
 * here, and the measures that already have a task are dropped before the
 * LIMIT, so a backlog of looked-at milestones cannot fill the list and hide a
 * later one. $1 is the clock; $2 the days of a week.
 */
const OWED = `
  WITH RECURSIVE open_goals AS (
    SELECT id FROM goals WHERE parent_goal_id IS NULL AND status = 'active'
    UNION ALL
    SELECT g.id FROM goals g JOIN open_goals o ON g.parent_goal_id = o.id WHERE g.status = 'active'
  ), owner_day AS (
    SELECT ($1::timestamptz AT TIME ZONE owner_timezone)::date AS d FROM platform_control
  ), seen AS (
    SELECT m.id, m.company_id, m.goal_id, m.slug, m.name, m.unit, m.direction, m.baseline, m.target, m.due_on,
           m.source_capability, m.created_at,
           v.id AS read_id, v.value AS read_value, v.observed_at AS read_at
      FROM goal_metrics m
      JOIN open_goals og ON og.id = m.goal_id
      LEFT JOIN LATERAL (
           SELECT o.id, o.value, o.observed_at
             FROM metric_observations o
            WHERE o.company_id = m.company_id AND o.metric_id = m.id AND o.verified
            ORDER BY o.observed_at DESC, o.id DESC LIMIT 1) v ON true
     WHERE m.retired_at IS NULL
  ), judged AS (
    SELECT s.*, CASE
        WHEN s.read_id IS NOT NULL
             AND (CASE s.direction WHEN 'up' THEN s.read_value >= s.target ELSE s.read_value <= s.target END)
          THEN 'reached'
        WHEN s.due_on < (SELECT d FROM owner_day) THEN 'overdue'
        WHEN s.source_capability IS NOT NULL
             AND coalesce(s.read_at, s.created_at) < $1::timestamptz - make_interval(days => $2::int)
          THEN 'stale'
      END AS state
      FROM seen s
  ), keyed AS (
    SELECT j.*,
           'outcome:' || left(encode(sha256(convert_to(
               j.id::text || '|' || j.state || '|' ||
               CASE j.state
                 WHEN 'reached' THEN j.direction || ':' || trim_scale(j.target)::text
                 WHEN 'overdue' THEN to_char(j.due_on, 'YYYY-MM-DD')
                 ELSE coalesce(j.read_id::text, 'none') || ':' || coalesce(j.source_capability, '')
               END, 'UTF8')), 'hex'), 24) AS task_key
      FROM judged j
     WHERE j.state IS NOT NULL
  )
  SELECT k.id, k.goal_id, k.slug, k.name, k.unit, k.direction, k.state, k.task_key, k.source_capability,
         trim_scale(k.baseline)::text AS baseline,
         trim_scale(k.target)::text AS target,
         to_char(k.due_on, 'YYYY-MM-DD') AS due_on,
         trim_scale(k.read_value)::text AS read_value,
         to_char(k.read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS read_on,
         CASE WHEN k.read_at IS NULL THEN NULL
              ELSE greatest(0, floor(extract(epoch FROM ($1::timestamptz - k.read_at)) / 86400))::int END AS read_days
    FROM keyed k
   WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.idempotency_key = k.task_key)
   ORDER BY CASE k.state WHEN 'reached' THEN 0 WHEN 'overdue' THEN 1 ELSE 2 END, k.created_at, k.id
   LIMIT 1`;

/** The id of the outcome task made, or null when none was owed, or one was made a moment ago. */
export async function ensureOutcomes(companyId: string, now = new Date()): Promise<string | null> {
  const found = await withTenant(companyId, async (tx) => {
    const { rows: ceo } = await tx.query<{ id: string; division_id: string }>(
      "SELECT id, division_id FROM roles WHERE title = 'CEO' AND frozen_at IS NULL ORDER BY created_at LIMIT 1");
    if (!ceo[0]) return null;
    const { rows: stage } = await tx.query<{ stage: string | null }>('SELECT stage FROM companies WHERE id = $1', [companyId]);
    if (stage[0]?.stage === 'wind_down') return null;

    const { rows: owed } = await tx.query<Owed>(OWED, [now, STALE_AFTER_DAYS]);
    if (!owed[0]) return null;

    // Looked at only now that something is owed, so a company with nothing
    // owed never pays for the scan.
    const { rows: recent } = await tx.query(
      `SELECT 1 FROM tasks
        WHERE idempotency_key LIKE 'outcome:%' AND created_at > $1::timestamptz - make_interval(secs => $2::float8)
        LIMIT 1`,
      [now, OUTCOME_EVERY_MS / 1000]);
    if (recent.length > 0) return null;

    const { rows: project } = await tx.query<{ id: string }>(
      'SELECT id FROM projects WHERE archived_at IS NULL ORDER BY created_at LIMIT 1');
    if (!project[0]) return null;

    // Who could read the figure again: a role that holds the source and
    // `metric.record` both, in a division granted both, because a run may call
    // only what its role lists and its division grants, and a reading is
    // checked only when the same task read it from the source.
    const source = owed[0].source_capability;
    const readers = source && sourceIsNamed(source)
      ? (await tx.query<{ slug: string; self: boolean }>(
        `SELECT r.slug, (r.id = $2::uuid) AS self
           FROM roles r
          WHERE r.frozen_at IS NULL
            AND r.tools @> ARRAY[$1::text, 'metric.record']
            AND r.slug ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
            AND (SELECT count(DISTINCT g.capability_name) FROM capability_grants g
                  WHERE g.division_id = r.division_id AND g.capability_name IN ($1::text, 'metric.record')) = 2
          ORDER BY (r.id = $2::uuid) DESC, r.slug
          LIMIT ${MOST_READERS}`,
        [source, ceo[0].id])).rows.filter((reader) => SLUG_SHAPE.test(reader.slug))
      : [];
    const language = languageName((await languagesFor(tx, companyId)).talk);
    return { ceo: ceo[0], projectId: project[0].id, owed: owed[0], readers, language };
  });
  if (!found) return null;

  const { ceo, projectId, owed, readers, language } = found;
  try {
    const task = await createRootTask({
      companyId, projectId, divisionId: ceo.division_id, roleId: ceo.id, goalId: owed.goal_id,
      createdBy: 'event', idempotencyKey: owed.task_key,
      input: { ...briefFor(owed, readers, language), metricId: owed.id, state: owed.state },
      // A look again yields to real work.
      ...(owed.state === 'stale' ? { priority: 3 } : {}),
    });
    return task.id;
  } catch (error) {
    // A frozen CEO, a paused month, a goal just closed, a budget that cannot
    // cover it: each is a reason nothing starts now, and the next look finds
    // it again.
    if (isPalugadaError(error)) return null;
    throw error;
  }
}

function sourceIsNamed(source: string): boolean {
  return source.length <= SOURCE_LONGEST && SOURCE_SHAPE.test(source);
}

/** The owner's name for a measure as one short line that cannot open a quotation or a template. */
function oneLine(name: string): string {
  return withoutTemplateTokens(name).replace(/\s+/g, ' ').replaceAll('"', "'").trim().slice(0, NAME_SHOWN).trim();
}

/**
 * What the CEO is told: platform text, the platform's numbers and the owner's
 * own name for the measure -- nothing an agent or a stranger wrote.
 */
function briefFor(owed: Owed, readers: Array<{ slug: string; self: boolean }>, language: string): { goal: string; context: string } {
  const name = oneLine(owed.name);
  const read = owed.read_value !== null;
  const days = owed.read_days ?? 0;
  const source = owed.source_capability;
  const named = source !== null && sourceIsNamed(source);

  const goal = owed.state === 'reached'
    ? `Measure "${name}" has reached its target: ask the owner what comes next.`
    : owed.state === 'overdue'
      ? `Measure "${name}" is past its due date and short of its target: find out where it stands and ask the owner.`
      : read
        ? `Measure "${name}" has not been read from its source for ${days} days: have it read again.`
        : `Measure "${name}" has not been read from its source since it was set up: have it read.`;

  const facts = `The platform made this task from the company's own records; no person or agent wrote it. `
    + `Measure "${name}" [${owed.slug}]: ${owed.direction === 'up' ? 'higher' : 'lower'} is better, `
    + `from ${owed.baseline} to ${owed.target} (${owed.unit})${owed.due_on ? `, due ${owed.due_on}` : ''}. `
    + (read
      ? `The latest checked reading is ${owed.read_value} on ${owed.read_on}, ${days} days ago. `
        + 'A reading is checked when the owner entered it or a task read it from the source.'
      : 'No reading has been checked yet.');

  // Reading it again is asked only when it can be: the source has a name, and
  // some role can read it and record it in the same task.
  let again = '';
  if (source !== null) {
    if (!named) {
      again = 'Its source is set to something that is not a capability name: tell the owner it needs correcting.';
    } else if (readers[0]?.self) {
      again = `You hold ${source} and metric.record yourself: read the figure with ${source} and record it with `
        + `metric.record for ${owed.slug} in this run.`;
    } else if (readers.length > 0) {
      again = `Have it read again: hand it to ${readers.map((reader) => reader.slug).join(', ')} with task.delegate, `
        + `saying it must read the figure with ${source} and then record it with metric.record for ${owed.slug} `
        + 'in that same task (that is what makes it a checked reading), and wait for it with task.await.';
    } else {
      again = `No role of this company holds both ${source} and metric.record, so it cannot be read again: say so `
        + `${owed.state === 'stale' ? 'in your summary' : 'to the owner'}.`;
    }
  }

  let state: string;
  if (owed.state === 'reached') {
    state = 'The latest checked reading is at or past the target. Ask the owner once, with owner.ask, whether the goal is done: '
      + 'give the figure and its date, and offer "Close the goal", "Raise the target" and "Carry on". '
      + "Their answer is for your report: closing the goal or raising the target is the owner's, on the Goals page, "
      + 'and you cannot do either.';
  } else if (owed.state === 'overdue') {
    const unread = !read || days > STALE_AFTER_DAYS;
    state = 'The due date has passed and the target has not been reached. '
      + (unread && again ? `${again} ` : '')
      + 'Ask the owner once, with owner.ask, where it stands: give the figure and its date, or say there is none, '
      + 'and offer "Move the date", "Change the target" and "Carry on". '
      + 'If something already done will only show in the figure later, ask to look again with task.follow_up '
      + '(the role, what to check, how long to wait) rather than asking the owner to wait.'
      + (source === null ? ' It has no source: the owner enters its figure.' : '');
  } else {
    state = (read
      ? `Nothing has been read from its source for ${days} days. `
      : 'Nothing has been read from its source since it was set up. ')
      + (again ? `${again} ` : '')
      + 'Do not ask the owner unless the figure cannot be read or what it shows calls for a decision.';
  }

  const limits = 'You cannot close or change a goal or a measure; only the owner can. '
    + 'Do not record a figure you did not read from its source in this run, and do not start new work to move the number. '
    + `Ask the owner at most once, and write it in ${language}. `
    + 'This is how things stood when the task was made: your context shows the measure now, '
    + 'so if it no longer matches, say so in your summary and stop.';

  return { goal, context: [facts, state, limits].join('\n\n') };
}
