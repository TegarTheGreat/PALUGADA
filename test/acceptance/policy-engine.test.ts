/**
 * PRD F3.3, F3.4, F3.5, F3.8 -- the policy engine.
 *
 * Acceptance criterion F3.5: a division policy that tries to turn
 * `dns-always-human` into `allow` is refused when it is saved.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { putPolicy, readGovernanceLog } from '../../src/governance/store.ts';
import { decide, evaluate, strictest, type PolicyRow } from '../../src/policy/engine.ts';
import {
  assertValidCondition,
  evaluateCondition,
  type ActionFacts,
  type Condition,
} from '../../src/policy/condition.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const FACTS: ActionFacts = {
  tool: 'dns.update',
  tier: 3,
  division: 'ops',
  money_cents: 0,
  recipient_domain: null,
  url_host: null,
  hour_local: 14,
  calls_in_window: 0,
};

function policy(overrides: Partial<PolicyRow>): PolicyRow {
  return {
    id: overrides.id ?? 'p',
    slug: overrides.slug ?? 'rule',
    scope: overrides.scope ?? 'platform',
    effect: overrides.effect ?? 'deny',
    condition: overrides.condition ?? { field: 'tool', op: 'matches', value: 'dns.*' },
    mode: overrides.mode ?? 'enforce',
  };
}

test('a division cannot loosen a platform policy (F3.5 acceptance)', async () => {
  const fixture = await createCompany('policy-precedence');

  // The PRD's own example: DNS at tier 3 always goes to a human.
  await putPolicy({
    slug: 'dns-always-human',
    effect: 'require_approval',
    condition: {
      all: [
        { field: 'tool', op: 'matches', value: 'dns.*' },
        { field: 'tier', op: 'gte', value: 3 },
      ],
    },
  });

  await assert.rejects(
    () =>
      putPolicy({
        slug: 'dns-always-human',
        effect: 'allow',
        condition: { field: 'tool', op: 'matches', value: 'dns.*' },
        companyId: fixture.companyId,
        divisionId: fixture.divisionId,
      }),
    /cannot be loosened/,
    'a division must not be able to waive a platform rule',
  );

  // Tightening the same rule is allowed.
  const tightened = await putPolicy({
    slug: 'dns-always-human',
    effect: 'deny',
    condition: { field: 'tool', op: 'matches', value: 'dns.*' },
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
  });
  assert.ok(tightened);
});

test('the strictest matching effect wins regardless of scope', () => {
  // The second half of F3.5. Even if a loosening policy reached the table by
  // some other path, evaluation still cannot widen what a broader scope set.
  const decision = decide(
    [
      policy({ id: 'a', scope: 'platform', effect: 'require_approval' }),
      policy({ id: 'b', scope: 'division', effect: 'allow' }),
    ],
    FACTS,
  );
  assert.equal(decision.effect, 'require_approval');
  assert.equal(decision.matched.length, 2);

  assert.equal(strictest('allow', 'deny'), 'deny');
  assert.equal(strictest('require_review', 'require_approval'), 'require_approval');
});

test('no matching policy leaves the action to the tier and grant gates', () => {
  const decision = decide([policy({ condition: { field: 'tool', op: 'eq', value: 'email.send' } })], FACTS);
  assert.equal(decision.effect, 'allow');
  assert.equal(decision.matched.length, 0);
});

test('audit mode observes without blocking (F3.8)', () => {
  const decision = decide(
    [policy({ id: 'draft', effect: 'deny', mode: 'log_only' })],
    FACTS,
  );
  assert.equal(decision.effect, 'allow', 'a log_only policy must not change the outcome');
  assert.equal(decision.observed.length, 1);
  assert.equal(decision.matched.length, 0);
});

test('conditions can reference every field F3.4 requires', () => {
  const cases: Array<[Condition, boolean]> = [
    [{ field: 'tool', op: 'matches', value: 'dns.*' }, true],
    [{ field: 'tool', op: 'matches', value: 'email.*' }, false],
    [{ field: 'tier', op: 'gte', value: 3 }, true],
    [{ field: 'division', op: 'in', value: ['ops', 'growth'] }, true],
    [{ field: 'money_cents', op: 'gt', value: 5000 }, false],
    [{ field: 'hour_local', op: 'lt', value: 18 }, true],
    [{ field: 'calls_in_window', op: 'gte', value: 1 }, false],
    [{ field: 'recipient_domain', op: 'not_in', value: ['acme.test'] }, true],
  ];

  for (const [condition, expected] of cases) {
    assert.equal(
      evaluateCondition(condition, FACTS),
      expected,
      `${JSON.stringify(condition)} should evaluate to ${expected}`,
    );
  }

  // Composition.
  assert.equal(
    evaluateCondition(
      { all: [{ field: 'tier', op: 'gte', value: 3 }, { not: { field: 'division', op: 'eq', value: 'growth' } }] },
      FACTS,
    ),
    true,
  );
  assert.equal(
    evaluateCondition(
      { any: [{ field: 'tier', op: 'lt', value: 2 }, { field: 'tool', op: 'eq', value: 'dns.update' }] },
      FACTS,
    ),
    true,
  );
});

test('an unknown recipient counts as external', () => {
  // The safe reading: a destination we cannot identify is not an internal one,
  // so a "not in internal_domains" rule must still fire.
  const unknownRecipient: ActionFacts = { ...FACTS, recipient_domain: null };
  assert.equal(
    evaluateCondition({ field: 'recipient_domain', op: 'not_in', value: ['acme.test'] }, unknownRecipient),
    true,
  );
  assert.equal(
    evaluateCondition({ field: 'recipient_domain', op: 'in', value: ['acme.test'] }, unknownRecipient),
    false,
  );
});

test('a malformed condition is refused before it is stored', async () => {
  assert.throws(() => assertValidCondition({ field: 'nonexistent', op: 'eq', value: 1 }), /unknown field/);
  assert.throws(() => assertValidCondition({ field: 'tier', op: 'approximately', value: 1 }), /unknown operator/);
  assert.throws(() => assertValidCondition({ all: [] }), /non-empty array/);
  assert.throws(() => assertValidCondition({ field: 'tier', op: 'gt', value: 'three' }), /expects a number/);

  await assert.rejects(
    () => putPolicy({ slug: 'broken', effect: 'deny', condition: { field: 'nope', op: 'eq', value: 1 } as never }),
    /unknown field/,
  );
});

test('a glob pattern cannot smuggle in a regular expression', () => {
  // Patterns come from configuration rows. Treating them as regexes would let
  // a policy author cause catastrophic backtracking, and would make "." match
  // any character where a capability name means a literal dot.
  const facts: ActionFacts = { ...FACTS, tool: 'dnsXupdate' };
  assert.equal(evaluateCondition({ field: 'tool', op: 'matches', value: 'dns.update' }, facts), false);
  assert.equal(
    evaluateCondition({ field: 'tool', op: 'matches', value: 'dns.update' }, { ...FACTS, tool: 'dns.update' }),
    true,
  );
  assert.equal(
    evaluateCondition({ field: 'tool', op: 'matches', value: '(a+)+$' }, { ...FACTS, tool: 'aaaaaaaaaaaaaaaaaaaa!' }),
    false,
  );
});

test('policies load across platform, company and division scopes', async () => {
  const fixture = await createCompany('policy-scopes');
  const other = await createCompany('policy-other');

  await putPolicy({ slug: 'platform-rule', effect: 'require_approval', condition: { field: 'tier', op: 'gte', value: 3 } });
  await putPolicy({
    slug: 'company-rule',
    effect: 'require_review',
    condition: { field: 'tool', op: 'matches', value: 'dns.*' },
    companyId: fixture.companyId,
  });
  await putPolicy({
    slug: 'other-company-rule',
    effect: 'deny',
    condition: { field: 'tool', op: 'matches', value: '*' },
    companyId: other.companyId,
  });

  const decision = await withTenant(fixture.companyId, (tx) =>
    evaluate(tx, fixture.companyId, fixture.divisionId, FACTS),
  );

  const slugs = decision.matched.map((m) => m.slug).sort();
  assert.deepEqual(slugs, ['company-rule', 'platform-rule']);
  assert.ok(
    !slugs.includes('other-company-rule'),
    "another tenant's policy must never reach this evaluation",
  );
  assert.equal(decision.effect, 'require_approval');
});

test('every policy change is recorded with a diff (F3.6)', async () => {
  const fixture = await createCompany('policy-audit');

  await putPolicy({
    slug: 'spend-cap',
    effect: 'require_approval',
    condition: { field: 'money_cents', op: 'gt', value: 5000 },
    companyId: fixture.companyId,
  });
  await putPolicy({
    slug: 'spend-cap',
    effect: 'deny',
    condition: { field: 'money_cents', op: 'gt', value: 5000 },
    companyId: fixture.companyId,
  });

  const log = await readGovernanceLog(fixture.companyId);
  assert.equal(log.length, 2);
  assert.equal(log[0]!.action, 'created');
  assert.equal(log[1]!.action, 'updated');
  assert.deepEqual(log[1]!.before, { effect: 'require_approval' });
  assert.deepEqual(log[1]!.after, { effect: 'deny' });
  assert.equal(log[1]!.actor, 'owner');

  // The company-scoped change also appears on that company's own timeline.
  const events = await withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ type: string }>(
      "SELECT type FROM events WHERE type LIKE 'policy.%' ORDER BY occurred_at",
    );
    return rows.map((r) => r.type);
  });
  assert.deepEqual(events, ['policy.created', 'policy.updated']);
});
