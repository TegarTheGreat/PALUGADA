/**
 * Everything the company produced, in one place (the analysis of 3 October,
 * §9 P1 item 12).
 *
 * A document a role wrote or an email it sent was reachable only by opening
 * the task that made it, and finding a draft from last week meant knowing
 * which task it was. Paperclip keeps a gallery of every artifact. The
 * gallery lists what the company's tasks committed for a person to read,
 * newest first, each with who wrote it and the task it came from.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function task(fixture: Fixture, roleId: string, goal: string): Promise<string> {
  return (await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal }, createdBy: 'owner', reserveTokens: 1_000,
  })).id;
}

/** A step of the task's journal, as the engine writes one. */
async function step(fixture: Fixture, taskId: string, index: number, name: string, output: Record<string, unknown> | null,
  options: { status?: 'committed' | 'started'; minutesAgo?: number } = {}): Promise<void> {
  const status = options.status ?? 'committed';
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO task_steps (task_id, step_index, company_id, name, kind, status, input_hash, idempotency_key, output, committed_at)
     VALUES ($1::uuid, $2::int, $3, $4, 'tool', $5::text, 'h', $1::text || ':' || $2::text, $6,
             CASE WHEN $5::text = 'committed' THEN now() - make_interval(mins => $7) END)`,
    [taskId, index, fixture.companyId, name, status, output === null ? null : JSON.stringify(output), options.minutesAgo ?? 0]));
}

test('the gallery lists what the company produced, newest first, with who wrote it and its task', async () => {
  const fixture = await createCompany('gallery');
  const other = await createCompany('gallery-other');
  const writer = await addRole(fixture, 'writer');
  await withControlPlane((tx) => tx.query("UPDATE roles SET display_name = 'Gilang' WHERE id = $1", [writer]));

  const letter = await task(fixture, writer, 'Tulis newsletter Oktober');
  await step(fixture, letter, 0, 'capability:doc.draft',
    { path: 'drafts/newsletter.md', text: '# Newsletter Oktober\n\nHalo pelanggan setia, bulan ini kopi susu gula aren diskon 20%.', words: 14 },
    { minutesAgo: 30 });
  await step(fixture, letter, 1, 'capability:email.send',
    { path: 'outbox/promo.eml', subject: 'Promo kopi Oktober', body: 'Halo Ana, ada diskon untukmu.', to: 'ana@example.test' },
    { minutesAgo: 10 });
  // Not something to read: a draft that did not commit, and a step with no document.
  await step(fixture, letter, 2, 'capability:doc.draft', null, { status: 'started' });
  await step(fixture, letter, 3, 'capability:web.fetch', { status: 200, text: 'the page' }, { minutesAgo: 5 });

  const stock = await task(fixture, fixture.roleId, 'Periksa stok biji kopi');
  await step(fixture, stock, 0, 'capability:doc.draft', { path: 'drafts/stok.md', text: 'Stok cukup sampai 12 Oktober.' }, { minutesAgo: 60 });

  // Another company's work is never in this one's gallery.
  const theirs = await task(other, other.roleId, 'Their plan');
  await step(other, theirs, 0, 'capability:doc.draft', { path: 'drafts/theirs.md', text: 'Not yours.' }, { minutesAgo: 1 });

  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const page = async (query = '') => {
      const answer = await api.call('GET', `/api/companies/${fixture.companyId}/gallery${query}`, token);
      assert.equal(answer.status, 200, JSON.stringify(answer.body));
      return answer.body as { items: Array<Record<string, unknown>>; next: string | null };
    };

    const all = await page();
    assert.deepEqual(all.items.map((item) => [item.title, item.taskId, item.step]), [
      ['Promo kopi Oktober', letter, 1],
      ['Newsletter Oktober', letter, 0],
      ['stok.md', stock, 0],
    ]);
    assert.equal(all.next, null);
    const [mail, newsletter] = all.items;
    assert.deepEqual(
      [mail!.capability, mail!.to, mail!.roleName, mail!.task, mail!.excerpt],
      ['email.send', 'ana@example.test', 'Gilang', 'Tulis newsletter Oktober', 'Halo Ana, ada diskon untukmu.'],
    );
    assert.equal(newsletter!.words, 14);
    assert.doesNotMatch(String(newsletter!.excerpt), /^#/, 'the excerpt is what it says, not its heading mark');

    // A page at a time, and the next page goes on from the last one shown.
    const first = await page('?limit=2');
    assert.equal(first.items.length, 2);
    assert.ok(first.next);
    const second = await page(`?limit=2&before=${encodeURIComponent(first.next!)}`);
    assert.deepEqual(second.items.map((item) => item.title), ['stok.md']);
    assert.equal(second.next, null);

    assert.equal((await api.call('GET', `/api/companies/${fixture.companyId}/gallery?before=nonsense`, token)).status, 400);
  } finally {
    await api.close();
  }
});
