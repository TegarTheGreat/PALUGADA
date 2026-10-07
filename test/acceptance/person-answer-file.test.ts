/**
 * A person is an actor (the audit of 6 October, §8.2, P1.1; STATUS 2.173):
 * the second step, an answer that carries a file.
 *
 * An answer was a string. A person asked for an invoice, a price list or a
 * photo of a receipt can only send it, and a run that asked "what is the
 * supplier's price?" needs the supplier's document, not the person's
 * description of it. An answer now carries up to five files, kept under
 * `received/answers/` by what their bytes are (as a customer's attachment is:
 * the person names nothing but the display name, and a program is not kept),
 * and the run that asked is told where they are.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { ownerAskCapability } from '../../src/broker/platform-capabilities.ts';
import { buildContext } from '../../src/context/builder.ts';
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

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
const PROGRAM = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(200, 1)]);
const file = (name: string, bytes: Buffer) => ({ name, data: bytes.toString('base64') });

async function asking(options: { to?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'palugada-answer-files-'));
  const fixture = await createCompany('answer-file');
  const api = await consoleWithSettings({ files: { root } });
  const owner = await api.signIn();
  const budi = await approver(api, owner, fixture, 'Budi');
  const siti = await approver(api, owner, fixture, 'Siti');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Cek harga gula' }, createdBy: 'owner', reserveTokens: 100,
  });
  await transition(fixture.companyId, task.id, 'running');
  const context = { companyId: fixture.companyId, taskId: task.id, divisionId: fixture.divisionId, roleId: fixture.roleId } as never;
  const input = { question: 'Mana faktur gula dari pemasok?', ...(options.to ? { to: options.to } : {}) };
  await assert.rejects(ownerAskCapability().execute(input as never, context), (error: unknown) => (error as { code?: string }).code === 'owner.asked');
  const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>(
    "SELECT id FROM inbox_items WHERE task_id = $1 AND kind = 'escalation' AND status = 'open'", [task.id]));
  const itemId = rows[0]!.id;
  const answer = (token: string, body: Record<string, unknown>) => api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/answer`, token, body);
  const reread = () => ownerAskCapability().execute(input as never, context);
  const stored = () => withTenant(fixture.companyId, (tx) => tx.query<{ status: string; answer_files: Array<{ kind: string; name: string | null; path: string; bytes: number }> }>(
    'SELECT status, answer_files FROM inbox_items WHERE id = $1', [itemId])).then((result) => result.rows[0]!);
  return { root, fixture, api, owner, budi, siti, task, itemId, answer, reread, stored };
}

test('a person answers with a file: it is kept where the run can read it, and the run is told where', async () => {
  const { api, fixture, root, budi, task, answer, reread, stored } = await asking({ to: 'Budi' });
  try {
    const sent = await answer(budi.token, { answer: 'Ini fakturnya.', files: [file('Faktur Gula (final).pdf', PDF)] });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const item = await stored();
    assert.equal(item.status, 'decided');
    assert.equal(item.answer_files.length, 1);
    const [kept] = item.answer_files;
    assert.equal(kept!.kind, 'pdf');
    assert.equal(kept!.name, 'Faktur-Gula-(final).pdf', 'what the person called it is shown, made plain, and not used');
    assert.equal(kept!.bytes, PDF.length);
    assert.match(kept!.path, /^received\/answers\/\d{4}-\d{2}\/[0-9a-f]{8}-1\.pdf$/);
    assert.deepEqual(await readFile(join(root, fixture.companyId, kept!.path)), PDF);

    // The run that asked is given the answer and where the file is.
    const told = await reread();
    assert.equal(told.answered, true);
    assert.match(String(told.answer), /^Ini fakturnya\./);
    assert.ok(String(told.answer).includes(kept!.path), 'the answer says where the file is');
    assert.deepEqual(told.files, [{ kind: 'pdf', name: 'Faktur-Gula-(final).pdf', path: kept!.path }]);

    // And a run resumed after the answer starts from it.
    const context = await withTenant(fixture.companyId, (tx) => buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: task.id }));
    const section = context.sections.find((one) => one.title === 'The owner answered your question');
    assert.ok(section);
    assert.ok(section.body.includes(kept!.path), 'the context says where the file is');
    assert.match(section.body, /Budi answered: Ini fakturnya\./, 'and who answered: not the owner');
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => inbox.answersFor(tx, task.id)), [{
      question: 'Mana faktur gula dari pemasok?', answer: 'Ini fakturnya.', by: 'Budi',
      files: [{ kind: 'pdf', name: 'Faktur-Gula-(final).pdf', path: kept!.path, bytes: PDF.length }],
    }]);
  } finally {
    await api.close();
  }
});

test('a file that is not kept refuses the whole answer, and the question stays open and nothing is written', async () => {
  const { api, fixture, root, owner, siti, answer, stored } = await asking({ to: 'Budi' });
  try {
    const refused = await answer(owner, { answer: 'Ini.', files: [file('faktur.pdf', PDF), file('faktur.exe', PROGRAM)] });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(String(refused.body.error), /faktur\.exe/);
    assert.equal((await stored()).status, 'open');
    assert.deepEqual(await readdir(join(root, fixture.companyId)).catch(() => []), [], 'the good one was not written either');

    const many = await answer(owner, { answer: 'Ini.', files: Array.from({ length: 6 }, (_, i) => file(`f${i}.pdf`, PDF)) });
    assert.equal(many.status, 400);
    assert.match(String(many.body.error), /at most 5/);
    const garbled = await answer(owner, { answer: 'Ini.', files: [{ name: 'a.pdf', data: '%%%%' }] });
    assert.equal(garbled.status, 400);
    const unnamed = await answer(owner, { answer: 'Ini.', files: [{ data: PDF.toString('base64') }] });
    assert.equal(unnamed.status, 400);
    assert.equal((await stored()).status, 'open');

    // Another person's question is not answered with files either, and writes nothing.
    const notYours = await answer(siti.token, { answer: 'Ini.', files: [file('faktur.pdf', PDF)] });
    assert.equal(notYours.status, 403, JSON.stringify(notYours.body));
    assert.deepEqual(await readdir(join(root, fixture.companyId)).catch(() => []), []);

    // Without files it is the answer it always was; the owner may also send one.
    const plain = await answer(owner, { answer: 'Tidak ada fakturnya.' });
    assert.equal(plain.status, 200, JSON.stringify(plain.body));
    assert.deepEqual((await stored()).answer_files, []);
  } finally {
    await api.close();
  }
});

test('only the answer to a question a run asked carries files; an escalation about live work does not', async () => {
  const { api, fixture, root, owner, task } = await asking();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId, taskId: task.id, title: 'Review deadlocked after 2 revisions: email.send', detail: 'Proposer and reviewer did not converge.',
    });
    const sent = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${itemId}/answer`, owner, { answer: 'Ini.', files: [file('faktur.pdf', PDF)] });
    assert.equal(sent.status, 400, JSON.stringify(sent.body));
    assert.match(String(sent.body.error), /answer to a question a run asked/);
    assert.deepEqual(await readdir(join(root, fixture.companyId)).catch(() => []), []);
  } finally {
    await api.close();
  }
});

test('a deployment that keeps no files says so, and does not drop the file on the floor', async () => {
  const fixture = await createCompany('answer-file-none');
  const api = await consoleWithSettings();
  try {
    const owner = await api.signIn();
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
      goalId: fixture.goalId, input: { goal: 'x' }, createdBy: 'owner', reserveTokens: 100,
    });
    await transition(fixture.companyId, task.id, 'running');
    await assert.rejects(ownerAskCapability().execute({ question: 'Mana fakturnya?' } as never,
      { companyId: fixture.companyId, taskId: task.id, divisionId: fixture.divisionId, roleId: fixture.roleId } as never),
    (error: unknown) => (error as { code?: string }).code === 'owner.asked');
    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ id: string }>("SELECT id FROM inbox_items WHERE task_id = $1 AND status = 'open'", [task.id]));
    const sent = await api.call('POST', `/api/companies/${fixture.companyId}/inbox/${rows[0]!.id}/answer`, owner, { answer: 'Ini.', files: [file('faktur.pdf', PDF)] });
    assert.equal(sent.status, 400, JSON.stringify(sent.body));
    assert.match(String(sent.body.error), /keeps no files/);
    assert.equal((await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>('SELECT status FROM inbox_items WHERE id = $1', [rows[0]!.id]))).rows[0]!.status, 'open');
  } finally {
    await api.close();
  }
});
