/**
 * A person is an actor (the audit of 6 October, §8.2, P1.1; STATUS 2.173):
 * the first of four steps, an addressee on a question.
 *
 * The owner was the only person the platform could ask. A staff seat saw the
 * whole inbox and any approver could answer anything, so a question for the
 * bookkeeper was answerable by the cashier, and "who is meant to answer this"
 * was not a thing the platform knew. A run can now name the seat it asks
 * (`owner.ask` with `to`); the question is then that seat's -- the owner's too,
 * always -- and no other seat's: it is not in their inbox and they cannot
 * answer it. A question that names nobody is as it was.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { ownerAskCapability } from '../../src/broker/platform-capabilities.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import * as inbox from '../../src/inbox/inbox.ts';
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

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A staff member's authenticator app: the code it shows, a step ahead each time so none is a replay. */
function app(secret: string) {
  let step = stepFor(new Date()) - 1;
  return () => {
    step += 1;
    return totpCode(decodeBase32(secret), Math.min(step, stepFor(new Date()) + 1));
  };
}

async function seat(api: Console, owner: string, fixture: Fixture, name: string, kind: 'viewer' | 'approver') {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind, proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const invite = String(made.body.invite);
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), token: String(joined.body.token) };
}

async function runningTask(fixture: Fixture, goal: string) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  return task.id;
}

/** A run asking, as the platform's own `owner.ask` does it; the question is parked, which is what throws. */
async function ask(fixture: Fixture, taskId: string, input: Record<string, unknown>) {
  const capability = ownerAskCapability();
  return capability.execute(input as never, { companyId: fixture.companyId, taskId, divisionId: fixture.divisionId, roleId: fixture.roleId } as never);
}

const asked = (fixture: Fixture, itemId: string) => withTenant(fixture.companyId, (tx) => tx.query<{
  addressee_seat: string | null; status: string; decision: string | null; owner_note: string | null; payload: { addressee?: { name: string } };
}>('SELECT addressee_seat, status, decision, owner_note, payload FROM inbox_items WHERE id = $1', [itemId])).then((result) => result.rows[0]!);

const openQuestion = (fixture: Fixture, taskId: string) => withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
  "SELECT id FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'open' ORDER BY created_at DESC LIMIT 1", [taskId]))
  .then((result) => result.rows[0]!.id);

test('a run names the seat it asks: by name, an approver, one who is still seated -- and says which when it is wrong', async () => {
  const fixture = await createCompany('addressee-names');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi Santoso', 'approver');
    await seat(api, owner, fixture, 'Siti', 'approver');
    await seat(api, owner, fixture, 'Rina', 'viewer');
    const taskId = await runningTask(fixture, 'Cek harga bahan');

    // A viewer cannot answer, so a question for one would wait for ever.
    await assert.rejects(ask(fixture, taskId, { question: 'Berapa harga gula?', to: 'Rina' }), /Rina can only read/);
    // Nobody of that name: the people there are named.
    await assert.rejects(ask(fixture, taskId, { question: 'Berapa harga gula?', to: 'Joko' }), /no one called Joko .*Budi Santoso, Siti/);
    // A seat that was revoked is not there, and is not named among those who are.
    const tono = await seat(api, owner, fixture, 'Tono', 'approver');
    await api.call('POST', `/api/companies/${fixture.companyId}/staff/${tono.seatId}/revoke`, owner, {});
    await assert.rejects(ask(fixture, taskId, { question: 'Berapa harga gula?', to: 'Tono' }), /no one called Tono .*Budi Santoso, Siti$/);

    // By the name as written, in any case; the question is then parked for the answer.
    await assert.rejects(ask(fixture, taskId, { question: 'Berapa harga gula?', to: 'budi santoso' }),
      (error: unknown) => (error as { code?: string }).code === 'owner.asked');
    const item = await asked(fixture, await openQuestion(fixture, taskId));
    assert.equal(item.addressee_seat, budi.seatId);
    assert.equal(item.payload.addressee?.name, 'Budi Santoso');

    // The owner sees whom it is for, on the card.
    const listed = (await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, owner)).body.items as Array<{ question: string | null; addressee?: { name: string } }>;
    assert.deepEqual(listed.map((one) => [one.question, one.addressee?.name]), [['Berapa harga gula?', 'Budi Santoso']]);
  } finally {
    await api.close();
  }
});

test('a question for a seat is that seat\'s and the owner\'s: another seat neither sees it nor answers it', async () => {
  const fixture = await createCompany('addressee-answers');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi', 'approver');
    const siti = await seat(api, owner, fixture, 'Siti', 'approver');
    const taskId = await runningTask(fixture, 'Cek harga bahan');
    await assert.rejects(ask(fixture, taskId, { question: 'Berapa harga gula?', to: 'Budi' }), (error: unknown) => (error as { code?: string }).code === 'owner.asked');
    const itemId = await openQuestion(fixture, taskId);
    const mine = (token: string, query = '') => api.call('GET', `/api/companies/${fixture.companyId}/inbox${query}`, token);
    const ids = (answer: { body: { items: Array<{ id: string }> } }) => answer.body.items.map((one) => one.id);

    assert.deepEqual(ids(await mine(budi.token)), [itemId], 'it is in the addressee\'s inbox');
    assert.deepEqual(ids(await mine(budi.token, '?mine=1')), [itemId], 'and in "mine"');
    assert.deepEqual(ids(await mine(siti.token)), [], 'not in another seat\'s');
    assert.deepEqual(ids(await mine(owner)), [itemId], 'and the owner has all of it');

    // Another seat cannot answer it, by either route, and it stays open.
    const answer = (token: string, text: string) => api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/answer`, token, { answer: text });
    const refused = await answer(siti.token, '14.000');
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.match(String(refused.body.error), /for Budi/);
    const decided = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/decide`, siti.token, { decision: 'approve', note: '14.000' });
    assert.equal(decided.status, 403);
    assert.equal((await asked(fixture, itemId)).status, 'open');
    // Nor read what is behind it by its id: the list leaves it out, the id must not be a way in.
    const trace = (token: string) => api.call('GET', `/api/companies/${fixture.companyId}/inbox/${itemId}/trace`, token);
    const behind = await trace(siti.token);
    assert.equal(behind.status, 403, JSON.stringify(behind.body));
    assert.match(String(behind.body.error), /for Budi/);
    assert.equal((await trace(budi.token)).status, 200);
    assert.equal((await trace(owner)).status, 200);

    // The addressee answers; the run reads it, as it reads the owner's.
    const yes = await answer(budi.token, '14.000 per kilo');
    assert.equal(yes.status, 200, JSON.stringify(yes.body));
    const item = await asked(fixture, itemId);
    assert.deepEqual([item.status, item.decision, item.owner_note], ['decided', 'approve', '14.000 per kilo']);
    const { rows: [event] } = await withTenant(fixture.companyId, (tx) => tx.query<{ actor: string }>(
      "SELECT actor FROM events WHERE type = 'owner.decided' AND payload->>'inboxItemId' = $1 LIMIT 1", [itemId]));
    assert.equal(event?.actor, 'staff');
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => inbox.answersFor(tx, taskId)), [{ question: 'Berapa harga gula?', answer: '14.000 per kilo', files: [], by: 'Budi' }]);

    // The owner can answer one that is another seat's.
    const second = await runningTask(fixture, 'Cek harga susu');
    await assert.rejects(ask(fixture, second, { question: 'Berapa harga susu?', to: 'Siti' }), (error: unknown) => (error as { code?: string }).code === 'owner.asked');
    const secondItem = await openQuestion(fixture, second);
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${secondItem}/answer`, owner, { answer: '9.000' })).status, 200);
    assert.equal((await asked(fixture, secondItem)).owner_note, '9.000');
  } finally {
    await api.close();
  }
});

test('a question that names nobody is as it always was: any approver may answer it, and it is in every seat\'s inbox', async () => {
  const fixture = await createCompany('addressee-nobody');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await seat(api, owner, fixture, 'Budi', 'approver');
    const siti = await seat(api, owner, fixture, 'Siti', 'approver');
    const taskId = await runningTask(fixture, 'Cek harga bahan');
    await assert.rejects(ask(fixture, taskId, { question: 'Bolehkah diskon 10%?' }), (error: unknown) => (error as { code?: string }).code === 'owner.asked');
    const itemId = await openQuestion(fixture, taskId);
    const inboxOf = async (token: string, query = '') =>
      ((await api.call('GET', `/api/companies/${fixture.companyId}/inbox${query}`, token)).body.items as Array<{ id: string }>).map((one) => one.id);
    assert.deepEqual(await inboxOf(budi.token), [itemId]);
    assert.deepEqual(await inboxOf(siti.token), [itemId]);
    assert.deepEqual(await inboxOf(siti.token, '?mine=1'), [], 'it is nobody\'s in particular, so it is not "mine"');
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/answer`, siti.token, { answer: 'Boleh.' })).status, 200);
  } finally {
    await api.close();
  }
});
