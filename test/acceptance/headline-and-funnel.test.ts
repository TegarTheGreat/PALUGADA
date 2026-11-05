/**
 * The owner's headline metric and funnel steps on measures (F18.13, STATUS
 * 2.200).
 *
 * The headline is the one number a company is judged by: the portfolio shows
 * it on the company's card, and every run is told it. It was always inferred
 * -- the first measure on the highest active goal -- which is a guess. Now the
 * owner may choose it (after Ellis's north star), and the choice wins while
 * its measure is live. A headline that can be moved directly is easy to buy
 * with something nobody watches, so the console warns when the chosen
 * measure has no pair; the platform keeps the choice either way.
 *
 * A measure may also name the funnel step it counts (after McClure):
 * acquisition, activation, retention, referral or revenue. The weekly
 * scorecard groups its lines by step, in that order, so the owner reads the
 * funnel from the top.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { buildContext } from '../../src/context/builder.ts';
import { Engine } from '../../src/engine/engine.ts';
import { AdapterRegistry } from '../../src/runtime/protocol.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import {
  FUNNEL_STEPS, changeMetric, chooseHeadline, defineMetric, headlines, metricsIn, recordObservation, renderMetrics, scorecardOf,
} from '../../src/domain/metrics.ts';
import { structureOf } from '../../src/owner/views.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { CLOSING_GRACE_DAYS, closeCompany, eraseDueCompanies } from '../../src/governance/closing.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function missionOf(fixture: Fixture): Promise<string> {
  const { rows } = await withTenant(fixture.companyId, (tx) =>
    tx.query<{ id: string }>("SELECT id FROM goals WHERE kind = 'mission'"));
  return rows[0]!.id;
}

async function headlineIdOf(companyId: string): Promise<string | null> {
  const { rows } = await withControlPlane((tx) => tx.query<{ headline_metric_id: string | null }>(
    'SELECT headline_metric_id FROM companies WHERE id = $1', [companyId]));
  return rows[0]!.headline_metric_id;
}

test("the owner's chosen headline is the portfolio's, over the inferred one, until they clear it", async () => {
  const fixture = await createCompany('headline-chosen');
  const mission = await missionOf(fixture);
  // Inferred: the mission's measure, because the mission is highest.
  await defineMetric(fixture.companyId, {
    goalId: mission, slug: 'customers', name: 'Paying customers', unit: 'count', target: 200,
  });
  const activated = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'activated', name: 'Shops that sent a first order', unit: 'count', baseline: 0, target: 400,
  });
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: 'activated', value: 100, recordedBy: 'owner',
  }));
  const inferred = (await withControlPlane((tx) => headlines(tx))).get(fixture.companyId)!;
  assert.equal(inferred.name, 'Paying customers');
  assert.equal(inferred.chosen, false, 'nobody chose it: it is the first measure on the highest goal');

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const choose = (metricId: unknown) =>
      api.call('POST', `/api/companies/${fixture.companyId}/headline`, token, { metricId });

    const chosen = await choose(activated);
    assert.equal(chosen.status, 200, JSON.stringify(chosen.body));
    assert.equal(chosen.body.headline.metricId, activated);
    assert.deepEqual((await withControlPlane((tx) => headlines(tx))).get(fixture.companyId), {
      metricId: activated, name: 'Shops that sent a first order', unit: 'count', target: 400, value: 100, verified: true,
      progress: 0.25, chosen: true, pair: null,
    }, "the owner's choice wins over the mission's measure, and has no pair yet");

    // The companies the console lists carry it, and the structure names it,
    // so the chooser starts from the owner's choice.
    const listed = await api.call('GET', '/api/companies', token);
    const company = (listed.body.companies as Array<{ id: string; headline: { metricId: string; chosen: boolean } | null }>)
      .find((one) => one.id === fixture.companyId)!;
    assert.deepEqual([company.headline?.metricId, company.headline?.chosen], [activated, true]);
    assert.equal((await structureOf(fixture.companyId)).headlineMetricId, activated);

    // Paired, the headline says what it is watched with.
    const quality = await defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: 'complaints', name: 'Complaints per hundred orders', unit: 'ratio', direction: 'down',
      baseline: 5, target: 1, pairedWith: activated,
    });
    assert.deepEqual((await withControlPlane((tx) => headlines(tx))).get(fixture.companyId)?.pair,
      { id: quality, name: 'Complaints per hundred orders' });

    // Cleared, the portfolio goes back to inferring it.
    const cleared = await choose(null);
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(await headlineIdOf(fixture.companyId), null);
    const back = (await withControlPlane((tx) => headlines(tx))).get(fixture.companyId)!;
    assert.deepEqual([back.name, back.chosen], ['Paying customers', false]);
    assert.equal(cleared.body.headline.chosen, false);

    // What is refused, each naming what is accepted.
    const weekly = await defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: 'calls', name: 'Sales calls made', unit: 'count', target: 50, reviewEvery: 'week',
    });
    const retired = await defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: 'old', name: 'Old count', unit: 'count', target: 5,
    });
    await changeMetric(fixture.companyId, retired, { retired: true });
    const other = await createCompany('headline-other');
    const elsewhere = await defineMetric(other.companyId, {
      goalId: other.goalId, slug: 'theirs', name: 'Their count', unit: 'count', target: 5,
    });
    const refusals: Array<[unknown, RegExp]> = [
      [weekly, /calls is a line on the weekly scorecard.*choose a measure aimed at a target/],
      [retired, /old is retired.*choose a measure that is still measured/],
      [elsewhere, /no measure .* in this company/],
      ['not-an-id', /no measure not-an-id in this company/],
      [42, /metricId must be the id of one of the company's measures, or null/],
    ];
    for (const [metricId, said] of refusals) {
      const refused = await choose(metricId);
      assert.equal(refused.status, 400, `${String(metricId)}: ${JSON.stringify(refused.body)}`);
      assert.match(String(refused.body.error), said);
    }
    const missing = await api.call('POST', `/api/companies/${fixture.companyId}/headline`, token, {});
    assert.equal(missing.status, 400);
    assert.match(String(missing.body.error), /give metricId/);
    assert.equal(await headlineIdOf(fixture.companyId), null, 'nothing refused was kept');
  } finally {
    await api.close();
  }

  // An agent cannot choose what its company is judged by.
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    'UPDATE companies SET headline_metric_id = $1 WHERE id = $2', [activated, fixture.companyId])), /permission denied/);
});

test('a headline lets go of a measure that is retired, deleted or put on the weekly scorecard', async () => {
  const fixture = await createCompany('headline-let-go');
  const define = (slug: string) => defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug, name: `Count of ${slug}`, unit: 'count', target: 10,
  });

  const retiring = await define('retiring');
  await chooseHeadline(fixture.companyId, retiring);
  await changeMetric(fixture.companyId, retiring, { retired: true });
  assert.equal(await headlineIdOf(fixture.companyId), null, 'retired, it is history, not what the company is judged by');

  const weekly = await define('weekly');
  await chooseHeadline(fixture.companyId, weekly);
  await changeMetric(fixture.companyId, weekly, { reviewEvery: 'week' });
  assert.equal(await headlineIdOf(fixture.companyId), null, 'a weekly goal is not a target to make progress toward');

  const deleted = await define('deleted');
  await chooseHeadline(fixture.companyId, deleted);
  await withControlPlane((tx) => tx.query('DELETE FROM goal_metrics WHERE id = $1', [deleted]));
  assert.equal(await headlineIdOf(fixture.companyId), null, 'deleted, the key lets go');

  // The database holds the rule however the row is written.
  const live = await define('live');
  await changeMetric(fixture.companyId, live, { retired: true });
  await assert.rejects(withControlPlane((tx) => tx.query(
    'UPDATE companies SET headline_metric_id = $1 WHERE id = $2', [live, fixture.companyId])),
  /the measure live is retired/);
  const other = await createCompany('headline-let-go-other');
  const theirs = await defineMetric(other.companyId, {
    goalId: other.goalId, slug: 'theirs', name: 'Theirs', unit: 'count', target: 5,
  });
  await assert.rejects(withControlPlane((tx) => tx.query(
    'UPDATE companies SET headline_metric_id = $1 WHERE id = $2', [theirs, fixture.companyId])),
  /companies_headline_metric_fkey/, "another company's measure is out of reach of the key");

  // And a company with a headline can still be erased: the key between the
  // two tables runs both ways, and neither stops the delete.
  const erased = await createCompany('headline-erased');
  const its = await defineMetric(erased.companyId, {
    goalId: erased.goalId, slug: 'its', name: 'Its count', unit: 'count', target: 5,
  });
  await chooseHeadline(erased.companyId, its);
  // Closed, and erased once its grace is over, as the worker erases one.
  await closeCompany(erased.companyId, CLOSING_GRACE_DAYS.least);
  await withControlPlane((tx) => tx.query(
    "UPDATE companies SET closing_at = now() - interval '31 days', erase_after = now() - interval '1 day' WHERE id = $1",
    [erased.companyId]));
  const pass = await eraseDueCompanies();
  assert.deepEqual(pass.failed, [], JSON.stringify(pass.failed));
  assert.deepEqual(pass.erased.map((one) => one.companyId), [erased.companyId]);
});

test('a headline that lets go says so in the company history, and why', async () => {
  const fixture = await createCompany('headline-let-go-said');
  const define = (slug: string) => defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug, name: `Count of ${slug}`, unit: 'count', target: 10,
  });
  const letGo = async () => (await withControlPlane((tx) => tx.query<{ actor: string; payload: Record<string, unknown> }>(
    "SELECT actor, payload FROM events WHERE company_id = $1 AND type = 'company.headline_let_go' ORDER BY occurred_at, id",
    [fixture.companyId]))).rows;

  const retiring = await define('retiring');
  await chooseHeadline(fixture.companyId, retiring);
  await changeMetric(fixture.companyId, retiring, { retired: true });
  const weekly = await define('weekly');
  await chooseHeadline(fixture.companyId, weekly);
  await changeMetric(fixture.companyId, weekly, { reviewEvery: 'week' });
  // A measure that is not the headline lets go of nothing, and says nothing.
  const bystander = await define('bystander');
  await changeMetric(fixture.companyId, bystander, { retired: true });
  // Nor does a change to the headline that keeps it a target.
  const kept = await define('kept');
  await chooseHeadline(fixture.companyId, kept);
  await changeMetric(fixture.companyId, kept, { target: 20 });

  assert.deepEqual(await letGo(), [
    { actor: 'owner', payload: { metricId: retiring, slug: 'retiring', reason: 'retired' } },
    { actor: 'owner', payload: { metricId: weekly, slug: 'weekly', reason: 'weekly' } },
  ]);
  assert.equal(await headlineIdOf(fixture.companyId), kept);
});

test('a headline chosen while its measure is being retired or put on the scorecard waits, and is refused', async () => {
  const fixture = await createCompany('headline-race');
  const define = (slug: string) => defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug, name: `Count of ${slug}`, unit: 'count', target: 10,
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 300));

  // The measure is locked and changed as changeMetric changes it, and held
  // uncommitted while the headline is chosen from another connection. Its
  // trigger has already run, and found no headline to let go.
  for (const [slug, change, refusal] of [
    ['retiring', 'retired_at = now()', /the measure retiring is retired/],
    ['weekly', "review_every = 'week'", /the measure weekly is a line on the weekly scorecard/],
  ] as const) {
    const measure = await define(slug);
    for (const how of ['chooseHeadline', 'a direct write'] as const) {
      let settled = false;
      let choosing: Promise<unknown> = Promise.resolve();
      await withControlPlane(async (tx) => {
        await tx.query('SELECT id FROM goal_metrics WHERE id = $1 FOR UPDATE', [measure]);
        await tx.query(`UPDATE goal_metrics SET ${change} WHERE id = $1`, [measure]);
        // However the row is written, the database waits too.
        choosing = (how === 'chooseHeadline'
          ? chooseHeadline(fixture.companyId, measure)
          : withControlPlane((other) => other.query(
            'UPDATE companies SET headline_metric_id = $1 WHERE id = $2', [measure, fixture.companyId])))
          .then(() => null, (error: unknown) => error)
          .finally(() => { settled = true; });
        await pause();
        assert.equal(settled, false, `${how} waits for the change to the measure to end`);
      });
      const chose = await choosing;
      assert.ok(chose instanceof Error, `${how} was not refused`);
      assert.match(chose.message, refusal);
      assert.equal(await headlineIdOf(fixture.companyId), null, `${how} left the headline on ${slug}, which may not be one`);
    }
  }

  // The other way round, the change waits for the choice, and lets it go.
  const chosen = await define('chosen');
  let changing: Promise<unknown> = Promise.resolve();
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE companies SET headline_metric_id = $1 WHERE id = $2', [chosen, fixture.companyId]);
    changing = changeMetric(fixture.companyId, chosen, { retired: true });
    await pause();
  });
  await changing;
  assert.equal(await headlineIdOf(fixture.companyId), null);
});

test("every run is told the headline the owner chose, with its pair, and nothing when they chose none", async () => {
  const fixture = await createCompany('headline-told');
  const mission = await missionOf(fixture);
  const run = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'plan the week' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  const context = () => withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: run.id }));

  const orders = await defineMetric(fixture.companyId, {
    goalId: mission, slug: 'orders', name: 'Repeat orders a month', unit: 'count', target: 300, funnelStep: 'retention',
  });
  assert.equal((await context()).sections.find((section) => section.kind === 'headline'), undefined,
    'an inferred headline is the portfolio\'s guess, not the owner\'s word, and no run is told it');

  await chooseHeadline(fixture.companyId, orders);
  await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'refunds', name: 'Refund rate', unit: 'percent', direction: 'down', baseline: 8, target: 2,
    pairedWith: orders,
  });
  await withTenant(fixture.companyId, (tx) => recordObservation(tx, {
    companyId: fixture.companyId, metric: 'orders', value: 120, recordedBy: 'owner',
  }));
  const told = (await context()).sections.find((section) => section.kind === 'headline');
  assert.ok(told, 'the run was not told the headline');
  assert.equal(told.title, "The company's headline metric");
  assert.match(told.body, /The owner judges the company by Repeat orders a month \[orders\]/);
  assert.match(told.body, /from 0 to 300 count, higher is better; funnel step: retention; now 120 \(verified/);
  assert.match(told.body, /Watch it with Refund rate \[refunds\]/);
  // Told once, near the top, where the stage is: before the work's own goal chain.
  const kinds = (await context()).sections.map((section) => section.kind);
  assert.ok(kinds.indexOf('headline') < kinds.indexOf('goal_ancestry'));

  // And a runtime of its own, which is handed notes rather than the whole
  // pack, is handed it too.
  await withTenant(fixture.companyId, (tx) =>
    tx.query("UPDATE roles SET runtime = 'headline-seen', backend = 'local' WHERE id = $1", [fixture.roleId]));
  const seen: Array<Array<{ title: string; body: string }>> = [];
  const adapters = new AdapterRegistry();
  adapters.register({
    name: 'headline-seen',
    backends: ['local'],
    async health() { return { ok: true, detail: 'test' }; },
    async run(request) {
      seen.push(request.contextPack.notes);
      return { output: { summary: 'planned' } };
    },
  });
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  const engine = new Engine({ broker: new CapabilityBroker(registry), adapters, workerId: 'headline-worker' });
  await engine.runTask(fixture.companyId, run.id, 'worker');
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.some((note) => note.title === "The company's headline metric" && /Repeat orders a month/.test(note.body)),
    JSON.stringify(seen[0]!.map((note) => note.title)));
});

test('a measure names its funnel step, and the scorecard reads the funnel from the top', async () => {
  const fixture = await createCompany('funnel-steps');
  assert.deepEqual([...FUNNEL_STEPS], ['acquisition', 'activation', 'retention', 'referral', 'revenue']);
  const line = (slug: string, funnelStep: (typeof FUNNEL_STEPS)[number] | null, extra: { pairedWith?: string } = {}) =>
    defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug, name: slug, unit: 'count', target: 10, reviewEvery: 'week', funnelStep, ...extra,
    });
  // Made in an order the funnel is not read in.
  const paid = await line('paid', 'revenue');
  const visits = await line('visits', 'acquisition');
  const loose = await line('loose', null);
  await line('signups', 'activation');
  // Paired across steps: the pair stays together, under the step of the one
  // the funnel reaches first.
  await line('refunds', 'retention', { pairedWith: paid });
  const invites = await line('invites', 'referral');

  const card = await withTenant(fixture.companyId, (tx) => scorecardOf(tx, fixture.companyId, new Date()));
  assert.deepEqual(card.lines.map((one) => [one.slug, one.funnelStep, one.group]), [
    ['visits', 'acquisition', 'acquisition'],
    ['signups', 'activation', 'activation'],
    ['refunds', 'retention', 'retention'],
    ['paid', 'revenue', 'retention'],
    ['invites', 'referral', 'referral'],
    ['loose', null, null],
  ]);

  // Changed, and cleared, by the owner; refused when it is not one of the five.
  await changeMetric(fixture.companyId, loose, { funnelStep: 'revenue' });
  await changeMetric(fixture.companyId, invites, { funnelStep: null });
  const steps = Object.fromEntries((await withTenant(fixture.companyId, (tx) => metricsIn(tx)))
    .map((metric) => [metric.slug, metric.funnelStep]));
  assert.deepEqual([steps.loose, steps.invites, steps.visits], ['revenue', null, 'acquisition']);
  for (const attempt of [
    () => defineMetric(fixture.companyId, {
      goalId: fixture.goalId, slug: 'aware', name: 'Aware', unit: 'count', target: 1, funnelStep: 'awareness' as never,
    }),
    () => changeMetric(fixture.companyId, visits, { funnelStep: 'awareness' as never }),
  ]) {
    await assert.rejects(attempt, (error: unknown) => isPalugadaError(error)
      && /funnelStep must be one of acquisition, activation, retention, referral, revenue, or null for a measure that is not a funnel number; "awareness" is none of them/
        .test(error.message));
  }
  // The database refuses it too, and the application role cannot write it.
  await assert.rejects(withControlPlane((tx) => tx.query(
    "UPDATE goal_metrics SET funnel_step = 'awareness' WHERE id = $1", [visits])), /goal_metrics_funnel_step_known/);
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE goal_metrics SET funnel_step = 'revenue' WHERE id = $1", [visits])), /permission denied/);

  // Through the owner API, as the forms send it.
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const added = await api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}/metrics`, token, {
      slug: 'trials', name: 'Trials started', unit: 'count', target: 20, funnelStep: 'activation',
    });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const changed = await api.call('POST', `/api/companies/${fixture.companyId}/metrics/${added.body.id}`, token, {
      funnelStep: 'retention', proof: { totp: api.code() },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const refused = await api.call('POST', `/api/companies/${fixture.companyId}/goals/${fixture.goalId}/metrics`, token, {
      slug: 'odd', name: 'Odd', unit: 'count', target: 2, funnelStep: 'growth',
    });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /funnelStep must be one of/);
    const trials = (await withTenant(fixture.companyId, (tx) => metricsIn(tx))).find((metric) => metric.slug === 'trials')!;
    assert.equal(trials.funnelStep, 'retention');
    // A run is told the step with the measure.
    assert.match(renderMetrics([trials]), /Trials started \[trials\]: .*; funnel step: retention; no value recorded yet/);
  } finally {
    await api.close();
  }
});

test('the headline and the funnel steps travel with the company', async () => {
  const fixture = await createCompany('headline-export');
  const orders = await defineMetric(fixture.companyId, {
    goalId: fixture.goalId, slug: 'orders', name: 'Orders', unit: 'count', target: 100, funnelStep: 'revenue',
  });
  await chooseHeadline(fixture.companyId, orders);

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'headline-restored' });

  const metrics = await withTenant(restored.companyId, (tx) => metricsIn(tx));
  assert.equal(metrics[0]!.funnelStep, 'revenue');
  assert.equal(await headlineIdOf(restored.companyId), metrics[0]!.id, 'mapped to the restored measure, not the source\'s');
  assert.equal((await withControlPlane((tx) => headlines(tx))).get(restored.companyId)?.chosen, true);
});
