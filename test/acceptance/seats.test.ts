/**
 * Seats and accountabilities (PRD v2 F18.3; docs/STATUS.md 2.192).
 *
 * A role is a seat with one occupant. What it lacked was a short list of what
 * the seat answers for: the CEO routed work by the first sentence of each
 * charter, and two seats could both believe the customer's renewal was theirs,
 * or neither. These hold the list to its bounds in the database and at the
 * owner's route, every run of the seat to being told it, the CEO to seeing
 * every other seat's when it hands work on, and the chart to naming a seat
 * with none and an accountability two seats both claim -- shown, never
 * refused, since the owner may be halfway through drawing the chart.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { buildContext } from '../../src/context/builder.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { rollBack } from '../../src/governance/rollback.ts';
import { structureOf } from '../../src/owner/views.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

let sequence = 0;
async function packFor(fixture: Fixture, roleId: string) {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `look after the customers, take ${sequence}` }, createdBy: 'owner', reserveTokens: 1_000,
  });
  return withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
}

async function setAccountabilities(fixture: Fixture, roleId: string, lines: string[]) {
  await withTenant(fixture.companyId, (tx) =>
    tx.query('UPDATE roles SET accountabilities = $2::text[] WHERE id = $1', [roleId, lines]));
}

test('the database holds a seat to five accountabilities, each one line of 1 to 200 characters', async () => {
  const fixture = await createCompany('seat-bounds');
  const { rows } = await withTenant(fixture.companyId, (tx) =>
    tx.query<{ accountabilities: string[] }>('SELECT accountabilities FROM roles WHERE id = $1', [fixture.roleId]));
  assert.deepEqual(rows[0]!.accountabilities, [], 'a seat starts with none, and is not refused for it');

  await setAccountabilities(fixture, fixture.roleId, ['one', 'two', 'three', 'four', 'five']);
  await assert.rejects(setAccountabilities(fixture, fixture.roleId, ['one', 'two', 'three', 'four', 'five', 'six']),
    /roles_accountabilities_at_most_five/);
  await assert.rejects(setAccountabilities(fixture, fixture.roleId, ['x'.repeat(201)]), /at most 200 characters/);
  const shape = (error: unknown) => (error as { constraint?: string }).constraint === 'roles_accountabilities_shape'
    && /an accountability is one line/.test((error as Error).message);
  await assert.rejects(setAccountabilities(fixture, fixture.roleId, ['   ']), shape);
  await assert.rejects(setAccountabilities(fixture, fixture.roleId, ['the pipeline\nand the renewals']), shape);
  await assert.rejects(withTenant(fixture.companyId, (tx) =>
    tx.query('UPDATE roles SET accountabilities = ARRAY[NULL]::text[] WHERE id = $1', [fixture.roleId])), shape);
});

test('the owner says what a seat is accountable for; the change is a version that can be undone, and a hire can say it too', async () => {
  const fixture = await createCompany('seat-route');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const path = `/api/companies/${fixture.companyId}/roles/${fixture.roleId}`;

    const six = await api.call('POST', path, token,
      { accountabilities: ['a', 'b', 'c', 'd', 'e', 'f'], proof: { totp: api.code() } });
    assert.equal(six.status, 400);
    assert.match(String(six.body.error), /at most 5 accountabilities, and 6 were given/);
    const long = await api.call('POST', path, token, { accountabilities: ['x'.repeat(201)], proof: { totp: api.code() } });
    assert.equal(long.status, 400);
    assert.match(String(long.body.error), /an accountability is at most 200 characters.*this one is 201/);
    const notList = await api.call('POST', path, token, { accountabilities: 'sales', proof: { totp: api.code() } });
    assert.equal(notList.status, 400);
    assert.match(String(notList.body.error), /accountabilities must be an array/);
    const notText = await api.call('POST', path, token, { accountabilities: [null], proof: { totp: api.code() } });
    assert.match(String(notText.body.error), /accountabilities\[0\] must be text/);

    const set = await api.call('POST', path, token, {
      accountabilities: ['  Revenue against plan ', '', 'Hiring the seats the company lacks', 'revenue against plan'],
      summary: 'What the CEO answers for', proof: { totp: api.code() },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const structure = (await api.call('GET', `/api/companies/${fixture.companyId}/structure`, token)).body;
    const seat = structure.roles.find((one: { id: string }) => one.id === fixture.roleId);
    assert.deepEqual(seat.accountabilities, ['Revenue against plan', 'Hiring the seats the company lacks'],
      'trimmed, blank lines dropped, and the same one said twice kept once');

    // Changed again, then undone: the version before the second change comes back.
    const again = await api.call('POST', path, token, { accountabilities: ['Cash in the bank'], proof: { totp: api.code() } });
    assert.equal(again.status, 200);
    await rollBack(fixture.companyId, 'role', fixture.roleId, again.body.version);
    const restored = await structureOf(fixture.companyId);
    assert.deepEqual(restored.roles.find((one) => one.id === fixture.roleId)!.accountabilities,
      ['Revenue against plan', 'Hiring the seats the company lacks']);
    const { rows: versions } = await withTenant(fixture.companyId, (tx) => tx.query<{ snapshot: { accountabilities?: string[] } }>(
      "SELECT snapshot FROM config_versions WHERE kind = 'role' AND subject_id = $1 ORDER BY version", [fixture.roleId]));
    assert.deepEqual(versions.map((one) => one.snapshot.accountabilities), [[], ['Revenue against plan', 'Hiring the seats the company lacks'], ['Cash in the bank']],
      'each version keeps what the seat answered for before the change');

    // Cleared: an empty list is a seat with none, which the chart then names.
    const cleared = await api.call('POST', path, token, { accountabilities: [], proof: { totp: api.code() } });
    assert.equal(cleared.status, 200);
    assert.deepEqual((await structureOf(fixture.companyId)).roles.find((one) => one.id === fixture.roleId)!.accountabilities, []);

    const hired = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'sales', systemPrompt: 'Sell the product.',
      doneCriteria: ['the deal is recorded'], accountabilities: ['New customers each week'], proof: { totp: api.code() },
    });
    assert.equal(hired.status, 200, JSON.stringify(hired.body));
    assert.deepEqual((await structureOf(fixture.companyId)).roles.find((one) => one.id === hired.body.roleId)!.accountabilities,
      ['New customers each week']);
    const tooMany = await api.call('POST', `/api/companies/${fixture.companyId}/roles`, token, {
      divisionId: fixture.divisionId, slug: 'support', systemPrompt: 'Answer customers.',
      doneCriteria: ['the customer is answered'], accountabilities: ['a', 'b', 'c', 'd', 'e', 'f'], proof: { totp: api.code() },
    });
    assert.equal(tooMany.status, 400);
    assert.match(String(tooMany.body.error), /at most 5 accountabilities/);
  } finally {
    await api.close();
  }
});

test('every run of a seat is told what it is accountable for, and a delegating seat sees every other seat\'s', async () => {
  const fixture = await createCompany('seat-context');
  const sales = await addRole(fixture, 'sales');
  const support = await addRole(fixture, 'support');
  await withTenant(fixture.companyId, (tx) =>
    tx.query("UPDATE roles SET tools = ARRAY['task.delegate', 'ticket.create'] WHERE id = $1", [fixture.roleId]));
  // A company that has named none yet is not told, seat by seat, that it has none.
  const before = (await packFor(fixture, fixture.roleId)).sections.find((section) => section.kind === 'team')!.body;
  assert.doesNotMatch(before, /No accountabilities yet|Each is a seat/);
  assert.match(before, /- sales: In Operations\. You are a worker\.$/m);

  await setAccountabilities(fixture, sales, ['New customers each week', 'The sales pipeline']);
  await setAccountabilities(fixture, fixture.roleId, ['Revenue against plan']);

  const own = await packFor(fixture, sales);
  const charter = own.sections.find((section) => section.kind === 'role_charter')!;
  assert.match(charter.body, /You are a worker\.\n\nYou are accountable for:\n- New customers each week\n- The sales pipeline\n\nDone means:/,
    'after what the seat does, and before what done means');

  const ceo = await packFor(fixture, fixture.roleId);
  assert.match(ceo.sections.find((section) => section.kind === 'role_charter')!.body, /You are accountable for:\n- Revenue against plan/);
  const team = ceo.sections.find((section) => section.kind === 'team')!.body;
  assert.match(team, /- sales: In Operations\. You are a worker\. Accountable for: New customers each week; The sales pipeline\./);
  assert.match(team, /- support: In Operations\. You are a worker\. No accountabilities yet\./);
  assert.match(team, /hand it to the seat accountable for it/);
  assert.match(team, /ticket\.create of kind hire[^\n]*at most five/, 'a proposed hire names what its seat would answer for');

  // A seat with none is not told it has some.
  const quiet = await packFor(fixture, support);
  assert.doesNotMatch(quiet.sections.find((section) => section.kind === 'role_charter')!.body, /accountable for/);
});

test('the chart names a seat with no accountabilities and an accountability two seats both claim, and refuses neither', async () => {
  const fixture = await createCompany('seat-chart');
  const sales = await addRole(fixture, 'sales');
  const support = await addRole(fixture, 'support');
  await setAccountabilities(fixture, fixture.roleId, ['Revenue against plan', 'Customer renewals']);
  await setAccountabilities(fixture, sales, ['New customers each week', 'customer  renewals']);

  const { roles, seatChecks } = await structureOf(fixture.companyId);
  assert.deepEqual(seatChecks.withoutAccountabilities, [support]);
  assert.equal(seatChecks.sharedAccountabilities.length, 1);
  const shared = seatChecks.sharedAccountabilities[0]!;
  assert.equal(shared.accountability, 'Customer renewals', 'named as the first seat to claim it wrote it');
  assert.deepEqual([...shared.roleIds].sort(), [fixture.roleId, sales].sort(), 'the same words, whatever their case or spacing');
  assert.equal(roles.length, 3);

  // Each seat its own: nothing to name.
  await setAccountabilities(fixture, sales, ['New customers each week']);
  await setAccountabilities(fixture, support, ['Customers answered within a day']);
  const tidy = await structureOf(fixture.companyId);
  assert.deepEqual(tidy.seatChecks, { withoutAccountabilities: [], sharedAccountabilities: [] });
});

test('a seat\'s accountabilities travel with the company it is exported from', async () => {
  const fixture = await createCompany('seat-export');
  await setAccountabilities(fixture, fixture.roleId, ['Revenue against plan']);
  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => {
    lines.push(line);
  });
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const { roles } = await structureOf(restored.companyId);
  assert.deepEqual(roles.map((role) => role.accountabilities), [['Revenue against plan']]);
});
