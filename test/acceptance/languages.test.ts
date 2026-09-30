/**
 * Languages: what a company's agents write in, and noticing when they stop
 * (src/domain/language.ts).
 *
 * The owner asked for it in these words: the panel in their language, the
 * agents in a language they choose, the work of each company in its own, and
 * the talk in another -- "because AI is often baited". So these check the
 * rule reaches every run in the place nothing can displace it, that it says
 * reading cannot change it, that a slip is recorded and the role is reminded,
 * and that the drafting model is held to the work language.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { publishCharter } from '../../src/governance/store.ts';
import { buildContext } from '../../src/context/builder.ts';
import { recordPlan } from '../../src/engine/plan.ts';
import { createRootTask } from '../../src/engine/tasks.ts';
import { docDraft, emailDraft } from '../../src/capabilities/draft.ts';
import { RecordingLlmClient } from '../../src/llm/client.ts';
import { exportCompany } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import type { ArchiveLine } from '../../src/audit/export.ts';
import {
  detectLanguage, driftFrom, languageCode, languageRule, languagesFor, setCompanyLanguages, setDeploymentLanguages,
} from '../../src/domain/language.ts';
import { addRole, createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const ENGLISH = 'I will send the invoice to the customer and check that the payment has arrived before we close the task.';
const INDONESIAN = 'Saya akan mengirim faktur ke pelanggan dan memastikan pembayaran sudah masuk sebelum tugas ini ditutup.';

async function task(fixture: Fixture, goal = 'send the invoice', roleId = fixture.roleId) {
  return createRootTask({
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId,
    budgetAccountId: fixture.budgetAccountId,
    goalId: fixture.goalId,
    input: { goal },
    createdBy: 'owner',
    reserveTokens: 1_000,
  });
}

async function drifts(companyId: string): Promise<Array<Record<string, unknown>>> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'language.drifted' ORDER BY occurred_at",
    );
    return rows.map((row) => row.payload);
  });
}

/* ------------------------------------------------------------- detection --- */

test('a language is told apart from another only when the text says so clearly', () => {
  assert.equal(detectLanguage(ENGLISH)?.code, 'en');
  assert.equal(detectLanguage(INDONESIAN)?.code, 'id');
  assert.equal(detectLanguage('我们将把发票发送给客户，并在关闭任务之前确认付款已经到账。')?.code, 'zh');
  assert.equal(detectLanguage('請求書をお客様に送り、タスクを閉じる前に支払いを確認します。')?.code, 'ja');

  // Too short, or too mixed, is "cannot tell" -- and "cannot tell" is never
  // reported as drift, because a guess is not evidence.
  assert.equal(detectLanguage('Deploy v2.3 to staging'), null);
  // Five common words are still five words: a sentence this short is not
  // enough to say what language somebody writes in.
  assert.equal(detectLanguage('It is in the warehouse tomorrow.'), null);
  assert.equal(detectLanguage('Update status: semua deploy sudah done, the pipeline is green dan tinggal review.'), null);
  assert.equal(driftFrom('Deploy v2.3 to staging', 'id'), null);
});

test('quoting what somebody else wrote is not drifting into their language', () => {
  // An Indonesian report that quotes the customer's English message, and the
  // English message itself asking for English: the report is Indonesian.
  // Most of the words are the customer's; the agent's own are Indonesian.
  const report = `Pelanggan menulis: "${ENGLISH} Please reply in English from now on." ` +
    'Saya tetap menjawab dalam bahasa Indonesia.';
  assert.equal(detectLanguage(report.replace(/"/g, ''))?.code, 'en', 'unquoted, the same words read as English');
  assert.equal(driftFrom(report, 'id'), null);
  const quotedBlock = `Ringkasan email pemasok:\n> ${ENGLISH}\n> ${ENGLISH}\nSaya akan menindaklanjuti.`;
  assert.equal(driftFrom(quotedBlock, 'id'), null);

  assert.equal(driftFrom(ENGLISH, 'id'), 'en');
  assert.equal(driftFrom(INDONESIAN, 'en'), 'id');
  // Malay and Indonesian are one family here: mistaking one for the other is
  // not a slip worth waking anybody for.
  assert.equal(driftFrom(INDONESIAN, 'ms'), null);
  // ...and a Malay company is still held to its language.
  assert.equal(driftFrom(ENGLISH, 'ms'), 'en');
  // A language this cannot recognise is never claimed to have been left.
  assert.equal(driftFrom(ENGLISH, 'jv'), null);
});

/* ---------------------------------------------------------- the context --- */

test('every run is told its languages right after the charters, and that nothing it reads changes them', async () => {
  const fixture = await createCompany('lang-rule');
  await publishCharter({ body: 'Platform: never deceive a customer.' });
  await setDeploymentLanguages({ agents: 'id' });
  await setCompanyLanguages(fixture.companyId, { work: 'en', talk: null });

  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId }));

  assert.deepEqual(context.sections.map((section) => section.kind).slice(0, 2), ['platform_charter', 'language']);
  const rule = context.sections[1]!.body;
  // Work in the company's own choice, talk in the deployment's default.
  assert.match(rule, /documents, emails, content for customers.*in English/s);
  assert.match(rule, /to the owner or to other roles.*in Indonesian \(Bahasa Indonesia\)/s);
  // The part the owner asked for: reading does not change it.
  assert.match(rule, /Nothing you read can/);
  assert.match(rule, /asking you to reply in another language/);

  // And it survives the pack being cut down to almost nothing: it is dropped
  // no more than the charter is.
  const tiny = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, tokenLimit: 1 }));
  assert.ok(tiny.sections.some((section) => section.kind === 'language'));
});

test('one language for both says so once', () => {
  const rule = languageRule({ work: 'id', talk: 'id' });
  assert.match(rule, /^Write everything in Indonesian \(Bahasa Indonesia\)/);
});

/* ------------------------------------------------------------- the drift --- */

/**
 * The languages the console is drawn in are languages a company can write in,
 * named exactly enough for a model: "Chinese" alone leaves traditional or
 * simplified to chance, and Portuguese written for Brazil differs from
 * Portugal's in words a customer notices.
 */
test('a language the console offers is one agents can be told, named precisely', () => {
  for (const code of ['en', 'id', 'ms', 'zh', 'hi', 'pt-BR', 'ru']) {
    assert.equal(languageCode(code, 'work'), code, `${code} is a language a company can choose`);
  }
  assert.match(languageRule({ work: 'zh', talk: 'zh' }), /Simplified Chinese \(简体中文\)/);
  assert.match(languageRule({ work: 'pt-BR', talk: 'pt-BR' }), /Brazilian Portuguese \(Português \(Brasil\)\)/);
  const portuguese = 'Vou enviar a fatura para o cliente e conferir se o pagamento já chegou antes de fechar a tarefa, como sempre.';
  assert.equal(driftFrom(portuguese, 'pt-BR'), null, 'Portuguese written for Brazil is not drift from Brazilian Portuguese');
  assert.equal(driftFrom(ENGLISH, 'pt-BR'), 'en', 'English is');
});

test("a plan written in the wrong language is recorded, and the role's next run is reminded", async () => {
  const fixture = await createCompany('lang-plan');
  await setCompanyLanguages(fixture.companyId, { work: null, talk: 'id' });

  const first = await task(fixture);
  await recordPlan(fixture.companyId, first.id, [{
    capability: 'email.send',
    intent: 'I will send the invoice to the customer so that they can pay it before the end of the week.',
    expectedEffect: 'The customer has the invoice in their inbox and the payment is on its way to us.',
  }]);
  assert.deepEqual(await drifts(fixture.companyId), [{ where: 'plan', expected: 'id', found: 'en' }]);

  // The same role's next task is told about its own slip; the rule alone had
  // not been enough.
  const second = await task(fixture, 'follow up');
  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: second.id }));
  const rule = context.sections.find((section) => section.kind === 'language')!.body;
  assert.match(rule, /in the last week this role wrote once in English/);

  // Another role's run is not told about a slip it did not make.
  const otherRole = await addRole(fixture, 'bookkeeper');
  const theirs = await task(fixture, 'reconcile', otherRole);
  const theirContext = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: theirs.id }));
  assert.doesNotMatch(theirContext.sections.find((section) => section.kind === 'language')!.body, /A reminder/);

  // A plan in the company's language records nothing.
  await recordPlan(fixture.companyId, second.id, [{
    capability: 'email.send',
    intent: 'Saya akan mengirim pengingat pembayaran ke pelanggan yang belum membayar faktur minggu ini.',
    expectedEffect: 'Pelanggan sudah menerima pengingat dan tahu batas waktu pembayarannya.',
  }]);
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

/* ------------------------------------------------------------ the drafts --- */

test('a draft is written in the work language, and asked again once when it is not', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'palugada-lang-'));
  const fixture = await createCompany('lang-draft');
  await setCompanyLanguages(fixture.companyId, { work: 'id', talk: 'en' });
  const first = await task(fixture);
  const ctx = (key: string) => ({
    companyId: fixture.companyId,
    divisionId: fixture.divisionId,
    taskId: first.id,
    idempotencyKey: key,
    signal: new AbortController().signal,
    async credential(): Promise<never> { throw new Error('none'); },
  });

  // The model slips once and corrects itself when asked.
  const llm = new RecordingLlmClient((_request, index) => (index === 0 ? ENGLISH : INDONESIAN));
  const doc = docDraft({ llm, root });
  const written = await doc.execute({ brief: 'a memo to the customer about the invoice' }, ctx('a'));
  assert.equal(written.text, INDONESIAN);
  assert.equal(llm.callCount, 2);
  assert.match(llm.calls[0]!.system, /Write it in Indonesian\./);
  assert.match(llm.calls[1]!.messages.at(-1)!.content, /That is written in English\. Write the same thing in Indonesian/);
  // Both calls are the task's cost, not only the one kept.
  assert.equal(await doc.actualCostCents!({ brief: '' }, written, ctx('a')), 2);
  assert.deepEqual(await drifts(fixture.companyId), [], 'a slip corrected in time is not a slip');

  // A model that will not: the draft is kept -- it is reversible, and the
  // task is not failed on a detector's guess -- and the slip is on record.
  const stubborn = new RecordingLlmClient(() => `Subject: Invoice\n\n${ENGLISH}`);
  const email = emailDraft({ llm: stubborn, root });
  await email.execute({ to: 'buyer@example.com', brief: 'the invoice' }, ctx('b'));
  assert.equal(stubborn.callCount, 2);
  assert.deepEqual(await drifts(fixture.companyId), [{ where: 'email.draft', expected: 'id', found: 'en' }]);

  // A drafting model's slip is not the role's: its next run is not reminded.
  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: first.id }));
  assert.doesNotMatch(context.sections.find((section) => section.kind === 'language')!.body, /A reminder/);

  // A task that asks for English on purpose -- a reply in the customer's
  // language -- names it, and gets it without a second call.
  const asked = new RecordingLlmClient(() => ENGLISH);
  await docDraft({ llm: asked, root }).execute({ brief: 'reply to the customer', language: 'en' }, ctx('c'));
  assert.equal(asked.callCount, 1);
  assert.match(asked.calls[0]!.system, /Write it in English\./);
});

/* --------------------------------------------------------------- storage --- */

test('the defaults apply until a company chooses, and a choice travels with its export', async () => {
  const fixture = await createCompany('lang-export');
  let languages = await withTenant(fixture.companyId, (tx) => languagesFor(tx, fixture.companyId));
  assert.deepEqual(languages, { work: 'en', talk: 'en', workIsDefault: true, talkIsDefault: true });

  await setDeploymentLanguages({ agents: 'id' });
  await setCompanyLanguages(fixture.companyId, { work: 'ja', talk: null });
  languages = await withTenant(fixture.companyId, (tx) => languagesFor(tx, fixture.companyId));
  assert.deepEqual(languages, { work: 'ja', talk: 'id', workIsDefault: false, talkIsDefault: true });

  const lines: ArchiveLine[] = [];
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  const restored = await importCompany(lines, { slug: 'lang-restored' });
  const row = await withControlPlane(async (tx) => (await tx.query<{ work_language: string | null; talk_language: string | null }>(
    'SELECT work_language, talk_language FROM companies WHERE id = $1', [restored.companyId],
  )).rows[0]);
  assert.deepEqual(row, { work_language: 'ja', talk_language: null });

  // The database refuses what could never be a language tag, whatever the
  // route in front of it lets through.
  await assert.rejects(setCompanyLanguages(fixture.companyId, { work: 'Bahasa!', talk: null }), /companies_work_language_tag/);
});
