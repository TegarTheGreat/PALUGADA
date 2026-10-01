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
import { isPalugadaError } from '../../src/errors.ts';
import { publishCharter } from '../../src/governance/store.ts';
import { buildContext } from '../../src/context/builder.ts';
import { recordPlan } from '../../src/engine/plan.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { Engine } from '../../src/engine/engine.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import {
  goalProposeCapability, ownerAskCapability, stageProposeCapability, taskDelegateCapability, ticketCreateCapability,
} from '../../src/broker/platform-capabilities.ts';
import { fingerprintAction, openReview, settleCompletedReviews } from '../../src/review/review.ts';
import { setStage } from '../../src/domain/stage.ts';
import { docDraft, emailDraft } from '../../src/capabilities/draft.ts';
import { RecordingLlmClient, type LlmTurn, type LlmTurnRequest, type ToolUsingLlmClient } from '../../src/llm/client.ts';
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
  // Every language a company can choose is one it recognises now, so the
  // case is a code from outside the list.
  assert.equal(driftFrom(ENGLISH, 'sw'), null);
});

/*
 * Javanese and Sundanese, as an agent of a shop in Yogyakarta or Bandung
 * would write to its owner: the same report in Javanese's everyday (ngoko)
 * and polite (krama) registers, Sundanese's everyday (loma) and polite
 * (lemes) ones, Indonesian and Malay. The polite registers borrow from each
 * other -- kedah, sareng, nanging, manawi are Sundanese and Javanese both --
 * which is why the words that tell them apart are chosen with care.
 */
const JAVANESE = 'Aku wis ngirim tagihan menyang pelanggan, nanging dheweke durung mbayar. Yen sesuk isih ' +
  'durung ana pembayaran, aku arep ngirim pangeling maneh lan nelpon dheweke.';
const JAVANESE_KRAMA = 'Kula sampun ngintunaken tagihan dhateng pelanggan, nanging piyambakipun dereng mbayar. ' +
  'Menawi benjing taksih dereng wonten pembayaran, kula badhe ngintun pangeling kaliyan nelpon piyambakipun.';
const SUNDANESE = 'Urang geus ngirim tagihan ka palanggan, tapi manéhna can mayar. Lamun isukan teu aya ' +
  'pamayaran kénéh, urang rék ngirim deui panginget jeung nelepon manéhna.';
const SUNDANESE_LEMES = 'Abdi parantos ngintunkeun tagihan ka palanggan, nanging anjeunna teu acan mayar. Upami ' +
  'énjing teu acan aya pamayaran, abdi badé ngintunkeun deui panginget sareng nelepon anjeunna.';
const MALAY = 'Saya telah menghantar invois kepada pelanggan, tetapi mereka belum membuat bayaran. Jika esok ' +
  'masih tiada bayaran, saya akan menghantar peringatan dan menelefon mereka.';

test('Javanese and Sundanese are told apart from Indonesian and Malay, and from each other', () => {
  for (const [text, code] of [
    [JAVANESE, 'jv'], [JAVANESE_KRAMA, 'jv'], [SUNDANESE, 'su'], [SUNDANESE_LEMES, 'su'],
    [INDONESIAN, 'id'], [MALAY, 'id'],
  ] as const) {
    assert.equal(detectLanguage(text)?.code, code, text);
  }

  // A company that talks in Javanese or Sundanese is held to it now.
  assert.equal(driftFrom(INDONESIAN, 'jv'), 'id');
  assert.equal(driftFrom(INDONESIAN, 'su'), 'id');
  assert.equal(driftFrom(MALAY, 'jv'), 'id');
  assert.equal(driftFrom(ENGLISH, 'su'), 'en');
  assert.equal(driftFrom(SUNDANESE_LEMES, 'jv'), 'su');
  assert.equal(driftFrom(JAVANESE_KRAMA, 'su'), 'jv');
  assert.equal(driftFrom(JAVANESE, 'jv'), null);
  assert.equal(driftFrom(SUNDANESE_LEMES, 'su'), null);
  // ...and so is one that talks in Indonesian or Malay.
  assert.equal(driftFrom(JAVANESE, 'id'), 'jv');
  assert.equal(driftFrom(SUNDANESE, 'ms'), 'su');
  assert.equal(driftFrom(MALAY, 'id'), null, 'Malay is still Indonesian\'s family');

  // Indonesian that an Indonesian company actually writes is never taken for
  // either: a tea shop's "teh", logistics' "ETA", a Javanese name.
  for (const indonesian of [
    'Stok teh hijau sudah habis dan ETA pengiriman dari pemasok adalah hari Jumat, jadi saya akan memberi tahu ' +
      'pelanggan yang sudah memesan teh itu.',
    'Pak Slamet dari Sleman sudah setuju dengan harga baru, tetapi dia ingin pengiriman dilakukan setiap hari ' +
      'Senin agar tokonya tidak kehabisan stok.',
    'Kami sudah mengirim tagihan ke pelanggan, tetapi pembayarannya belum masuk. Jika besok masih belum ada ' +
      'pembayaran, saya akan mengirim pengingat dan menelepon mereka.',
  ]) {
    assert.equal(detectLanguage(indonesian)?.code, 'id', indonesian);
    assert.equal(driftFrom(indonesian, 'id'), null, indonesian);
  }

  // Short, or a mixture, is "not sure" -- in either direction.
  assert.equal(detectLanguage('Kula sampun ngintun tagihan.'), null);
  assert.equal(detectLanguage('Abdi teu acan nampi pamayaran.'), null);
  const mixed = [
    // Javanese and Indonesian, as people in Surabaya write a chat.
    'Aku wis kirim tagihan ke pelanggan, tapi dia belum bayar, dadi sesuk aku arep cek lagi lan telpon, ' +
      'karena saya harus tahu kapan uangnya masuk.',
    // Sundanese and Indonesian.
    'Abdi parantos kirim tagihan ke pelanggan, tapi anjeunna belum bayar, jadi abdi teu acan tiasa menutup ' +
      'tugas ini sampai uangnya masuk.',
    // Javanese and Sundanese.
    'Kula sampun ngintun tagihan, abdi teu acan nampi pamayaran, menawi benjing dereng wonten, urang badé ' +
      'nelepon deui.',
  ];
  for (const text of mixed) {
    assert.equal(detectLanguage(text), null, text);
    for (const expected of ['id', 'jv', 'su']) assert.equal(driftFrom(text, expected), null, `${expected}: ${text}`);
  }
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

/* ------------------------------------------- everything else it writes --- */

/*
 * The plan was one thing an agent writes to the owner. These are the rest:
 * each, written in English for a company that talks in Indonesian, is one
 * slip that names where it was; the same written in Indonesian is none; and
 * the same text met twice -- a run resumed, replaying its call -- is still
 * one.
 */

async function talkingIndonesian(slug: string): Promise<Fixture> {
  const fixture = await createCompany(slug);
  await setCompanyLanguages(fixture.companyId, { work: null, talk: 'id' });
  return fixture;
}

async function running(fixture: Fixture, goal = 'look after the invoices', roleId = fixture.roleId) {
  const started = await task(fixture, goal, roleId);
  await transition(fixture.companyId, started.id, 'running');
  return started;
}

function capabilityContext(fixture: Fixture, taskId: string, key = 'k1') {
  return {
    companyId: fixture.companyId,
    projectId: fixture.projectId,
    divisionId: fixture.divisionId,
    roleId: fixture.roleId,
    taskId,
    idempotencyKey: key,
    signal: new AbortController().signal,
    async credential(): Promise<never> { throw new Error('none'); },
  } as never;
}

const asked = (error: unknown) => isPalugadaError(error, 'owner.asked');
const slip = (where: string) => ({ where, expected: 'id', found: 'en' });

test('a question to the owner is checked once, with what depends on it', async () => {
  const fixture = await talkingIndonesian('lang-ask');
  const ask = ownerAskCapability();
  const first = await running(fixture);
  const question = {
    question: 'Should I send the invoice to the customer now, or wait until they have confirmed the order?',
    why: 'The customer has not answered our last email and the order is still open.',
  };
  await assert.rejects(ask.execute(question, capabilityContext(fixture, first.id)), asked);
  assert.deepEqual(await drifts(fixture.companyId), [slip('question')]);
  // Asked again by the run that resumes: the same question, the same slip.
  await assert.rejects(ask.execute(question, capabilityContext(fixture, first.id, 'k2')), asked);
  assert.equal((await drifts(fixture.companyId)).length, 1);

  const second = await running(fixture, 'the next invoice');
  await assert.rejects(ask.execute({
    question: 'Apakah saya kirim tagihan ini ke pelanggan sekarang, atau saya tunggu sampai pesanan mereka sudah dikonfirmasi?',
    options: ['Kirim sekarang', 'Tunggu konfirmasi'],
  }, capabilityContext(fixture, second.id)), asked);
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

/** A model that answers each turn from a list, as a run of the role would. */
class ScriptedModel implements ToolUsingLlmClient {
  readonly #answers: Array<Record<string, unknown>>;
  #turns = 0;

  constructor(answers: Array<Record<string, unknown>>) {
    this.#answers = answers;
  }

  async turn(_request: LlmTurnRequest): Promise<LlmTurn> {
    const answer = this.#answers[this.#turns++];
    if (!answer) throw new Error(`the script has no answer ${this.#turns}`);
    return {
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` }],
      stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, costCents: 1, model: 'scripted-1',
    };
  }

  async complete(): Promise<never> {
    throw new Error('not used');
  }
}

test('the summary finished work reports is checked once, when a model wrote it', async () => {
  const fixture = await talkingIndonesian('lang-summary');
  const done = [{ criterion: 'the run returns an output matching its schema', met: true, evidence: 'the output is an object' }];
  const engine = (llm: ToolUsingLlmClient, handlers = new Map()) =>
    new Engine({ broker: new CapabilityBroker(new CapabilityRegistry()), workerId: 'lang-worker', llm, handlers });

  const english = await task(fixture, 'close the order');
  const ran = await engine(new ScriptedModel([{
    summary: 'The invoice was sent to the customer and the payment has arrived, so the order is closed.', done,
  }])).runTask(fixture.companyId, english.id, 'worker');
  assert.equal(ran.status, 'completed', ran.reason);
  assert.deepEqual(await drifts(fixture.companyId), [slip('summary')]);

  const indonesian = await task(fixture, 'close the next order');
  const right = await engine(new ScriptedModel([{
    summary: 'Tagihan sudah dikirim ke pelanggan dan pembayarannya sudah masuk, jadi pesanan ini sudah ditutup.', done,
  }])).runTask(fixture.companyId, indonesian.id, 'worker');
  assert.equal(right.status, 'completed', right.reason);
  assert.equal((await drifts(fixture.companyId)).length, 1);

  // A handler the deployment registered writes its author's words, checked by
  // its tests: there is no model to remind.
  const byCode = await task(fixture, 'close a third order');
  const handlers = new Map([['worker', async () => ({
    summary: 'The invoice was sent to the customer and the payment has arrived, so the order is closed.',
  })]]);
  assert.equal((await engine(new ScriptedModel([]), handlers).runTask(fixture.companyId, byCode.id, 'worker')).status, 'completed');
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

test('a brief handed to another role is checked once', async () => {
  const fixture = await talkingIndonesian('lang-handoff');
  await addRole(fixture, 'bookkeeper');
  const delegate = taskDelegateCapability();
  const parent = await running(fixture);
  const english = {
    role: 'bookkeeper',
    brief: 'Reconcile the payments that arrived this week with the invoices we sent, and tell me which of them are still open.',
  };
  const child = await delegate.execute(english, capabilityContext(fixture, parent.id));
  assert.deepEqual(await drifts(fixture.companyId), [slip('handoff')]);
  // The same delegation replayed is the child it already started, and no second slip.
  assert.equal((await delegate.execute(english, capabilityContext(fixture, parent.id, 'k2'))).childId, child.childId);
  assert.equal((await drifts(fixture.companyId)).length, 1);

  await delegate.execute({
    role: 'bookkeeper',
    brief: 'Cocokkan pembayaran yang masuk minggu ini dengan tagihan yang sudah kami kirim, lalu laporkan mana yang belum lunas.',
  }, capabilityContext(fixture, parent.id, 'k3'));
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

test('a ticket a run files is checked once', async () => {
  const fixture = await talkingIndonesian('lang-ticket');
  const file = ticketCreateCapability();
  const filer = await running(fixture);
  const english = {
    title: 'Ask the supplier why the last two shipments were late',
    body: 'The coffee from the supplier arrived late twice this month, and we have to know whether it will happen again.',
  };
  const opened = await file.execute(english, capabilityContext(fixture, filer.id));
  assert.deepEqual(await drifts(fixture.companyId), [slip('ticket')]);
  // Filed again, it is the ticket already open.
  assert.equal((await file.execute(english, capabilityContext(fixture, filer.id, 'k2'))).ticketId, opened.ticketId);
  assert.equal((await drifts(fixture.companyId)).length, 1);

  await file.execute({
    title: 'Tanyakan ke pemasok kenapa dua pengiriman terakhir terlambat',
    body: 'Kopi dari pemasok datang terlambat dua kali bulan ini, dan kami perlu tahu apakah itu akan terjadi lagi.',
  }, capabilityContext(fixture, filer.id, 'k3'));
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

test('a proposal to change a goal, and one to move the stage, are checked once each', async () => {
  const fixture = await talkingIndonesian('lang-proposals');
  await setStage(fixture.companyId, 'validate');
  const strategist = await running(fixture, 'review the month');
  const goal = goalProposeCapability();
  const stage = stageProposeCapability();

  const goalCase = {
    goal: fixture.goalId, status: 'met' as const,
    why: 'Every customer has paid for their order this month, and the target we set for the quarter has already been reached.',
  };
  await goal.execute(goalCase, capabilityContext(fixture, strategist.id));
  // While the owner has not answered, a second proposal is not made, and not checked.
  assert.equal((await goal.execute(goalCase, capabilityContext(fixture, strategist.id, 'k2'))).proposed, false);
  const stageCase = {
    to: 'build',
    evidence: 'Twelve customers have paid for the first batch, and nine of them have ordered again this month.',
  };
  await stage.execute(stageCase, capabilityContext(fixture, strategist.id, 'k3'));
  assert.equal((await stage.execute(stageCase, capabilityContext(fixture, strategist.id, 'k4'))).proposed, false);
  assert.deepEqual(await drifts(fixture.companyId), [slip('goal_proposal'), slip('stage_proposal')]);

  const other = await talkingIndonesian('lang-proposals-id');
  await setStage(other.companyId, 'validate');
  const theirs = await running(other, 'review the month');
  await goal.execute({
    goal: other.goalId, status: 'met',
    why: 'Semua pelanggan sudah membayar pesanan mereka bulan ini, dan target yang kami tetapkan untuk kuartal ini sudah tercapai.',
  }, capabilityContext(other, theirs.id));
  await stage.execute({
    to: 'build',
    evidence: 'Dua belas pelanggan sudah membayar untuk batch pertama, dan sembilan dari mereka sudah memesan lagi bulan ini.',
  }, capabilityContext(other, theirs.id, 'k2'));
  assert.deepEqual(await drifts(other.companyId), []);
});

test("a reviewer's reasons are checked, and the slip is the reviewer's", async () => {
  const fixture = await talkingIndonesian('lang-review');
  const reviewerRoleId = await addRole(fixture, 'critic', {
    output: { type: 'object', required: ['decision', 'reason'], properties: { decision: {}, reason: { type: 'string' } } },
  });
  const proposer = await running(fixture, 'answer the customer');
  const proposal = { capability: 'email.send', input: { to: 'buyer@example.com', body: 'Refund approved.' } };
  const review = async (reason: string) => {
    const opened = await openReview({
      companyId: fixture.companyId, projectId: fixture.projectId, proposerTaskId: proposer.id,
      proposerRoleId: fixture.roleId, reviewerRoleSlug: 'critic', capabilityName: 'email.send',
      actionFingerprint: fingerprintAction('email.send', proposal.input), proposal,
      criteria: 'Is this message accurate and allowed by the refund policy?',
    });
    assert.equal(opened.outcome, 'pending');
    const reviewTaskId = (opened as { reviewTaskId: string }).reviewTaskId;
    await transition(fixture.companyId, reviewTaskId, 'running');
    await transition(fixture.companyId, reviewTaskId, 'completed', { output: { decision: 'revise', reason } });
    await settleCompletedReviews(fixture.companyId);
    return reviewTaskId;
  };

  const english = await review('The email promises a refund that the policy does not allow, so it should not be sent as it is.');
  const recorded = await withTenant(fixture.companyId, (tx) => tx.query<{ task_id: string; payload: unknown }>(
    "SELECT task_id, payload FROM events WHERE type = 'language.drifted'"));
  assert.deepEqual(recorded.rows, [{ task_id: english, payload: slip('review') }], 'on the reviewer\'s task, so its role is reminded');
  const roleOf = await withTenant(fixture.companyId, (tx) => tx.query<{ role_id: string }>(
    'SELECT role_id FROM tasks WHERE id = $1', [english]));
  assert.equal(roleOf.rows[0]!.role_id, reviewerRoleId);

  await review('Email ini menjanjikan pengembalian dana yang tidak diizinkan oleh kebijakan, jadi jangan dikirim seperti itu.');
  assert.equal((await drifts(fixture.companyId)).length, 1);
});

test('the reminder names what the slip was in, so the run knows what to write differently', async () => {
  const fixture = await talkingIndonesian('lang-where');
  const planned = await running(fixture);
  await recordPlan(fixture.companyId, planned.id, [{
    capability: 'email.send',
    intent: 'I will send the invoice to the customer so that they can pay it before the end of the week.',
    expectedEffect: 'The customer has the invoice in their inbox and the payment is on its way to us.',
  }]);
  const asking = await running(fixture, 'the next invoice');
  await assert.rejects(ownerAskCapability().execute({
    question: 'Should I send the invoice to the customer now, or wait until they have confirmed the order?',
  }, capabilityContext(fixture, asking.id)), asked);

  const next = await task(fixture, 'follow up');
  const context = await withTenant(fixture.companyId, (tx) =>
    buildContext(tx, { companyId: fixture.companyId, divisionId: fixture.divisionId, taskId: next.id }));
  const rule = context.sections.find((section) => section.kind === 'language')!.body;
  assert.match(rule, /in the last week this role wrote 2 times in English where the rule above asked for another: in a plan and in a question to the owner\./);
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
