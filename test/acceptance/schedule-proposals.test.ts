/**
 * `schedule.propose` (the tools research, gap #12; `cronjob_manage` in
 * Hermes, `cron` in OpenClaw): a role that sees the same work owed again and
 * again proposes doing it on a schedule, and the owner's yes is the schedule.
 *
 * Held to what goal.propose is held to: proposing changes nothing, one card
 * per name, the work that proposed it carries on whatever the answer, and
 * nothing exists until the owner says yes. And to what a schedule the owner
 * makes is held to: a cron that parses in a zone that exists, a role of this
 * company, a name not taken -- and, from a run, nothing more often than
 * hourly.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import { closePools } from '../../src/db/pool.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { CapabilityBroker } from '../../src/broker/broker.ts';
import { registerPlatformCapabilities } from '../../src/broker/platform-capabilities.ts';
import { declarationFor } from '../../src/broker/catalogue.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
import { upsertSchedule } from '../../src/scheduler/scheduler.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { STANDARD_COMPANY_TEMPLATE } from '../../src/templates/standard.ts';
import { addRole, createCompany, grantCapability, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

async function setting(name: string) {
  const fixture = await createCompany(name);
  const registry = new CapabilityRegistry();
  registerPlatformCapabilities(registry);
  await registry.sync();
  await grantCapability(fixture, 'schedule.propose');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    goalId: fixture.goalId, input: { goal: 'Rapikan pekerjaan rutin' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  const broker = new CapabilityBroker(registry);
  let key = 0;
  const propose = (input: Record<string, unknown>) => broker.invoke<unknown, { proposed: boolean; inboxItemId: string; note?: string }>({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, taskId: task.id, idempotencyKey: `propose-${key += 1}`,
  }, 'schedule.propose', input);
  return { fixture, task, propose };
}

const schedules = (fixture: Fixture) => withTenant(fixture.companyId, async (tx) => (await tx.query<{
  slug: string; cron_expression: string; timezone: string; role_id: string; goal_id: string | null; enabled: boolean;
  input: { goal?: string }; next_run_at: Date;
}>('SELECT slug, cron_expression, timezone, role_id, goal_id, enabled, input, next_run_at FROM schedules ORDER BY slug')).rows);

const PROPOSAL = {
  name: 'rekap-penjualan-senin',
  cron: '0 9 * * 1',
  timezone: 'Asia/Jakarta',
  instruction: 'Rekap penjualan minggu lalu per produk dan kirim ringkasannya ke owner.',
  why: 'Owner meminta rekap ini tiga Senin berturut-turut.',
};

test('a role proposes a schedule, the card says what, who, when and why, and the owner\'s yes starts it', async () => {
  const { fixture, task, propose } = await setting('schedule-propose');
  await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id', owner_timezone = 'Asia/Jakarta'"));
  try {
    const first = (await propose(PROPOSAL)).output;
    assert.equal(first.proposed, true);
    assert.deepEqual(await schedules(fixture), [], 'proposing makes nothing');
    const [card] = (await inbox.listOpen(fixture.companyId)).filter((one) => one.id === first.inboxItemId);
    assert.ok(card);
    assert.equal(card.kind, 'escalation');
    assert.equal(card.taskId, null, 'a no to the proposal is not a stop to the work that made it');
    // In the owner's language, with the next runs in their own time.
    assert.match(card.title, /mengusulkan jadwal rekap-penjualan-senin/);
    assert.match(card.rationale, /Rekap penjualan minggu lalu per produk/);
    assert.match(card.rationale, /0 9 \* \* 1 \(Asia\/Jakarta\)/);
    assert.match(card.rationale, /09\.00|09:00/);
    assert.match(card.rationale, /tiga Senin berturut-turut/);

    // One card per name.
    const again = (await propose({ ...PROPOSAL, why: 'Sekali lagi.' })).output;
    assert.deepEqual([again.proposed, again.inboxItemId], [false, first.inboxItemId]);
    assert.match(again.note ?? '', /already waiting for the owner/);

    await inbox.decide(fixture.companyId, first.inboxItemId, 'approve', 'Ya, jalankan.');
    const [made] = await schedules(fixture);
    assert.ok(made);
    assert.deepEqual([made.slug, made.cron_expression, made.timezone, made.role_id, made.goal_id, made.enabled],
      ['rekap-penjualan-senin', '0 9 * * 1', 'Asia/Jakarta', fixture.roleId, fixture.goalId, true]);
    assert.equal(made.input.goal, PROPOSAL.instruction);
    assert.ok(made.next_run_at.getTime() > Date.now(), 'its first run is its next time');
    const { rows: recorded } = await withTenant(fixture.companyId, (tx) => tx.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM events WHERE type = 'schedule.proposal_approved'"));
    assert.equal(recorded[0]?.payload.inboxItemId, first.inboxItemId);
    const { rows: still } = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [task.id]));
    assert.equal(still[0]!.status, 'running', 'the proposer carries on');
  } finally {
    await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = NULL, owner_timezone = 'UTC'"));
  }
});

test('a proposal is refused for what a schedule the owner makes would be refused for, and for running more often than hourly', async () => {
  const { fixture, propose } = await setting('schedule-propose-refused');
  const refused = (said: RegExp) => (error: unknown) => said.test((error as Error).message);
  await assert.rejects(propose({ ...PROPOSAL, cron: 'every monday' }), refused(/invalid cron expression/));
  await assert.rejects(propose({ ...PROPOSAL, cron: '*/15 * * * *' }), refused(/runs at most once an hour; this one runs every 15 minutes/));
  await assert.rejects(propose({ ...PROPOSAL, timezone: 'Mars/Olympus' }), refused(/Mars\/Olympus/));
  await assert.rejects(propose({ ...PROPOSAL, name: 'Rekap Senin!' }), refused(/a schedule's name is lower-case letters, digits and dashes/));
  await assert.rejects(propose({ ...PROPOSAL, role: 'tidak-ada' }), refused(/no role tidak-ada in this company; name one by its slug: /));
  await assert.rejects(propose({ ...PROPOSAL, instruction: '  ' }), refused(/instruction/));
  await assert.rejects(propose({ ...PROPOSAL, why: '' }), refused(/why/));
  await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'rekap-penjualan-senin', cronExpression: '0 8 * * 1', timezone: 'UTC', input: { goal: 'x' },
  });
  await assert.rejects(propose(PROPOSAL), refused(/a schedule named rekap-penjualan-senin already exists/));
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 0, 'nothing reached the owner');
});

test('another role may be named, a no makes nothing, and a name taken since is refused at the yes', async () => {
  const { fixture, propose } = await setting('schedule-propose-roles');
  const bookkeeper = await addRole(fixture, 'bookkeeper');
  const proposed = (await propose({ ...PROPOSAL, name: 'tutup-buku', role: 'bookkeeper', cron: '0 17 * * 5' })).output;
  // A seat beside the owner reads schedules and makes none: the yes that makes one is the owner's.
  await assert.rejects(inbox.decide(fixture.companyId, proposed.inboxItemId, 'approve', '', {
    seat: { id: '00000000-0000-4000-8000-000000000002', name: 'Rina' },
  }), /making a schedule is the owner's to do: it stays in their inbox/);
  const denied = (await propose({ ...PROPOSAL, name: 'cek-stok' })).output;
  await inbox.decide(fixture.companyId, denied.inboxItemId, 'deny', 'Belum perlu.');
  assert.deepEqual(await schedules(fixture), []);

  await upsertSchedule({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    slug: 'tutup-buku', cronExpression: '0 18 * * 5', timezone: 'UTC', input: { goal: 'the owner\'s own' },
  });
  await assert.rejects(inbox.decide(fixture.companyId, proposed.inboxItemId, 'approve', ''),
    /a schedule named tutup-buku was made since this was proposed/);
  const [kept] = await schedules(fixture);
  assert.equal(kept!.input.goal, 'the owner\'s own', 'the owner\'s schedule is not overwritten');
  await withControlPlane((tx) => tx.query("DELETE FROM schedules WHERE company_id = $1 AND slug = 'tutup-buku'", [fixture.companyId]));
  await inbox.decide(fixture.companyId, proposed.inboxItemId, 'approve', '');
  const [made] = await schedules(fixture);
  assert.equal(made!.role_id, bookkeeper, 'the role it named does it');
});

test('schedule.propose is a tier 0 proposal, and the standard company\'s coordinator holds it', () => {
  const declared = declarationFor('schedule.propose');
  assert.deepEqual([declared?.tier, declared?.adapter], [0, 'platform']);
  const grants = (STANDARD_COMPANY_TEMPLATE.grants ?? []).filter((one) => one.capability === 'schedule.propose').map((one) => one.division);
  assert.deepEqual(grants, ['ops']);
  const tools = STANDARD_COMPANY_TEMPLATE.roles.find((role) => role.slug === 'coordinator')!.tools ?? [];
  assert.ok(tools.includes('schedule.propose'));
  assert.ok(tools.length <= 12);
});
