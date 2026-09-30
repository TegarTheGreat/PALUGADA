/**
 * The keeper of a run's lease, on its own (PRD v2 F5.12).
 *
 * It treated a lost lease as the only renewal that mattered. Any other failure
 * -- a connection dropped, a pool with nothing left to lend -- was left to the
 * next tick, for ever, and a renewal that never answered left every later
 * tick returning at once because one was still in flight. A worker cut off
 * from its database therefore went on running the task while the lease
 * lapsed in the database and another worker took it: two workers, the same
 * side effects. The lease has a deadline on this side too now, and these
 * hold it without a database, with a lease short enough to watch lapse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseKeeper } from '../../src/engine/lease-keeper.ts';
import { PalugadaError, isPalugadaError } from '../../src/errors.ts';

const LEASE_MS = 240;
/** The keeper renews three times a lease. */
const TICK_MS = LEASE_MS / 3;
/** What a busy machine may add to a timer; generous, because the claim is "soon", not "never". */
const SLACK_MS = 400;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms}ms`);
    await sleep(5);
  }
}

function refusesAsLost(pattern: RegExp) {
  return (error: unknown) => isPalugadaError(error, 'task.lease_lost') && pattern.test(error.message);
}

test('a keeper whose renewals keep failing gives the run up once a whole lease has passed without one', async () => {
  let asked = 0;
  let lostAt: number | null = null;
  let told = 0;
  const started = Date.now();
  const keeper = new LeaseKeeper({
    renew: async () => {
      asked += 1;
      throw new Error('Connection terminated unexpectedly');
    },
    onLost: () => {
      told += 1;
      lostAt = Date.now();
    },
    leaseMs: LEASE_MS,
    coverUntil: Date.now() + 60_000,
  });
  keeper.start();
  try {
    await until(() => lostAt !== null, 'the keeper giving the run up');
    const after = lostAt! - started;
    assert.ok(after >= LEASE_MS, `not before a whole lease had passed: ${after}ms`);
    assert.ok(after <= LEASE_MS + TICK_MS + SLACK_MS, `within a tick of the lease running out: ${after}ms`);
    assert.ok(asked >= 1, 'it kept trying until then');
    assert.equal(keeper.lost, true);

    await assert.rejects(keeper.confirm(),
      refusesAsLost(/no renewal of the lease succeeded for 240 ms, a whole lease: it may have lapsed, and another worker may hold the task/));
    const tries = asked;
    await sleep(2 * TICK_MS);
    assert.equal(asked, tries, 'nothing is renewed once the run is given up, by the timer or by a step');
    assert.equal(told, 1, 'the run is told once');
  } finally {
    keeper.stop();
  }
});

test('a renewal that never answers does not keep the run covered', async () => {
  // A database that stopped answering, or a pool with no connection to lend:
  // the renewal neither succeeds nor fails, and every tick after it used to
  // return at once because one was in flight.
  let asked = 0;
  let lostAt: number | null = null;
  const started = Date.now();
  const keeper = new LeaseKeeper({
    renew: () => {
      asked += 1;
      return new Promise<void>(() => undefined);
    },
    onLost: () => { lostAt = Date.now(); },
    leaseMs: LEASE_MS,
    coverUntil: Date.now() + 60_000,
  });
  keeper.start();
  try {
    await until(() => lostAt !== null, 'the keeper giving the run up');
    const after = lostAt! - started;
    assert.ok(after >= LEASE_MS && after <= LEASE_MS + TICK_MS + SLACK_MS, `within a tick of the lease running out: ${after}ms`);
    assert.equal(asked, 1, 'the one renewal that hung was the only one asked for');
    await assert.rejects(keeper.confirm(), refusesAsLost(/no renewal of the lease succeeded/));
  } finally {
    keeper.stop();
  }
});

test('a renewal that fails once is only a blink: the next one keeps the run', async () => {
  let asked = 0;
  let told = 0;
  const keeper = new LeaseKeeper({
    renew: async () => {
      asked += 1;
      if (asked === 1) throw new Error('Connection terminated unexpectedly');
    },
    onLost: () => { told += 1; },
    leaseMs: LEASE_MS,
    coverUntil: Date.now() + 60_000,
  });
  keeper.start();
  try {
    await sleep(4 * LEASE_MS);
    assert.ok(asked >= 4, `renewed all along: ${asked} times`);
    assert.equal(told, 0);
    assert.equal(keeper.lost, false);
    await keeper.confirm();
  } finally {
    keeper.stop();
  }
});

test('a renewal that finds the lease gone still gives the run up at once, with the answer it got', async () => {
  let lostAt: number | null = null;
  const started = Date.now();
  const keeper = new LeaseKeeper({
    renew: async () => {
      throw new PalugadaError('task.lease_lost', 'worker w-1 no longer holds task t-1', {});
    },
    onLost: () => { lostAt = Date.now(); },
    leaseMs: LEASE_MS,
    coverUntil: Date.now() + 60_000,
  });
  keeper.start();
  try {
    await until(() => lostAt !== null, 'the keeper giving the run up');
    assert.ok(lostAt! - started < LEASE_MS, 'on the first renewal, not at the deadline');
    await assert.rejects(keeper.confirm(), refusesAsLost(/worker w-1 no longer holds task t-1/));
  } finally {
    keeper.stop();
  }
});

test('a run with no progress is still let go as quiet, while its worker holds the lease, and a cover still holds it', async () => {
  // Quiet is not lost: the keeper stops renewing on purpose, and the engine
  // hands the task back while this worker still holds it. The deadline is
  // for renewals that were wanted and did not happen.
  let asked = 0;
  let silentAt: number | null = null;
  let told = 0;
  const started = Date.now();
  const keeper = new LeaseKeeper({
    renew: async () => { asked += 1; },
    onLost: () => { told += 1; },
    onSilent: () => { silentAt = Date.now(); },
    leaseMs: LEASE_MS,
    coverUntil: Date.now() + LEASE_MS,
  });
  keeper.cover(Date.now() + 2 * LEASE_MS);
  keeper.start();
  try {
    await until(() => silentAt !== null, 'the run being let go as quiet');
    assert.ok(silentAt! - started >= 2 * LEASE_MS, 'covered as far as it was told');
    const renewals = asked;
    await sleep(2 * LEASE_MS);
    assert.equal(asked, renewals, 'nothing renewed once it went quiet');
    assert.equal(told, 0, 'and not called lost for the renewals it chose not to make');
    assert.equal(keeper.lost, false);
  } finally {
    keeper.stop();
  }
});
