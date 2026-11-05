/**
 * The vision and plan page (F18.10, with F18.11's panel; STATUS 2.197).
 *
 * The company had each part of an operating plan in its own place: the
 * charter on Team, the goals on their ladder, the scorecard in its tab, the
 * issues on the board, the meeting under Work. Nothing put them on one page,
 * and nothing said which of the charter's paragraphs were the vision. Now
 * GET /plan assembles them from the rows: the charter's vision sections, found
 * by the outline's headings in the company's languages (or the whole charter
 * when it has none), this year's goals, this quarter's priorities on or off
 * pace by the weekly meeting's own rule, the scorecard's last week, the
 * headline, the long-term issues, the channels by ring, the core processes
 * and the last weekly operating meeting.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { openTicket } from '../../src/engine/tickets.ts';
import { createGoal } from '../../src/domain/goals.ts';
import { fiscalQuarterOf } from '../../src/domain/fiscal.ts';
import { chooseHeadline, defineMetric } from '../../src/domain/metrics.ts';
import { setCompanyLanguages } from '../../src/domain/language.ts';
import { publishCharter } from '../../src/governance/store.ts';
import { OWNER_SENTENCES } from '../../src/owner/say.ts';
import { VISION_PARTS, visionHeading } from '../../src/owner/vision.ts';
import { STAFF_READS } from '../../src/owner/staff-policy.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Jakarta keeps UTC+7 all year, so a local day is easy to name. */
const JAKARTA = 7 * HOUR;
const today = () => new Date(Date.now() + JAKARTA).toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

async function inJakarta(fixture: Fixture): Promise<void> {
  await withControlPlane((tx) => tx.query("UPDATE companies SET timezone = 'Asia/Jakarta' WHERE id = $1", [fixture.companyId]));
}

async function missionOf(fixture: Fixture): Promise<string> {
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"));
  return rows[0]!.id;
}

async function readingAt(fixture: Fixture, metricId: string, value: number, at: Date): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO metric_observations (company_id, metric_id, value, observed_at, verified, recorded_by)
     VALUES ($1, $2, $3, $4, true, 'owner')`,
    [fixture.companyId, metricId, value, at]));
}

/** A root task of the fixture's role, finished with a summary. */
async function finishedTask(fixture: Fixture, input: Record<string, unknown>, summary: string, idempotencyKey?: string): Promise<string> {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input, createdBy: 'owner', reserveTokens: 100,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed', { output: { summary } });
  return task.id;
}

/** A document a task wrote with doc.draft, as the journal keeps it. */
async function drafted(fixture: Fixture, taskId: string, text: string, at: Date): Promise<void> {
  await withControlPlane((tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1, 0, $2, 'capability:doc.draft', 'tool', 'committed', 'hash', $3, $4, $5)`,
    [taskId, fixture.companyId, `${taskId}:0`, { path: `draft-${taskId.slice(0, 8)}.md`, text, words: 20, model: 'draft-model' }, at]));
}

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A viewer seat of the company, joined as staff.test.ts joins one; its session token. */
async function seat(api: Console, owner: string, companyId: string, name: string): Promise<string> {
  const made = await api.call('POST', `/api/companies/${companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const totp = totpCode(decodeBase32(String(opened.body.secret)), stepFor(new Date()));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: made.body.invite, offer: opened.body.offer, totp });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return String(joined.body.token);
}

interface Grade {
  goalId: string; periodStartsOn: string; periodDueOn: string; commitment: string | null;
  score: number; basis: string; predicted: number | null; actual: number | null; note: string | null; passed: boolean | null;
}

interface Plan {
  day: string;
  timezone: string;
  vision: { charterVersion: number | null; sections: Array<{ part: string; heading: string; text: string }>; whole: string | null };
  yearGoals: Array<{ id: string; slug: string; status: string; seat: { id: string } | null; priorities: number; metrics: unknown[]; grade: Grade | null }>;
  priorities: {
    items: Array<{ goalId: string; goal: string; pace: string; why: string | null; progress: number | null; seatRole: { id: string } | null; channel: string | null; grade: Grade | null }>;
    leftOut: number;
  };
  scorecard: {
    lines: Array<{ metricId: string; name: string; lastWeek: string; thisWeek: string }>;
    lastWeek: Record<string, number>;
    warning: { kind: string } | null;
  };
  headline: { metricId: string; chosen: boolean } | null;
  longTermIssues: { items: Array<{ id: string; title: string; priority: number }>; leftOut: number };
  channels: {
    possible: { taskId: string; title: string; excerpt: string } | null;
    probable: Array<{ channel: string; goals: Array<{ id: string; commitment: string | null }> }>;
    working: Array<{ channel: string; goals: Array<{ id: string; commitment: string | null }> }>;
  };
  coreProcesses: { windowDays: number; processes: unknown[] };
  grades: {
    quarter: string; from: string; to: string;
    numbers: {
      priorities: { total: number; done: number; share: number | null; aim: number };
      committed: { graded: number; passed: number; passRate: number | null };
      aspirational: { graded: number; average: number | null; expected: [number, number]; reading: string | null };
      todos: { total: number; withinWeek: number; share: number | null };
    };
  };
  lastMeeting: {
    taskId: string; week: string; status: string; finishedAt: string | null;
    record: { taskId: string; week: string; finishedAt: string; summary: string | null } | null;
  } | null;
}

test('the plan page assembles the vision, the year, the quarter on pace, the scorecard, the headline, the issues, the channels and the last meeting', async () => {
  const fixture = await createCompany('plan-page');
  await inJakarta(fixture);
  const mission = await missionOf(fixture);
  const owner = await consoleWithSettings();
  try {
    const token = await owner.signIn();
    const plan = async (): Promise<Plan> => {
      const answer = await owner.call('GET', `/api/companies/${fixture.companyId}/plan`, token);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as Plan;
    };

    // An empty company has a plan with nothing in it, said as nothing.
    const empty = await plan();
    assert.equal(empty.day, today());
    assert.equal(empty.timezone, 'Asia/Jakarta');
    assert.deepEqual(empty.vision, { charterVersion: null, sections: [], whole: null });
    assert.deepEqual([empty.yearGoals, empty.priorities.items, empty.scorecard.lines, empty.longTermIssues.items], [[], [], [], []]);
    assert.deepEqual(empty.channels, { possible: null, probable: [], working: [] });
    assert.equal(empty.lastMeeting, null);
    assert.equal(empty.coreProcesses.windowDays, 30);

    // The charter with the outline filled in, and a paragraph outside it.
    await publishCharter({
      companyId: fixture.companyId,
      body: [
        'Kopi Kita roasts coffee for cafés.', '',
        '## Our values', '- We answer every customer the same day.', '- We say what we do not know.', '',
        '## Purpose and niche', 'Fresh beans for small cafés in Jakarta.', '',
        '### Not our niche', 'Supermarkets.', '',
        '## How we work', 'Nothing here is part of the vision.', '',
        '## Where we will be in three years:', 'Three hundred cafés buy from us every month.', '',
        '## Our promise', '',
      ].join('\n'),
    });

    // This year's goal, and three priorities this quarter under it.
    const year = await createGoal({
      companyId: fixture.companyId, kind: 'objective', slug: 'year', statement: 'Cafés across Jakarta buy from us.',
      parentGoalId: mission, startsOn: shift(-100), dueOn: shift(264), ownerRoleId: fixture.roleId, commitment: 'committed',
    });
    // An objective with a longer period is not this year's.
    await createGoal({
      companyId: fixture.companyId, kind: 'objective', slug: 'someday', statement: 'Every city.',
      parentGoalId: mission, startsOn: shift(-100), dueOn: shift(900),
    });
    const quarter = { parentGoalId: year.id, startsOn: shift(-45), dueOn: shift(44), ownerRoleId: fixture.roleId };
    const behind = await createGoal({
      companyId: fixture.companyId, kind: 'key_result', slug: 'cafes', statement: 'Ten cafés buy.', ...quarter,
      commitment: 'committed', doneWhen: 'Ten cafés have paid.', channel: 'sales',
    });
    const cafes = await defineMetric(fixture.companyId, { goalId: behind.id, slug: 'cafes-buying', name: 'Cafés buying', unit: 'count', baseline: 0, target: 10 });
    await readingAt(fixture, cafes, 2, new Date(Date.now() - HOUR));
    const content = await createGoal({
      companyId: fixture.companyId, kind: 'key_result', slug: 'content-test', statement: 'Learn what one café costs through a blog.', ...quarter,
      commitment: 'learning', doneWhen: 'The test has spent its money.', channel: 'content_marketing',
    });
    const salesTest = await createGoal({
      companyId: fixture.companyId, kind: 'key_result', slug: 'sales-test', statement: 'Learn what one café costs by calling.', ...quarter,
      commitment: 'learning', doneWhen: 'Fifty calls are made.', channel: 'sales',
    });
    const worked = await finishedTask(fixture, { goal: 'write the first post' }, 'Posted.');
    await withControlPlane((tx) => tx.query('UPDATE tasks SET goal_id = $2 WHERE id = $1', [worked, content.id]));
    // An abandoned test is in no ring.
    const dropped = await createGoal({
      companyId: fixture.companyId, kind: 'key_result', slug: 'press', statement: 'Learn whether a newspaper brings cafés.', ...quarter,
      commitment: 'learning', doneWhen: 'One article runs.', channel: 'publicity',
    });
    await withControlPlane((tx) => tx.query("UPDATE goals SET status = 'abandoned' WHERE id = $1", [dropped.id]));

    // The weekly scorecard: one line on track last week, one never reported.
    const calls = await defineMetric(fixture.companyId, { goalId: year.id, slug: 'calls', name: 'Calls made', unit: 'count', target: 50, reviewEvery: 'week', ownerRoleId: fixture.roleId });
    await defineMetric(fixture.companyId, { goalId: year.id, slug: 'visits', name: 'Cafés visited', unit: 'count', target: 5, reviewEvery: 'week' });
    await readingAt(fixture, calls, 60, new Date(Date.now() - 7 * DAY));
    await chooseHeadline(fixture.companyId, cafes);

    // Issues: the long-term list only, by priority.
    for (const [title, horizon, priority] of [['Fix the roaster', 'now', 0], ['Open a second shop someday', 'long_term', 2], ['A warehouse of our own', 'long_term', 1]] as const) {
      await withTenant(fixture.companyId, (tx) => openTicket(tx, {
        companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, kind: 'issue',
        title, horizon, priority, openedBy: 'owner', outside: false,
      }));
    }

    // Two meetings; the later week is the last one.
    await finishedTask(fixture, { goal: 'Weekly operating meeting' }, 'The first meeting.', 'meeting:2026-W40');
    const meeting = await finishedTask(fixture, { goal: 'Weekly operating meeting' }, 'What the owner needs to know: calls are on track.', 'meeting:2026-W41');

    const full = await plan();

    assert.equal(full.vision.charterVersion, 1);
    assert.equal(full.vision.whole, null, 'the outline was found, so the whole charter is not repeated');
    assert.deepEqual(full.vision.sections.map((one) => [one.part, one.text]), [
      ['values', '- We answer every customer the same day.\n- We say what we do not know.'],
      ['purpose_and_niche', 'Fresh beans for small cafés in Jakarta.\n\n### Not our niche\nSupermarkets.'],
      ['three_years', 'Three hundred cafés buy from us every month.'],
      ['promise', ''],
    ], 'each section in the charter\'s order, up to the next heading of its level, with "How we work" left out');
    assert.equal(full.vision.sections[2]!.heading, 'Where we will be in three years:', 'the heading as the owner wrote it');

    assert.deepEqual(full.yearGoals.map((one) => [one.slug, one.seat?.id, one.priorities, one.grade]), [['year', fixture.roleId, 3, null]]);

    const pace = Object.fromEntries(full.priorities.items.map((one) => [one.goal, [one.pace, one.why, one.seatRole?.id, one.channel]]));
    assert.deepEqual(pace, {
      cafes: ['off_pace', 'behind', fixture.roleId, 'sales'],
      'content-test': ['on_pace', null, fixture.roleId, 'content_marketing'],
      'sales-test': ['off_pace', 'no_recent_work', fixture.roleId, 'sales'],
    }, 'the weekly meeting\'s rule: measured against the quarter gone, unmeasured by work finished this week');
    assert.equal(full.priorities.items.find((one) => one.goal === 'cafes')!.progress, 0.2);
    assert.ok(full.priorities.items.every((one) => one.grade === null), 'nothing is graded yet');

    assert.deepEqual(full.scorecard.lines.map((one) => [one.name, one.lastWeek, one.thisWeek]), [
      ['Calls made', 'on_track', 'not_reported'],
      ['Cafés visited', 'not_reported', 'not_reported'],
    ]);
    assert.deepEqual(full.scorecard.lastWeek, { on_track: 1, off_track: 0, claimed: 0, not_reported: 1 });
    assert.equal(full.scorecard.warning?.kind, 'too_few');

    assert.deepEqual([full.headline?.metricId, full.headline?.chosen], [cafes, true]);

    assert.deepEqual(full.longTermIssues.items.map((one) => one.title), ['A warehouse of our own', 'Open a second shop someday']);
    assert.equal(full.longTermIssues.leftOut, 0);

    // Probable: a learning test with a channel. Working: a committed priority with one,
    // which takes the channel out of probable, with its test beside it.
    assert.equal(full.channels.possible, null, 'no brainstorm was written, so the outer ring is left out');
    assert.deepEqual(full.channels.probable.map((ring) => [ring.channel, ring.goals.map((one) => one.id)]), [['content_marketing', [content.id]]]);
    assert.deepEqual(full.channels.working.map((ring) => [ring.channel, ring.goals.map((one) => [one.id, one.commitment])]), [
      ['sales', [[behind.id, 'committed'], [salesTest.id, 'learning']]],
    ]);

    assert.deepEqual([full.lastMeeting?.taskId, full.lastMeeting?.week, full.lastMeeting?.status, full.lastMeeting?.record?.taskId, full.lastMeeting?.record?.summary],
      [meeting, '2026-W41', 'completed', meeting, 'What the owner needs to know: calls are on track.']);

    // The possible ring is the document a run following channel testing wrote,
    // not a later draft of work that never read it.
    const brainstorm = await finishedTask(fixture, { goal: 'List a strategy for every channel' }, 'Listed.');
    await withTenant(fixture.companyId, (tx) => tx.query(
      `INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
       VALUES ($1, $2, $3, 'skill.read', 'agent_run', '{"slug":"channel-testing","version":1}')`,
      [fixture.companyId, fixture.projectId, brainstorm]));
    // Written in the work language, so it is known by its shape, a line for
    // each of the nineteen, and not by the channels' English names.
    const everyChannel = ['# Semua kanal', '', ...Array.from({ length: 19 }, (_, index) => `${index + 1}. Strategi kanal ${index + 1} untuk kafe di Jakarta.`)].join('\n');
    await drafted(fixture, brainstorm, everyChannel, new Date(Date.now() - 2 * HOUR));
    const memo = await finishedTask(fixture, { goal: 'Write a memo' }, 'Written.');
    await drafted(fixture, memo, '# A memo\n\nNothing about channels.', new Date());
    // A later run that opened the skill to judge a test writes its report:
    // that is a document of the procedure, not the list of every channel.
    const review = await finishedTask(fixture, { goal: 'Judge the content test' }, 'Judged.');
    await withTenant(fixture.companyId, (tx) => tx.query(
      `INSERT INTO events (company_id, project_id, task_id, type, actor, payload)
       VALUES ($1, $2, $3, 'skill.read', 'agent_run', '{"slug":"channel-testing","version":1}')`,
      [fixture.companyId, fixture.projectId, review]));
    await drafted(fixture, review, '# Content test result\n\n- Predicted: US$40 a café.\n- Result: US$55 a café (confirmed).\n- Spent: US$110 of US$120.', new Date(Date.now() - HOUR));
    const possible = (await plan()).channels.possible;
    assert.equal(possible?.taskId, brainstorm, 'the list of every channel, not the newer report of one test');
    assert.equal(possible?.title, 'Semua kanal');
    assert.ok(possible?.excerpt.startsWith('1. Strategi kanal 1 untuk kafe di Jakarta.'), possible?.excerpt);

    // A meeting that has not finished is the last one, and the record shown
    // beside it is the last meeting that finished.
    const pending = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Weekly operating meeting' }, createdBy: 'owner',
      reserveTokens: 100, idempotencyKey: 'meeting:2026-W42',
    });
    const latest = (await plan()).lastMeeting;
    assert.deepEqual([latest?.taskId, latest?.week, latest?.status, latest?.finishedAt], [pending.id, '2026-W42', 'pending', null]);
    assert.deepEqual([latest?.record?.taskId, latest?.record?.week, latest?.record?.summary],
      [meeting, '2026-W41', 'What the owner needs to know: calls are on track.']);

    // Staff seats read it, as every other page of the company, and only their own company's.
    assert.ok(STAFF_READS.includes('/api/companies/:companyId/plan'));
    const viewer = await seat(owner, token, fixture.companyId, 'Rina');
    const asStaff = await owner.call('GET', `/api/companies/${fixture.companyId}/plan`, viewer);
    assert.equal(asStaff.status, 200, JSON.stringify(asStaff.body));
    assert.equal((asStaff.body as Plan).channels.possible?.taskId, brainstorm);
    const other = await createCompany('plan-page-other');
    assert.notEqual((await owner.call('GET', `/api/companies/${other.companyId}/plan`, viewer)).status, 200);
  } finally {
    await owner.close();
  }
});

test('a graded goal and a graded priority carry their latest grade on the plan, beside the fiscal quarter\'s numbers', async () => {
  const fixture = await createCompany('plan-grades');
  await inJakarta(fixture);
  const mission = await missionOf(fixture);
  const quarter = fiscalQuarterOf(today(), 1);
  const owner = await consoleWithSettings();
  try {
    const token = await owner.signIn();
    const plan = async (): Promise<Plan> => {
      const answer = await owner.call('GET', `/api/companies/${fixture.companyId}/plan`, token);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as Plan;
    };

    // Nothing graded: the quarter is named and its numbers are empty, said as none.
    const empty = await plan();
    assert.deepEqual([empty.grades.quarter, empty.grades.from, empty.grades.to], [quarter.label, quarter.startsOn, quarter.endsOn]);
    assert.deepEqual(empty.grades.numbers, {
      priorities: { total: 0, done: 0, share: null, aim: 0.8 },
      committed: { graded: 0, passed: 0, passRate: null },
      aspirational: { graded: 0, average: null, expected: [0.6, 0.7], reading: null },
      todos: { total: 0, withinWeek: 0, share: null },
    });

    const year = await createGoal({
      companyId: fixture.companyId, kind: 'objective', slug: 'year', statement: 'Cafés across Jakarta buy from us.',
      parentGoalId: mission, startsOn: shift(-100), dueOn: shift(264), commitment: 'aspirational',
    });
    // Three priorities whose period is this fiscal quarter.
    const priority = (slug: string, commitment: 'committed' | 'aspirational') => createGoal({
      companyId: fixture.companyId, kind: 'key_result', slug, statement: `Priority ${slug}.`, parentGoalId: year.id,
      startsOn: quarter.startsOn, dueOn: quarter.endsOn, commitment, ownerRoleId: fixture.roleId,
      doneWhen: `${slug} is done.`,
    });
    const landed = await priority('landed', 'committed');
    const stretch = await priority('stretch', 'aspirational');
    const open = await priority('open', 'committed');

    // Grades are the platform's to write; here they are written as it writes them.
    const grade = (goalId: string, starts: string, due: string, commitment: string, score: number, basis: string, note: string | null = null) =>
      withControlPlane((tx) => tx.query(
        `INSERT INTO goal_grades (company_id, goal_id, period_starts_on, period_due_on, commitment, score, basis, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fixture.companyId, goalId, starts, due, commitment, score, basis, note]));
    // The year's goal has two earlier periods' grades; the plan shows the later one.
    await grade(year.id, shift(-830), shift(-466), 'aspirational', 0.2, 'measured');
    await grade(year.id, shift(-465), shift(-101), 'aspirational', 0.5, 'measured', 'from_key_results');
    await grade(landed.id, quarter.startsOn, quarter.endsOn, 'committed', 1, 'measured');
    await grade(stretch.id, quarter.startsOn, quarter.endsOn, 'aspirational', 0.65, 'measured');

    // Two to-dos filed today, finished today and dropped today: one kept its week.
    for (const [title, status] of [['Call the roaster', 'done'], ['Book the fair', 'closed']] as const) {
      const { ticket } = await withTenant(fixture.companyId, (tx) => openTicket(tx, {
        companyId: fixture.companyId, projectId: fixture.projectId, divisionId: null, title, dueOn: quarter.endsOn, openedBy: 'owner', outside: false,
      }));
      await withControlPlane((tx) => tx.query("UPDATE tickets SET status = $2, closed_at = now() WHERE id = $1", [ticket.id, status]));
    }

    const graded = await plan();
    const [goal] = graded.yearGoals;
    assert.deepEqual(goal?.grade, {
      goalId: year.id, periodStartsOn: shift(-465), periodDueOn: shift(-101), commitment: 'aspirational',
      score: 0.5, basis: 'measured', predicted: null, actual: null, note: 'from_key_results', passed: null,
    }, 'this year\'s goal carries its latest grade');
    const of = Object.fromEntries(graded.priorities.items.map((one) => [one.goalId, one.grade && [one.grade.score, one.grade.passed]]));
    assert.deepEqual(of, { [landed.id]: [1, true], [stretch.id]: [0.65, null], [open.id]: null }, 'each priority its own grade, and none before one');

    assert.deepEqual(graded.grades.numbers, {
      priorities: { total: 3, done: 1, share: 0.33, aim: 0.8 },
      committed: { graded: 1, passed: 1, passRate: 1 },
      aspirational: { graded: 1, average: 0.65, expected: [0.6, 0.7], reading: 'expected' },
      todos: { total: 2, withinWeek: 1, share: 0.5 },
    }, 'the quarter\'s numbers, as quarterly planning is handed them; the year\'s earlier periods are outside it');

    // The quarter is the company's fiscal one: moved with the month its year starts in.
    await withControlPlane((tx) => tx.query('UPDATE companies SET fiscal_year_start_month = 2 WHERE id = $1', [fixture.companyId]));
    const moved = fiscalQuarterOf(today(), 2);
    const refiscal = await plan();
    assert.deepEqual([refiscal.grades.quarter, refiscal.grades.from, refiscal.grades.to], [moved.label, moved.startsOn, moved.endsOn]);
  } finally {
    await owner.close();
  }
});

test('the vision is found by the outline\'s headings in the company\'s languages, and is the whole charter without them', async () => {
  const fixture = await createCompany('plan-vision');
  const owner = await consoleWithSettings();
  try {
    const token = await owner.signIn();
    const vision = async () => {
      const answer = await owner.call('GET', `/api/companies/${fixture.companyId}/plan`, token);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return (answer.body as Plan).vision;
    };

    // In Indonesian, for a company that talks Indonesian, whatever the case the owner wrote it in.
    await setCompanyLanguages(fixture.companyId, { work: null, talk: 'id' });
    await publishCharter({
      companyId: fixture.companyId,
      body: `# ${visionHeading('id', 'values').toUpperCase()}\nJujur.\n\n# ${visionHeading('id', 'long_range_target')}\nSeribu kafe.\n`,
    });
    assert.deepEqual((await vision()).sections.map((one) => [one.part, one.text]), [['values', 'Jujur.'], ['long_range_target', 'Seribu kafe.']]);

    // In Turkish, typed in capitals: the dotted capital I lowercases to an i
    // with a combining dot, which is still the same letter.
    await setCompanyLanguages(fixture.companyId, { work: null, talk: 'tr' });
    await publishCharter({
      companyId: fixture.companyId,
      body: `## ${visionHeading('tr', 'values').toLocaleUpperCase('tr')}\nDürüstlük.\n`,
    });
    assert.deepEqual((await vision()).sections.map((one) => [one.part, one.text]), [['values', 'Dürüstlük.']]);

    // A language the company does not use is not read: a heading there is just a heading.
    await setCompanyLanguages(fixture.companyId, { work: null, talk: null });
    const japanese = `## ${visionHeading('ja', 'promise')}\n約束。`;
    await publishCharter({ companyId: fixture.companyId, body: japanese });
    assert.deepEqual(await vision(), { charterVersion: 3, sections: [], whole: japanese });

    // A heading inside a fenced block is not a heading.
    const fenced = 'Before.\n\n```\n## Our values\n```\n';
    await publishCharter({ companyId: fixture.companyId, body: fenced });
    assert.deepEqual(await vision(), { charterVersion: 4, sections: [], whole: fenced });
  } finally {
    await owner.close();
  }
});

test('the console\'s vision outline writes the headings the server reads, in every language', async () => {
  const source = await readFile(new URL('../../console/src/vision.ts', import.meta.url), 'utf8');
  const written = [...source.matchAll(/part: '(\w+)', heading: N\('((?:[^'\\]|\\.)*)'\)/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(written, VISION_PARTS.map((part) => [part, visionHeading('en', part)]),
    'the console writes the server\'s parts, in its order, with its English');
  const locales = (await readdir(new URL('../../console/src/locales/', import.meta.url)))
    .filter((name) => name.endsWith('.ts') && name !== 'types.ts').map((name) => name.replace(/\.ts$/, ''));
  assert.equal(locales.length, Object.keys(OWNER_SENTENCES).length);
  for (const language of locales) {
    const { DICTIONARY } = await import(`../../console/src/locales/${language}.ts`) as { DICTIONARY: Record<string, unknown> };
    for (const part of VISION_PARTS) {
      const english = visionHeading('en', part);
      assert.equal(DICTIONARY[english], visionHeading(language, part),
        `${language}: the console writes "${String(DICTIONARY[english])}" for "${english}", and the server reads "${visionHeading(language, part)}"`);
    }
  }
});

test('the console\'s outline adds only the parts the charter has no heading for, in any language', async () => {
  // By its address rather than a literal path: the console's i18n is written
  // for the browser, and a literal import would bring it into the server's
  // type check, which has no DOM.
  type Part = { part: string; heading: string };
  const { missingParts, outlineText } = await import(new URL('../../console/src/vision.ts', import.meta.url).href) as {
    missingParts: (charter: string) => Part[]; outlineText: (parts: readonly Part[]) => string;
  };
  const parts = (charter: string) => missingParts(charter).map((one) => one.part);

  assert.deepEqual(parts(''), [...VISION_PARTS]);
  // Two written by hand, in the owner's own typing: the other four are missing.
  const some = 'Kopi Kita.\n\n## our values\n- Honest.\n\n### OUR PROMISE:\nFresh beans.\n';
  assert.deepEqual(parts(some), ['purpose_and_niche', 'long_range_target', 'who_we_serve', 'three_years']);
  assert.equal(outlineText(missingParts(some)),
    ['Purpose and niche', 'Long-range target', 'Who we serve and what makes us different', 'Where we will be in three years']
      .map((heading) => `## ${heading}\n\n`).join(''), 'only the missing headings are written');

  // Filled in while the console was in Indonesian, read while it is in English: nothing is missing.
  const indonesian = VISION_PARTS.map((part) => `## ${visionHeading('id', part)}\nIsi.\n`).join('\n');
  assert.deepEqual(parts(indonesian), []);
  // Turkish typed in capitals, as the server reads it.
  assert.deepEqual(parts(`## ${visionHeading('tr', 'values').toLocaleUpperCase('tr')}\n`).includes('values'), false);
  // A heading quoted in a fenced block is not one, as the server reads it.
  assert.deepEqual(parts('```\n## Our values\n```\n').includes('values'), true);
});

test('the plan page\'s empty lines name a goal\'s kinds by each dictionary\'s own words, not in English', async () => {
  const locales = (await readdir(new URL('../../console/src/locales/', import.meta.url)))
    .filter((name) => name.endsWith('.ts') && name !== 'types.ts').map((name) => name.replace(/\.ts$/, ''));
  for (const language of locales) {
    const { DICTIONARY } = await import(`../../console/src/locales/${language}.ts`) as { DICTIONARY: Record<string, string> };
    for (const sentence of [
      'No goal for this year yet: an objective whose period is about a year, with today in it.',
      'No quarterly priority yet: a key result whose period is a quarter, with today in it.',
    ]) {
      assert.doesNotMatch(DICTIONARY[sentence]!, /objective|key result/i, `${language}: "${DICTIONARY[sentence]}" keeps the English term`);
    }
  }
});
