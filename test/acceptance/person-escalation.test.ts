/**
 * A person is an actor (the audit of 6 October, §8.2, P1.1; STATUS 2.173):
 * the third step, a question to a person that nobody answers.
 *
 * A question put to a seat waits for that seat, and a seat can be away, ill or
 * asleep. Waiting for ever is the one thing a run cannot afford, and asking the
 * owner at once defeats the point of asking the seat. So the owner is not told
 * of a question that is for someone else until it has gone unanswered for a
 * day; then, once, they are told -- an event, and a message on the channels
 * they use -- and the question stays the seat's to answer, with the owner able
 * to answer it too.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { ownerAskCapability } from '../../src/broker/platform-capabilities.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { escalateQuestions, QUESTION_ESCALATES_AFTER_HOURS } from '../../src/inbox/inbox.ts';
import { undelivered } from '../../src/owner/notify.ts';
import { Worker } from '../../src/worker.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
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

async function approver(api: Console, owner: string, fixture: Fixture, name: string) {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'approver', proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const invite = String(made.body.invite);
  const opened = await api.call('POST', '/api/auth/join', '', { code: invite });
  const code = app(String(opened.body.secret));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: invite, offer: opened.body.offer, totp: code() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { seatId: String(made.body.seatId), token: String(joined.body.token) };
}

async function ask(fixture: Fixture, goal: string, input: Record<string, unknown>) {
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  await assert.rejects(
    ownerAskCapability().execute(input as never, { companyId: fixture.companyId, taskId: task.id, divisionId: fixture.divisionId, roleId: fixture.roleId } as never),
    (error: unknown) => (error as { code?: string }).code === 'owner.asked');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    "SELECT id FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'open'", [task.id]));
  return { taskId: task.id, itemId: rows[0]!.id };
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const channel = 'chat:telegram';
/** What the owner's channel would be given, asked well after the owner's quiet hours: only the escalation decides. */
const owed = (fixture: Fixture) => undelivered(fixture.companyId, channel, hours(48)).then((items) => items.map((item) => item.id));
const events = (fixture: Fixture, itemId: string) => withTenant(fixture.companyId, (tx) => tx.query<{ actor: string; payload: { addressee?: string } }>(
  "SELECT actor, payload FROM events WHERE type = 'inbox.question_escalated' AND payload->>'inboxItemId' = $1", [itemId])).then((result) => result.rows);

test('the owner is not told of a question for someone else until it has gone a day unanswered, and then once', async () => {
  const fixture = await createCompany('escalate-once');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await approver(api, owner, fixture, 'Budi');
    const toBudi = await ask(fixture, 'Cek harga gula', { question: 'Berapa harga gula?', to: 'Budi' });
    const toNoOne = await ask(fixture, 'Cek harga susu', { question: 'Bolehkah diskon 10%?' });

    // The question for no one in particular reaches the owner's channels as it always did; Budi's does not.
    assert.deepEqual(await owed(fixture), [toNoOne.itemId]);
    assert.equal(await escalateQuestions(fixture.companyId, hours(QUESTION_ESCALATES_AFTER_HOURS - 1)), 0, 'not yet');
    assert.deepEqual(await owed(fixture), [toNoOne.itemId]);

    // A day on: the owner is told, once, and only of Budi's.
    const later = hours(QUESTION_ESCALATES_AFTER_HOURS + 1);
    assert.equal(await escalateQuestions(fixture.companyId, later), 1);
    assert.equal(await escalateQuestions(fixture.companyId, later), 0, 'once');
    assert.deepEqual((await owed(fixture)).sort(), [toNoOne.itemId, toBudi.itemId].sort());
    assert.deepEqual((await events(fixture, toBudi.itemId)).map((event) => [event.actor, event.payload.addressee]), [['system', 'Budi']]);
    assert.deepEqual(await events(fixture, toNoOne.itemId), []);

    // The card says so, to the owner and to Budi; it is still Budi's, and still open for him.
    const flagged = (token: string) => api.call('GET', `/api/companies/${fixture.companyId}/inbox`, token)
      .then((answer) => (answer.body.items as Array<{ id: string; escalated?: boolean; addressee?: { name: string } }>).find((one) => one.id === toBudi.itemId));
    assert.deepEqual([(await flagged(owner))?.escalated, (await flagged(owner))?.addressee?.name], [true, 'Budi']);
    assert.equal((await flagged(budi.token))?.escalated, true);
    const answered = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${toBudi.itemId}/answer`, budi.token, { answer: '14.000' });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
  } finally {
    await api.close();
  }
});

test('a question already answered, or asked of no one, is never escalated', async () => {
  const fixture = await createCompany('escalate-never');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const budi = await approver(api, owner, fixture, 'Budi');
    const answeredQuestion = await ask(fixture, 'Cek harga gula', { question: 'Berapa harga gula?', to: 'Budi' });
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${answeredQuestion.itemId}/answer`, budi.token, { answer: '14.000' })).status, 200);
    const toNoOne = await ask(fixture, 'Cek harga susu', { question: 'Bolehkah diskon 10%?' });
    assert.equal(await escalateQuestions(fixture.companyId, hours(QUESTION_ESCALATES_AFTER_HOURS * 3)), 0);
    assert.deepEqual(await events(fixture, answeredQuestion.itemId), []);
    assert.deepEqual(await events(fixture, toNoOne.itemId), []);
  } finally {
    await api.close();
  }
});

test('the worker brings an unanswered question to the owner on its own, a day after it was put', async () => {
  const fixture = await createCompany('escalate-worker');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    await approver(api, owner, fixture, 'Budi');
    const toBudi = await ask(fixture, 'Cek harga gula', { question: 'Berapa harga gula?', to: 'Budi' });
    const worker = new Worker({
      engine: new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), llm: new RecordingLlmClient(), handlers: new Map() }),
      companyId: fixture.companyId,
    });
    await worker.tick(hours(2));
    assert.deepEqual(await events(fixture, toBudi.itemId), [], 'two hours is not a day');
    await worker.tick(hours(QUESTION_ESCALATES_AFTER_HOURS + 1));
    assert.equal((await events(fixture, toBudi.itemId)).length, 1);
    await worker.tick(hours(QUESTION_ESCALATES_AFTER_HOURS + 2));
    assert.equal((await events(fixture, toBudi.itemId)).length, 1, 'once');
  } finally {
    await api.close();
  }
});
