/**
 * PRD v2 F5.11–F5.14 -- atomic checkout, leases, lanes and orphan recovery.
 *
 * These are what make the engine safe for more than one worker. The properties
 * are all about what two processes can believe at the same time: that they
 * both hold a task, that they both hold a resource, or that a task somebody
 * abandoned is still being worked on.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import {
  DEFAULT_LEASE_MS,
  claimTask,
  reclaimExpiredLeases,
  reclaimOrphans,
  releaseTask,
  renewLease,
} from '../../src/engine/checkout.ts';
import { createRootTask, getTask, transition } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;
async function newTask(
  fixture: Fixture,
  options: { laneKey?: string; reserveTokens?: number } = {},
) {
  sequence += 1;
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal: `claim-${sequence}` },
    createdBy: 'owner',
    reserveTokens: options.reserveTokens ?? 1_000,
    ...(options.laneKey === undefined ? {} : { laneKey: options.laneKey }),
  });
}

/** Sets the account's ceiling directly, as an owner lowering a budget would. */
async function setTokenCeiling(fixture: Fixture, tokensMax: number): Promise<void> {
  await withTenant(fixture.companyId, async (tx) => {
    await tx.query('UPDATE budget_accounts SET tokens_max = $2 WHERE id = $1', [
      fixture.budgetAccountId,
      tokensMax,
    ]);
  });
}

const WORKERS = 20;
const ITERATIONS = 60;

test('twenty workers racing for five tasks claim each exactly once (F5.11)', async () => {
  // The criterion the PRD states, at the scale a test can afford to run: the
  // property is structural -- one UPDATE over a row locked with SKIP LOCKED --
  // so the race is either impossible or fails immediately, and sixty rounds of
  // twenty workers is well past the point where a broken one would show.
  const fixture = await createCompany('claim-race', { tokensMax: 100_000_000 });

  for (let round = 0; round < ITERATIONS; round += 1) {
    const tasks = await Promise.all([
      newTask(fixture), newTask(fixture), newTask(fixture), newTask(fixture), newTask(fixture),
    ]);
    const wanted = new Set(tasks.map((task) => task.id));

    const claims = await Promise.all(
      Array.from({ length: WORKERS }, (_, i) =>
        claimTask(fixture.companyId, { holder: `worker-${i}` }),
      ),
    );

    const won = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    const ids = won.map((claim) => claim.taskId);

    assert.equal(ids.length, 5, `round ${round}: five tasks, five claims`);
    assert.equal(new Set(ids).size, 5, `round ${round}: no task was claimed twice`);
    for (const id of ids) assert.ok(wanted.has(id), `round ${round}: claimed a task from this round`);

    // Clear the board for the next round.
    for (const id of ids) await transition(fixture.companyId, id, 'cancelled');
  }
});

test('five claimable tasks and room for three produce three checkouts (F5.11)', async () => {
  // The other half of the criterion. The claim counts what is already in
  // flight, so the fourth attempt sees three reservations held and no headroom
  // for its own. A check that looked only at the account's spend would pass
  // all five and the shortfall would surface mid-run, on a task that should
  // never have started.
  const fixture = await createCompany('claim-funding', { tokensMax: 100_000 });
  for (let i = 0; i < 5; i += 1) await newTask(fixture, { reserveTokens: 1_000 });

  // Room for three of the five.
  await setTokenCeiling(fixture, 3_000);

  const claims = await Promise.all(
    Array.from({ length: WORKERS }, (_, i) =>
      claimTask(fixture.companyId, { holder: `worker-${i}` }),
    ),
  );
  const won = claims.filter((claim) => claim !== null);
  assert.equal(won.length, 3, 'exactly the number the account can pay for');
});

test('a claim writes the lease with it, not after it (F5.11, F5.12)', async () => {
  const fixture = await createCompany('claim-lease');
  const task = await newTask(fixture);

  const claim = await claimTask(fixture.companyId, { holder: 'worker-a' });
  assert.equal(claim!.taskId, task.id);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'checked_out');
  assert.equal(stored!.leaseHolder, 'worker-a');
  assert.ok(stored!.leaseExpiresAt instanceof Date);
  assert.ok(
    stored!.leaseExpiresAt.getTime() - Date.now() > DEFAULT_LEASE_MS - 5_000,
    'the lease runs for about its full length',
  );

  // And a second worker finds nothing left to take.
  assert.equal(await claimTask(fixture.companyId, { holder: 'worker-b' }), null);
});

test('an expired lease returns the task with its journal intact (F5.12)', async () => {
  // A worker that dies releases nothing, so the only reclamation that works is
  // one the dead worker is not involved in.
  const fixture = await createCompany('lease-expiry');
  const task = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'worker-a', leaseMs: 1 });

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO task_steps (company_id, task_id, step_index, name, kind, status,
                               idempotency_key, input_hash, output, committed_at)
       VALUES ($1, $2, 0, 'first', 'llm', 'committed', 'key-0', 'hash-0',
               '{"done":true}'::jsonb, now())`,
      [fixture.companyId, task.id],
    );
  });

  const reclaimed = await reclaimExpiredLeases(fixture.companyId, new Date(Date.now() + 60_000));
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.previousHolder, 'worker-a');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'pending');
  assert.equal(stored!.leaseHolder, null);

  const steps = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM task_steps WHERE task_id = $1',
      [task.id],
    );
    return Number(rows[0]!.count);
  });
  assert.equal(steps, 1, 'a lost worker is not lost work');

  // And it is claimable again.
  const second = await claimTask(fixture.companyId, { holder: 'worker-b' });
  assert.equal(second!.taskId, task.id);
});

test('only the holder may renew, and only what it still holds (F5.12)', async () => {
  // A renewal from anyone else would let a worker that has already lost the
  // task extend a claim it no longer has, which is exactly how two workers end
  // up believing they hold the same thing.
  const fixture = await createCompany('lease-renew');
  const task = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'worker-a' });

  assert.equal(await renewLease(fixture.companyId, task.id, 'worker-b'), null);
  const renewed = await renewLease(fixture.companyId, task.id, 'worker-a');
  assert.ok(renewed instanceof Date);
});

test('a released task goes back on the queue (F5.12)', async () => {
  const fixture = await createCompany('lease-release');
  const task = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'worker-a' });

  assert.equal(await releaseTask(fixture.companyId, task.id, 'worker-b'), false);
  assert.equal(await releaseTask(fixture.companyId, task.id, 'worker-a'), true);

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'pending');
});

test('one task at a time per lane (F5.13)', async () => {
  // Two tasks touching the same repository would interleave into a state
  // neither intended. The lane is how a caller says so.
  const fixture = await createCompany('lane-serial');
  const first = await newTask(fixture, { laneKey: 'repo:acme/site' });
  const second = await newTask(fixture, { laneKey: 'repo:acme/site' });
  const elsewhere = await newTask(fixture, { laneKey: 'repo:acme/docs' });

  const a = await claimTask(fixture.companyId, { holder: 'worker-a' });
  assert.equal(a!.taskId, first.id);

  // The other lane is untouched by the first lane being busy.
  const b = await claimTask(fixture.companyId, { holder: 'worker-b' });
  assert.equal(b!.taskId, elsewhere.id);

  // But nothing else in the busy lane is available.
  assert.equal(await claimTask(fixture.companyId, { holder: 'worker-c' }), null);

  // Through `running`: a task cannot go straight from claimed to finished, and
  // the state machine says so.
  await transition(fixture.companyId, first.id, 'running');
  await transition(fixture.companyId, first.id, 'completed');
  const c = await claimTask(fixture.companyId, { holder: 'worker-c' });
  assert.equal(c!.taskId, second.id, 'the lane opens when the task holding it finishes');
});

test('a task with no lane serialises against nothing', async () => {
  // Lanes are opt-in: serialising everything would cost throughput for the
  // overwhelming majority of tasks that touch nothing shared.
  const fixture = await createCompany('lane-free');
  await newTask(fixture);
  await newTask(fixture);

  const a = await claimTask(fixture.companyId, { holder: 'worker-a' });
  const b = await claimTask(fixture.companyId, { holder: 'worker-b' });
  assert.ok(a && b);
  assert.notEqual(a.taskId, b.taskId);
});

test('a finished task holds no lease and frees its lane', async () => {
  // A lease left behind blocks its lane for fifteen minutes and nothing would
  // notice, so clearing it belongs in the transition rather than at each site
  // that finishes a task.
  const fixture = await createCompany('lane-cleanup');
  const task = await newTask(fixture, { laneKey: 'domain:example.test' });
  await claimTask(fixture.companyId, { holder: 'worker-a' });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.leaseHolder, null);
  assert.equal(stored!.leaseExpiresAt, null);
});

test('a run that stops reporting is orphaned and its task returned (F5.14)', async () => {
  // The cost is recorded before the task goes back. An orphaned run spent real
  // tokens, and a retry that did not carry the abandoned spend forward would
  // let a crash loop cost the company an unbounded amount while every single
  // attempt looked affordable.
  const fixture = await createCompany('orphan');
  const task = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'worker-a' });
  await transition(fixture.companyId, task.id, 'running');

  const runId = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status,
                               tokens_used, started_at, last_heartbeat_at)
       VALUES ($1, $2, $3, 1, 'running', 4200, now() - interval '2 hours',
               now() - interval '2 hours')
       RETURNING id`,
      [fixture.companyId, task.id, fixture.roleId],
    );
    return rows[0]!.id;
  });

  const orphans = await reclaimOrphans(fixture.companyId);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0]!.agentRunId, runId);
  assert.equal(orphans[0]!.tokensUsed, 4_200, 'what it spent is on the record');

  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'pending');

  const status = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      'SELECT status FROM agent_runs WHERE id = $1',
      [runId],
    );
    return rows[0]!.status;
  });
  // Neither succeeded nor failed. Calling it "failed" would put a bad deploy's
  // restart storm into the failure rate the alerts watch.
  assert.equal(status, 'orphaned');
});

test('a run that is still reporting is left alone (F5.14)', async () => {
  const fixture = await createCompany('orphan-alive');
  const task = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'worker-a' });
  await transition(fixture.companyId, task.id, 'running');

  await withTenant(fixture.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO agent_runs (company_id, task_id, role_id, attempt, status,
                               started_at, last_heartbeat_at)
       VALUES ($1, $2, $3, 1, 'running', now() - interval '2 hours', now())`,
      [fixture.companyId, task.id, fixture.roleId],
    );
  });

  assert.deepEqual(await reclaimOrphans(fixture.companyId), []);
  const stored = await withTenant(fixture.companyId, (tx) => getTask(tx, task.id));
  assert.equal(stored!.status, 'running');
});

test('the engine claims before it runs, and says so when it cannot', async () => {
  const fixture = await createCompany('engine-claim');
  const ran: string[] = [];
  const engine = new Engine({
    broker: new CapabilityBroker(new CapabilityRegistry()),
    llm: new RecordingLlmClient(),
    workerId: 'engine-one',
    handlers: new Map([['worker', async (ctx) => {
      ran.push(ctx.task.id);
      return { done: true };
    }]]),
  });

  const task = await newTask(fixture);
  const outcome = await engine.runTask(fixture.companyId, task.id, 'worker');
  assert.equal(outcome.status, 'completed');
  assert.deepEqual(ran, [task.id]);

  // A task another worker is holding is not run, and the engine says which of
  // the three reasons it might be rather than pretending it finished.
  const held = await newTask(fixture);
  await claimTask(fixture.companyId, { holder: 'someone-else', taskId: held.id });
  const refused = await engine.runTask(fixture.companyId, held.id, 'worker');
  assert.equal(refused.status, 'not_claimed');
  assert.match(refused.reason ?? '', /another worker holds this task/);
  assert.deepEqual(ran, [task.id], 'the handler never ran');
});
