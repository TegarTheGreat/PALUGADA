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
