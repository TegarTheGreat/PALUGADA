/**
 * The owner watches the work as it happens (the analysis of 3 October, §9
 * P1 item 11).
 *
 * The console asked again every five to fifteen seconds, so a task could be
 * finished, or waiting on the owner, for a quarter of a minute before the
 * screen said so; Paperclip and Buzz show it live. The owner API keeps a
 * stream open per company and sends each event the moment it is written --
 * what happened and to which task, not what it carried, which is read the
 * ordinary way -- and the console reloads what the event touches.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

interface Heard { type: string; taskId: string | null; actor: string; id: string }

/** Reads a stream's events as they come, until `stop`. */
function listen(body: ReadableStream<Uint8Array>) {
  const heard: Heard[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    for (;;) {
      const { value, done: finished } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (finished) return;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const data = message.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
        if (data) heard.push(JSON.parse(data) as Heard);
      }
    }
  })();
  return { heard, done, stop: () => reader.cancel() };
}

async function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const by = Date.now() + ms;
  while (Date.now() < by) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`waited ${ms} ms for ${what}`);
}

async function rootTask(fixture: Fixture, goal: string) {
  return createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  });
}

test("the owner hears each of the company's events as it is written, and no other company's", async () => {
  const fixture = await createCompany('live');
  const other = await createCompany('live-other');
  const before = await rootTask(fixture, 'Answer Budi');
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    assert.equal((await fetch(`${api.url}/api/companies/${fixture.companyId}/live`)).status, 401, 'signed in first');

    const response = await fetch(`${api.url}/api/companies/${fixture.companyId}/live`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
    const stream = listen(response.body!);

    // What happened before the owner looked is read the ordinary way, not replayed.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(stream.heard.filter((one) => one.taskId === before.id), []);

    const task = await rootTask(fixture, 'Answer Sari');
    await transition(fixture.companyId, task.id, 'running');
    await until(() => stream.heard.some((one) => one.type === 'task.running' && one.taskId === task.id), 'task.running');
    await withTenant(other.companyId, (tx) => appendEvent(tx, { companyId: other.companyId, type: 'owner.note', actor: 'owner', payload: { secret: 'theirs' } }));
    await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'Answered.' } });
    await until(() => stream.heard.some((one) => one.type === 'task.completed'), 'task.completed');

    assert.ok(stream.heard.every((one) => one.type !== 'owner.note'), 'nothing of another company');
    assert.ok(stream.heard.every((one) => !('payload' in one)), 'what happened, not what it carried');
    const ids = stream.heard.map((one) => one.id);
    assert.equal(new Set(ids).size, ids.length, 'each event once');

    // Closing the API ends the stream rather than waiting on it.
    const closing = api.close(5_000);
    await Promise.race([stream.done, new Promise((_, reject) => setTimeout(() => reject(new Error('the stream outlived the API')), 3_000))]);
    await closing;
  } finally {
    await api.close();
  }
});

type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** The owner seats someone, who joins with an authenticator app of their own and is signed in (staff.ts). */
async function seated(api: Console, owner: string, fixture: Fixture, name: string): Promise<{ seatId: string; token: string; signIn: () => Promise<string> }> {
  const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name, kind: 'viewer', proof: { totp: api.code() } });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const opened = await api.call('POST', '/api/auth/join', '', { code: made.body.invite });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  // Their app's code, a step ahead each time so none is a replay.
  let step = stepFor(new Date()) - 1;
  const code = () => totpCode(decodeBase32(String(opened.body.secret)), Math.min(step += 1, stepFor(new Date()) + 1));
  const joined = await api.call('POST', '/api/auth/join/confirm', '', { code: made.body.invite, offer: opened.body.offer, totp: code() });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const signIn = async () => {
    const response = await api.call('POST', '/api/auth/sign-in', '', { totp: code() });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return String(response.body.token);
  };
  return { seatId: String(made.body.seatId), token: String(joined.body.token), signIn };
}

/**
 * A stream outlived the session that opened it: a signed-out browser kept
 * hearing the company's work until it closed the tab. Each stream is now
 * held by the session it was opened with and the person behind it, and
 * ending either ends it, in this process at once (F19.11).
 */
test('signing out ends the streams that session opened', async () => {
  const fixture = await createCompany('live-signed-out');
  const api = await consoleWithSettings();
  try {
    const first = await api.signIn();
    const second = await api.signIn();
    const open = async (token: string) => {
      const response = await fetch(`${api.url}/api/companies/${fixture.companyId}/live`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200);
      return listen(response.body!);
    };
    const ended = (stream: ReturnType<typeof listen>, what: string) => Promise.race([
      stream.done,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} outlived its session`)), 3_000)),
    ]);
    const stillOpen = async (stream: ReturnType<typeof listen>, what: string) => {
      const task = await rootTask(fixture, `Still heard: ${what}`);
      await until(() => stream.heard.some((one) => one.taskId === task.id), `${what} to hear the next event`);
    };

    // Two tabs of one session, one of another.
    const tab = await open(first);
    const otherTab = await open(first);
    const elsewhere = await open(second);
    assert.equal((await api.call('POST', '/api/auth/sign-out', first)).status, 200);
    await ended(tab, 'the first tab');
    await ended(otherTab, 'the second tab');
    await stillOpen(elsewhere, 'the other session');

    // A seat's: its own sign-out ends its own, and the owner ending the seat ends the rest.
    const owner = second;
    const siti = await seated(api, owner, fixture, 'Siti Rahayu');
    const hers = await open(siti.token);
    const herOtherSession = await siti.signIn();
    const herPhone = await open(herOtherSession);
    assert.equal((await api.call('POST', '/api/auth/sign-out', siti.token)).status, 200);
    await ended(hers, "the seat's stream");
    await stillOpen(herPhone, "the seat's other session");
    assert.equal((await api.call('POST', `/api/companies/${fixture.companyId}/staff/${siti.seatId}/revoke`, owner)).status, 200);
    await ended(herPhone, "the revoked seat's stream");

    // And signing out everywhere ends every owner's stream, this one's too.
    await stillOpen(elsewhere, 'the owner\'s stream');
    assert.equal((await api.call('POST', '/api/auth/sign-out-everywhere', owner)).status, 200);
    await ended(elsewhere, 'the owner\'s last stream');
  } finally {
    await api.close();
  }
});

/** A company's live stream, opened with a session's token. */
async function openLive(api: Console, fixture: Fixture, token: string) {
  const response = await fetch(`${api.url}/api/companies/${fixture.companyId}/live`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return listen(response.body!);
}

/** The stream ends within three seconds, or `what` outlived what ended it. */
async function endsSoon(stream: ReturnType<typeof listen>, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      stream.done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} outlived what ended it`)), 3_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The database reads a uuid in any letter case, so a seat named in capitals
 * in the address is still revoked, with its sessions. Its streams are filed
 * under the id as the database spells it, so they must be ended by that
 * spelling too, or a revoked seat goes on hearing the company.
 */
test('a seat revoked by its id in capitals loses its streams as well', async () => {
  const fixture = await createCompany('live-capitals');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const siti = await seated(api, owner, fixture, 'Siti Rahayu');
    const hers = await openLive(api, fixture, siti.token);
    // Braces are a spelling the database also reads; one spelling is taken, and this is refused before it is asked.
    const braced = await api.call('POST', `/api/companies/${fixture.companyId}/staff/{${siti.seatId}}/revoke`, owner);
    assert.equal(braced.status, 400, JSON.stringify(braced.body));
    const task = await rootTask(fixture, 'Still heard by the seat');
    await until(() => hers.heard.some((one) => one.taskId === task.id), 'the seat, still seated, to hear the next event');
    const revoked = await api.call('POST', `/api/companies/${fixture.companyId}/staff/${siti.seatId.toUpperCase()}/revoke`, owner);
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    await endsSoon(hers, "the revoked seat's stream");
  } finally {
    await api.close();
  }
});

/**
 * New recovery codes end the old set, and every session it signed in
 * (mfa.ts): a sheet the owner threw away stops working. The streams those
 * sessions opened end with them.
 */
test('new recovery codes, or the set revoked, end the streams the old ones signed in', async () => {
  const fixture = await createCompany('live-recovery');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const made = await api.call('POST', '/api/mfa/recovery-codes', owner, { proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const signedIn = await api.call('POST', '/api/auth/sign-in', '', { recovery: made.body.codes[0] });
    assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
    const byRecovery = await openLive(api, fixture, String(signedIn.body.token));
    const byDevice = await openLive(api, fixture, owner);
    const again = await api.call('POST', '/api/mfa/recovery-codes', owner, { proof: { totp: api.code() } });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await endsSoon(byRecovery, 'the stream a thrown-away recovery code signed in');
    const task = await rootTask(fixture, 'Still heard by the device');
    await until(() => byDevice.heard.some((one) => one.taskId === task.id), "the device session's stream to hear the next event");

    // Revoking the new set as an authenticator, named in capitals, ends the streams it signed in the same way.
    const again2 = await api.call('POST', '/api/auth/sign-in', '', { recovery: again.body.codes[0] });
    assert.equal(again2.status, 200, JSON.stringify(again2.body));
    const bySecondSet = await openLive(api, fixture, String(again2.body.token));
    const listed = await api.call('GET', '/api/mfa/authenticators', owner);
    const recovery = (listed.body.authenticators as Array<{ id: string; kind: string }>).find((one) => one.kind === 'recovery')!;
    const revoked = await api.call('POST', `/api/mfa/authenticators/${recovery.id.toUpperCase()}/revoke`, owner, { proof: { totp: api.code() } });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    await endsSoon(bySecondSet, 'the stream a revoked recovery set signed in');
  } finally {
    await api.close();
  }
});
