/**
 * A goal nobody has worked on wakes the CEO (the audit of 10 October: "a
 * stock company does nothing for 24 hours ... no stage asks the CEO to look
 * at an active goal that has no measure and no work under it"; STATUS listed
 * the goal-level cadence as not done since 3 October).
 *
 * Everything else that starts work by itself starts it from a record somebody
 * made -- a schedule, a ticket, a measure, an invoice. A company whose owner
 * said what it is for and walked away had nothing to read, and the goal sat.
 * Now a goal at the end of the company's ladder with no work under it for three
 * days is put to the CEO: once a week at most for each goal, one at a time for
 * a company, never while it winds down, and only where a model can think about
 * it -- a deployment with none is told nothing would run, not sent tasks that
 * halt.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { ensureGoalReview, IDLE_DAYS, REVIEW_AGAIN_DAYS, REVIEW_EVERY_MS } from '../../src/engine/goal-review.ts';
import { Engine } from '../../src/engine/engine.ts';
import { applyGoalChange, createGoal } from '../../src/domain/goals.ts';
import { Worker } from '../../src/worker.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const DAY = 86_400_000;

/** Every goal of the company set up `days` ago. */
const goalsAged = (fixture: Fixture, days: number) => withControlPlane((tx) => tx.query(
  'UPDATE goals SET created_at = now() - make_interval(days => $2) WHERE company_id = $1', [fixture.companyId, days]));

/** A piece of work under the fixture's objective, made `days` ago, in the state given. */
async function work(fixture: Fixture, days: number, status: 'pending' | 'completed' = 'completed', goalId = fixture.goalId) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId, input: { goal: 'some work' }, createdBy: 'owner', reserveTokens: 100,
  });
  if (status === 'completed') {
    await transition(fixture.companyId, task.id, 'running');
    await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'done' } });
  }
  await withControlPlane((tx) => tx.query('UPDATE tasks SET created_at = now() - make_interval(days => $2) WHERE id = $1', [task.id, days]));
  return task.id;
}

interface Review {
  id: string; role_id: string; goal_id: string; created_by: string; status: string; idempotency_key: string;
  input: { goal: string; context: string; review: string };
}
const reviews = (fixture: Fixture) => withTenant(fixture.companyId, (tx) => tx.query<Review>(
  `SELECT id, role_id, goal_id, created_by, status, idempotency_key, input FROM tasks
    WHERE idempotency_key LIKE 'review:%' ORDER BY created_at, id`)).then((result) => result.rows);

test('a goal with no work for three days is put to the CEO once, in words the platform wrote', async () => {
  const fixture = await createCompany('review-idle');
  await goalsAged(fixture, IDLE_DAYS + 1);
  const now = new Date();
  const id = await ensureGoalReview(fixture.companyId, now);
  assert.ok(id, 'a review was made');
  const [review] = await reviews(fixture);
  // The objective is the end of the ladder: it is the one looked at, not the mission above it.
  assert.deepEqual([review!.role_id, review!.goal_id, review!.created_by, review!.status],
    [fixture.roleId, fixture.goalId, 'event', 'pending']);
  assert.match(review!.input.goal, /Goal "Keep the work moving without surprising the owner\." has had no work for 4 days/);
  assert.match(review!.input.context, /The platform made this task from the company's own records/);
  assert.match(review!.input.context, /task\.delegate/);
  assert.match(review!.input.context, /do not invent work/i);
  assert.equal(review!.input.review, fixture.goalId);

  // Asked again at once, or an hour later with it still open: nothing more.
  assert.equal(await ensureGoalReview(fixture.companyId, now), null);
  assert.equal(await ensureGoalReview(fixture.companyId, new Date(now.getTime() + REVIEW_EVERY_MS + 60_000)), null, 'one open at a time');
  assert.equal((await reviews(fixture)).length, 1);
});

test('a goal that is being worked on, or was set up a day ago, wakes nobody', async () => {
  const young = await createCompany('review-young');
  await goalsAged(young, 1);
  assert.equal(await ensureGoalReview(young.companyId), null, 'a goal set up yesterday has had no time to be worked on');

  const busy = await createCompany('review-busy');
  await goalsAged(busy, 30);
  await work(busy, 1);
  assert.equal(await ensureGoalReview(busy.companyId), null, 'work done yesterday');

  const waiting = await createCompany('review-waiting');
  await goalsAged(waiting, 30);
  await work(waiting, 10, 'pending');
  assert.equal(await ensureGoalReview(waiting.companyId), null, 'work still to do, however old');

  // Work under a goal below it counts for it: the objective is being worked on.
  const deep = await createCompany('review-deep');
  const kr = await createGoal({ companyId: deep.companyId, kind: 'key_result', slug: 'kr', statement: 'Ten cafés buy', parentGoalId: deep.goalId });
  await goalsAged(deep, 30);
  await work(deep, 1, 'completed', kr.id);
  assert.equal(await ensureGoalReview(deep.companyId), null, 'the key result below it had work yesterday');
});

test('a week after a review that left the goal idle it is looked at again, and not before', async () => {
  const fixture = await createCompany('review-again');
  await goalsAged(fixture, 30);
  const first = await ensureGoalReview(fixture.companyId);
  assert.ok(first);
  await transition(fixture.companyId, first, 'running');
  await transition(fixture.companyId, first, 'completed', { output: { summary: 'Nothing to do until the owner answers.' } });

  const aged = (days: number) => withControlPlane((tx) => tx.query(
    'UPDATE tasks SET created_at = now() - make_interval(days => $2) WHERE id = $1', [first, days]));
  await aged(REVIEW_AGAIN_DAYS - 1);
  assert.equal(await ensureGoalReview(fixture.companyId), null, 'six days after the last look');
  await aged(REVIEW_AGAIN_DAYS + 1);
  const second = await ensureGoalReview(fixture.companyId);
  assert.ok(second && second !== first, 'eight days after, looked at again');
});

test('the goals that wait longest are looked at first, one an hour, and a company that winds down is left alone', async () => {
  const fixture = await createCompany('review-order');
  const other = await createGoal({ companyId: fixture.companyId, kind: 'objective', slug: 'second', statement: 'Open a second shop.', parentGoalId: (await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"))).rows[0]!.id });
  await goalsAged(fixture, 30);
  await withControlPlane((tx) => tx.query('UPDATE goals SET created_at = now() - make_interval(days => 40) WHERE id = $1', [other.id]));
  const now = new Date();
  const first = await ensureGoalReview(fixture.companyId, now);
  assert.equal((await reviews(fixture))[0]!.goal_id, other.id, 'the one idle for forty days before the one idle for thirty');
  await transition(fixture.companyId, first!, 'running');
  await transition(fixture.companyId, first!, 'completed', { output: { summary: 'Handed on.' } });
  assert.equal(await ensureGoalReview(fixture.companyId, new Date(now.getTime() + 60_000)), null, 'not within the hour');
  await ensureGoalReview(fixture.companyId, new Date(now.getTime() + REVIEW_EVERY_MS + 60_000));
  assert.deepEqual((await reviews(fixture)).map((one) => one.goal_id), [other.id, fixture.goalId]);

  const closing = await createCompany('review-closing');
  await goalsAged(closing, 30);
  await withControlPlane((tx) => tx.query("UPDATE companies SET stage = 'wind_down' WHERE id = $1", [closing.companyId]));
  assert.equal(await ensureGoalReview(closing.companyId), null);
});

test('a worker looks at goals only where a model can think about them, and makes one task between two looks', async () => {
  const fixture = await createCompany('review-tick');
  await goalsAged(fixture, 30);
  const worker = (reviewsGoals: boolean) => new Worker({
    engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), llm: new RecordingLlmClient(), handlers: new Map() }),
    companyId: fixture.companyId, reviewsGoals,
  });
  const none = await worker(false).tick(new Date(), { runs: false });
  assert.equal(none.reviews, 0);
  assert.deepEqual(await reviews(fixture), [], 'a deployment with no model makes no task that could only halt');

  const looked = await worker(true).tick(new Date(Date.now() + DAY), { runs: false });
  assert.equal(looked.reviews, 1, JSON.stringify(looked.errors));
  assert.deepEqual(looked.errors, []);
  assert.equal((await worker(true).tick(new Date(Date.now() + DAY + 60_000), { runs: false })).reviews, 0);
  assert.equal((await reviews(fixture)).length, 1);
});

test('a goal the owner closes takes the look that has not started with it', async () => {
  const fixture = await createCompany('review-closed');
  await goalsAged(fixture, 30);
  const id = await ensureGoalReview(fixture.companyId);
  assert.ok(id);
  await applyGoalChange({ companyId: fixture.companyId, goalId: fixture.goalId, status: 'met' });
  const [review] = await reviews(fixture);
  assert.equal(review!.status, 'cancelled', 'nobody is woken about a goal that is done');
});
