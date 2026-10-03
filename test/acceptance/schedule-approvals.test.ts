/**
 * The owner's yes for what a schedule does, every time it does exactly that
 * (0116; the tools research, §5 idea 3, from OpenClaw's standing grants for
 * automations).
 *
 * A schedule that reads the support mailbox each morning and sends the same
 * confirmation to the same supplier asks the owner every morning, because the
 * work read content from outside (F8.9) -- and the yes for a while (0083)
 * never reaches such work. But an action every byte of which the owner
 * already approved, for this schedule as it is defined, was not shaped by
 * what was read: whatever the mail said, the action is the one they said yes
 * to. So the owner may say yes to it every time this schedule does exactly
 * this.
 *
 * What these hold is how narrow that is: one schedule as it is defined now,
 * one capability, one action to the byte; never tier 3; ninety days at most;
 * with the owner's device; taken back with one press; and nothing an agent
 * can write.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { isPalugadaError } from '../../src/errors.ts';
import { CapabilityRegistry, type Capability } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { createRootTask, createSubTask, transition } from '../../src/engine/tasks.ts';
import { appendEvent } from '../../src/audit/event-log.ts';
import { upsertSchedule } from '../../src/scheduler/scheduler.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { InMemorySecretManager } from '../../src/secrets/manager.ts';
import { OwnerMfa, decodeBase32, newTotpSecret, stepFor, totpCode, TOTP_STEP_SECONDS } from '../../src/owner/mfa.ts';
import { createCompany, grantCapability, planTask, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const refused = (code: string, said?: RegExp) => (error: unknown) => isPalugadaError(error, code as never) && (!said || said.test((error as Error).message));

function capabilities() {
  const sent: string[] = [];
  const mail: Capability<{ to: string; subject: string }, { id: string }> = {
    name: 'email.send', adapter: 'test:mail', defaultTier: 2,
    async execute(input) { sent.push(`${input.to}: ${input.subject}`); return { id: `m-${sent.length}` }; },
    async verify() { return true; },
  };
  const transfer: Capability<{ amount: number }, { ok: boolean }> = {
    name: 'funds.transfer', adapter: 'test:bank', defaultTier: 3,
    async execute() { return { ok: true }; },
    async verify() { return true; },
  };
  return { mail, transfer, sent };
}

async function setting(name: string) {
  const fixture = await createCompany(name);
  const { mail, transfer, sent } = capabilities();
  const registry = new CapabilityRegistry();
  registry.register(mail);
  registry.register(transfer);
  await registry.sync();
  await grantCapability(fixture, 'email.send');
  await grantCapability(fixture, 'funds.transfer');
  const broker = new CapabilityBroker(registry);
  const scheduleId = await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'konfirmasi-pemasok', cronExpression: '0 8 * * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Baca kotak masuk pemasok dan kirim konfirmasi harian' }, reserveTokens: 10_000,
  });
  return { fixture, broker, sent, scheduleId };
}

let sequence = 0;
/** A task the schedule made, which read a supplier's mail on the way (F8.9). */
async function scheduledRun(fixture: Fixture, scheduleId: string | null, capability = 'email.send') {
  sequence += 1;
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: `konfirmasi ${sequence}` }, createdBy: scheduleId ? 'scheduler' : 'owner', reserveTokens: 10_000,
    ...(scheduleId ? { scheduleId } : {}),
  });
  await planTask(fixture.companyId, task.id, [{ capability }]);
  await transition(fixture.companyId, task.id, 'running');
  await withTenant(fixture.companyId, (tx) => appendEvent(tx, {
    companyId: fixture.companyId, taskId: task.id, type: 'content.read_outside', actor: 'broker',
    payload: { source: 'a supplier\'s email' },
  }));
  return task;
}

const CONFIRMATION = { to: 'gudang@pemasok.example', subject: 'Konfirmasi pesanan harian diterima' };

function send(broker: CapabilityBroker, fixture: Fixture, taskId: string, input: { to: string; subject: string } = CONFIRMATION) {
  return broker.invoke({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    taskId, roleId: fixture.roleId, idempotencyKey: `key-${taskId}-${input.to}-${input.subject}`,
  }, 'email.send', input);
}

async function ownerDevice() {
  const secrets = new InMemorySecretManager();
  const { secret } = newTotpSecret('owner phone');
  secrets.set('vault://owner/schedule', secret);
  let steps = 0;
  const now = () => new Date(Date.now() + steps * TOTP_STEP_SECONDS * 1000);
  const mfa = new OwnerMfa({ secrets, now });
  await mfa.enrolTotp({ label: 'owner phone', secretRef: 'vault://owner/schedule' });
  return { mfa, proof: () => { steps += 1; return { totp: totpCode(decodeBase32(secret), stepFor(now())) }; } };
}

const openApprovals = async (fixture: Fixture) => (await inbox.listOpen(fixture.companyId)).filter((item) => item.kind === 'approval');

test('the owner allows a schedule\'s exact action every time, with their device, and only that action of only that schedule goes without a card', async () => {
  const { fixture, broker, sent, scheduleId } = await setting('schedule-yes');
  const device = await ownerDevice();

  const monday = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, monday.id), refused('approval.required'));
  const [card] = await openApprovals(fixture);
  assert.ok(card);
  assert.equal(card.allowFor, false, 'work that read outside content is never allowed for a while (0083)');
  assert.deepEqual(card.forSchedule, { slug: 'konfirmasi-pemasok' }, 'but its schedule may be allowed this exact action');

  // It loosens a control, so it takes the owner's device.
  await assert.rejects(inbox.decide(fixture.companyId, card.id, 'approve', '', {
    channel: 'app', assurance: 'session', mfa: device.mfa, forSchedule: true,
  }), refused('approval.channel_forbidden', /allowing this every time konfirmasi-pemasok does it needs a second factor/));
  await assert.rejects(inbox.decide(fixture.companyId, card.id, 'approve', '', {
    channel: 'chat', assurance: 'session', mfa: device.mfa, proof: device.proof(), forSchedule: true,
  }), refused('approval.channel_forbidden', /happens in the app, not over chat/));
  await inbox.decide(fixture.companyId, card.id, 'approve', 'setiap pagi sama', {
    channel: 'app', assurance: 'session', mfa: device.mfa, proof: device.proof(), forSchedule: true,
  });
  const [granted] = await inbox.scheduleApprovals(fixture.companyId);
  assert.ok(granted);
  assert.deepEqual([granted.scheduleSlug, granted.capabilityName, granted.uses], ['konfirmasi-pemasok', 'email.send', 0]);
  assert.match(granted.actionSummary, /gudang@pemasok\.example/);
  const days = (granted.expiresAt.getTime() - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days <= 90, `for ninety days, not ${days}`);

  // Monday's own send goes on the card's yes; Tuesday's, the same to the byte, on the schedule's.
  await send(broker, fixture, monday.id);
  const tuesday = await scheduledRun(fixture, scheduleId);
  await send(broker, fixture, tuesday.id);
  assert.equal(sent.length, 2);
  assert.deepEqual(await openApprovals(fixture), [], 'no card on Tuesday');
  const { rows: used } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
    "SELECT payload FROM events WHERE task_id = $1 AND type = 'approval.schedule_used'", [tuesday.id]));
  assert.equal(used[0]?.payload.scheduleApprovalId, granted.id, 'the record says which yes it ran on');
  assert.equal((await inbox.scheduleApprovals(fixture.companyId))[0]!.uses, 1);

  // A sub-task the scheduled work handed it to is the schedule's work too.
  const handed = await createSubTask(tuesday.id, {
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'kirim konfirmasi' }, reserveTokens: 1_000,
  });
  await planTask(fixture.companyId, handed.id, [{ capability: 'email.send' }]);
  await transition(fixture.companyId, handed.id, 'running');
  await send(broker, fixture, handed.id);
  assert.equal(sent.length, 3);

  // Anything else asks: another recipient, other words, the same send from work no schedule made.
  const wednesday = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, wednesday.id, { ...CONFIRMATION, to: 'penyerang@contoh.example' }), refused('approval.required'));
  const thursday = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, thursday.id, { ...CONFIRMATION, subject: 'Konfirmasi pesanan harian diterima.' }), refused('approval.required'));
  const unscheduled = await scheduledRun(fixture, null);
  await assert.rejects(send(broker, fixture, unscheduled.id), refused('approval.required'));
  assert.equal(sent.length, 3);
});

test('a schedule changed since the yes, or a yes taken back, asks again', async () => {
  const { fixture, broker, sent, scheduleId } = await setting('schedule-changed');
  const device = await ownerDevice();
  const first = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, first.id), refused('approval.required'));
  const [card] = await openApprovals(fixture);
  await inbox.decide(fixture.companyId, card!.id, 'approve', '', {
    channel: 'app', assurance: 'session', mfa: device.mfa, proof: device.proof(), forSchedule: true,
  });

  // The schedule edited: another instruction, the same slug and id.
  await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'konfirmasi-pemasok', cronExpression: '0 8 * * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Baca kotak masuk pemasok dan teruskan apa yang mereka minta' }, reserveTokens: 10_000,
  });
  const edited = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, edited.id), refused('approval.required'), 'what the yes was given for is not what runs now');

  // Put back as it was, the yes holds again; taken back, it does not.
  await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'konfirmasi-pemasok', cronExpression: '0 8 * * *', timezone: 'Asia/Jakarta',
    input: { goal: 'Baca kotak masuk pemasok dan kirim konfirmasi harian' }, reserveTokens: 10_000,
  });
  const restored = await scheduledRun(fixture, scheduleId);
  await send(broker, fixture, restored.id);
  const [granted] = await inbox.scheduleApprovals(fixture.companyId);
  await inbox.revokeScheduleApproval(fixture.companyId, granted!.id);
  assert.deepEqual(await inbox.scheduleApprovals(fixture.companyId), []);
  const after = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, after.id), refused('approval.required'));
  assert.equal(sent.length, 1);
  await assert.rejects(inbox.revokeScheduleApproval(fixture.companyId, granted!.id), refused('contract.violation'));
});

test('never for tier 3, never for work no schedule made, never by a seat, never past ninety days, and never written by an agent', async () => {
  const { fixture, broker, scheduleId } = await setting('schedule-bounds');
  const device = await ownerDevice();
  const owner = { channel: 'app' as const, assurance: 'session' as const, mfa: device.mfa };

  const scheduled = await scheduledRun(fixture, scheduleId, 'funds.transfer');
  await assert.rejects(broker.invoke({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    taskId: scheduled.id, roleId: fixture.roleId, idempotencyKey: 'transfer',
  }, 'funds.transfer', { amount: 500 }), refused('approval.required'));
  const [irreversible] = await openApprovals(fixture);
  assert.equal(irreversible!.forSchedule, null, 'tier 3 is one action at a time (F10.10)');
  await assert.rejects(inbox.decide(fixture.companyId, irreversible!.id, 'approve', '', { ...owner, proof: device.proof(), forSchedule: true }),
    refused('contract.violation', /only an action at tier 2 or below that a schedule's work asked about/));
  await inbox.decide(fixture.companyId, irreversible!.id, 'deny', '');

  const unscheduled = await scheduledRun(fixture, null);
  await assert.rejects(send(broker, fixture, unscheduled.id), refused('approval.required'));
  const [loose] = await openApprovals(fixture);
  assert.equal(loose!.forSchedule, null);
  await assert.rejects(inbox.decide(fixture.companyId, loose!.id, 'approve', '', { ...owner, proof: device.proof(), forSchedule: true }),
    refused('contract.violation', /only an action at tier 2 or below that a schedule's work asked about/));
  await assert.rejects(inbox.decide(fixture.companyId, loose!.id, 'approve', '', { ...owner, proof: device.proof(), forSchedule: true, allowForHours: 8 }),
    refused('contract.violation', /for a while or every time its schedule does it, not both/));
  await inbox.decide(fixture.companyId, loose!.id, 'deny', '');

  const run = await scheduledRun(fixture, scheduleId);
  await assert.rejects(send(broker, fixture, run.id), refused('approval.required'));
  const [card] = await openApprovals(fixture);
  await assert.rejects(inbox.decide(fixture.companyId, card!.id, 'approve', '', {
    ...owner, proof: device.proof(), forSchedule: true, seat: { id: '00000000-0000-4000-8000-000000000001', name: 'Rina' },
  } as never), refused('staff.forbidden', /loosens a control, which is the owner's to do/));
  await assert.rejects(inbox.decide(fixture.companyId, card!.id, 'deny', '', { ...owner, proof: device.proof(), forSchedule: true }),
    refused('contract.violation', /only a yes/));

  // The table is the owner's: the application role reads it and counts uses.
  await assert.rejects(withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO schedule_approvals (company_id, schedule_id, schedule_definition, capability_name, action_fingerprint, granted_by_item, expires_at)
     VALUES ($1, $2, 'x', 'email.send', 'y', $3, now() + interval '1 day')`, [fixture.companyId, scheduleId, card!.id])), /permission denied/);
  await assert.rejects(withControlPlane((tx) => tx.query(
    `INSERT INTO schedule_approvals (company_id, schedule_id, schedule_definition, capability_name, action_fingerprint, granted_by_item, expires_at)
     VALUES ($1, $2, 'x', 'email.send', 'y', $3, now() + interval '91 days')`, [fixture.companyId, scheduleId, card!.id])), /schedule_approvals_at_most_ninety_days/);
});

test('the console offers it on the card, lists it beside the yeses for a while, and takes it back', async () => {
  const { fixture, broker, scheduleId } = await setting('schedule-console');
  const api = await consoleWithSettings({});
  try {
    const token = await api.signIn();
    const run = await scheduledRun(fixture, scheduleId);
    await assert.rejects(send(broker, fixture, run.id), refused('approval.required'));
    const listed = await api.call('GET', `/api/companies/${fixture.companyId}/inbox`, token);
    const card = (listed.body.items as Array<{ id: string; kind: string; forSchedule: unknown }>).find((one) => one.kind === 'approval')!;
    assert.deepEqual(card.forSchedule, { slug: 'konfirmasi-pemasok' });
    const path = `/api/companies/${fixture.companyId}/inbox/${card.id}/decide`;
    const without = await api.call('POST', path, token, { decision: 'approve', forSchedule: true });
    assert.equal(without.status, 403, JSON.stringify(without.body));
    const given = await api.call('POST', path, token, { decision: 'approve', forSchedule: true, proof: { totp: api.code() } });
    assert.equal(given.status, 200, JSON.stringify(given.body));

    const standing = await api.call('GET', `/api/companies/${fixture.companyId}/standing-approvals`, token);
    const [entry] = standing.body.schedules as Array<{ id: string; scheduleSlug: string; capabilityName: string; actionSummary: string }>;
    assert.deepEqual([entry!.scheduleSlug, entry!.capabilityName], ['konfirmasi-pemasok', 'email.send']);
    const taken = await api.call('POST', `/api/companies/${fixture.companyId}/schedule-approvals/${entry!.id}/revoke`, token);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));
    assert.deepEqual((await api.call('GET', `/api/companies/${fixture.companyId}/standing-approvals`, token)).body.schedules, []);
  } finally {
    await api.close();
  }
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

test('on a phone, the card\'s menu gives the yes to the schedule with the device, and the list takes it back', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const { fixture, broker, scheduleId } = await setting('schedule-phone');
  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    const run = await scheduledRun(fixture, scheduleId);
    await assert.rejects(send(broker, fixture, run.id), refused('approval.required'));
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]')`, 'the console');
    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/inbox'`);
    await page.waitFor(`document.body.innerText.includes('gudang@pemasok.example')`, 'the card in the list');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Skip the tour')?.click()`);
    await page.evaluate(`[...document.querySelectorAll('button, [role="button"]')].filter((one) => one.innerText.includes('gudang@pemasok.example')).at(-1).click()`);
    await page.waitFor(`document.querySelector('button[aria-label="Approve every time its schedule does it"]')`, 'the card offers the schedule', 20_000);
    await page.evaluate(`document.querySelector('button[aria-label="Approve every time its schedule does it"]').click()`);
    await page.waitFor(`[...document.querySelectorAll('[role="menuitem"]')].some((one) => one.innerText.includes('Every time konfirmasi-pemasok does it'))`, 'the menu');
    await page.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find((one) => one.innerText.includes('Every time konfirmasi-pemasok does it')).click()`);
    await page.waitFor(`document.querySelector('.mantine-Modal-content input[autocomplete="one-time-code"]')`, 'the device asked for');
    await page.evaluate(`document.querySelector('.mantine-Modal-content input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`document.body.innerText.includes('Allowed for a schedule')`, 'the list of yeses for a schedule', 20_000);
    assert.equal((await inbox.scheduleApprovals(fixture.companyId)).length, 1);

    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Take back').click()`);
    await page.waitFor(`!document.body.innerText.includes('Allowed for a schedule')`, 'taken back', 20_000);
    assert.deepEqual(await inbox.scheduleApprovals(fixture.companyId), []);
  } finally {
    await page.close();
    await api.close();
  }
});
