/**
 * How long the rooms keep what was said (F19.15; STATUS section 2.212).
 *
 * Messages are kept unless the owner sets a window, of thirty days at least.
 * Each message then goes by its own age: a reply past the window goes with
 * its reactions, revisions, pins and files, however busy its thread still is;
 * a message that began a thread and is past the window keeps no words while
 * its thread has live replies, and goes with the last of them. Rooms stay. A
 * card keeps no work alive: when retention removes the work, the card goes
 * from the conversation, and the person's words that asked for it stay.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane } from '../../src/db/tenant.ts';
import { peopleFilesFolder } from '../../src/owner/route.ts';
import { readRetentionLog, runRetention } from '../../src/retention/retention.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { companyRoomOf, ok, personIn, refusedWith, said, type Console, type PersonIn } from '../helpers/rooms.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const DAY = 24 * 60 * 60 * 1000;

async function workspace(slug: string): Promise<{ fixture: Fixture; api: Console; owner: PersonIn; root: string }> {
  const fixture = await createCompany(slug);
  const root = await mkdtemp(join(tmpdir(), 'palugada-room-retention-'));
  const api = await consoleWithSettings({ files: { root } });
  const owner = personIn(api, await api.signIn(), fixture.companyId);
  return { fixture, api, owner, root };
}

/**
 * Something the owner said some days ago. Written on the control plane, which
 * keeps the date an archive gives a row (0150), since nothing else may write
 * a message in the past.
 */
async function saidAgo(fixture: Fixture, roomId: string, body: string, daysAgo: number, threadOf: string | null = null): Promise<string> {
  const id = randomUUID();
  await withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, fixture.companyId);
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, body, position, created_at)
       VALUES ($1, $2, $3, $4, 'text', 'owner', $5, 0, now() - make_interval(days => $6))`,
      [id, fixture.companyId, roomId, threadOf, body, daysAgo]);
  });
  return id;
}

type Shown = { id: string; body: string | null; deleted: boolean; expired: boolean; replies: { count: number } | null; files: unknown[]; card: unknown };

const shownIn = async (person: PersonIn, roomId: string): Promise<Shown[]> => ok(await person.page(roomId)).messages as Shown[];

const left = (fixture: Fixture) => withControlPlane((tx) => tx.query<{ id: string; body: string | null; deleted_at: Date | null; deleted_by: string | null }>(
  'SELECT id, body, deleted_at, deleted_by FROM room_messages WHERE company_id = $1 ORDER BY position', [fixture.companyId]))
  .then((result) => result.rows);

test('messages are kept unless the owner sets a window', async () => {
  const { fixture, api, owner } = await workspace('retention-kept');
  try {
    const room = await companyRoomOf(owner);
    const ancient = await saidAgo(fixture, room, 'Dua tahun lalu.', 800);
    const old = await saidAgo(fixture, room, 'Empat puluh hari lalu.', 40);
    const fresh = await said(owner, room, 'Hari ini.');
    await runRetention(fixture.companyId);
    assert.deepEqual((await left(fixture)).map((row) => row.id), [ancient, old, fresh], 'with no window, nothing goes');
    assert.equal(ok(await owner.get('/retention')).policy.messageDays, null);

    ok(await owner.post('/retention', { messageDays: 30 }));
    assert.equal(ok(await owner.get('/retention')).policy.messageDays, 30);
    await runRetention(fixture.companyId);
    assert.deepEqual((await left(fixture)).map((row) => row.id), [fresh]);
    assert.deepEqual((await shownIn(owner, room)).map((one) => one.id), [fresh]);
    assert.ok((await readRetentionLog(fixture.companyId)).some((entry) => entry.action === 'messages_purged' && entry.rowsAffected === 2),
      'the purge is on the record');
    // The room stays, and so does the owner's other window.
    assert.equal(ok(await owner.room(room)).room.id, room);
    assert.equal(ok(await owner.get('/retention')).policy.eventDays, 400);

    // Keeping again is saying so.
    ok(await owner.post('/retention', { messageDays: null }));
    assert.equal(ok(await owner.get('/retention')).policy.messageDays, null);
  } finally {
    await api.close();
  }
});

test('a busy thread still loses replies past the window', async () => {
  const { fixture, api, owner } = await workspace('retention-busy');
  try {
    const room = await companyRoomOf(owner);
    const root = await saidAgo(fixture, room, 'Siapa yang pegang kunci gudang?', 60);
    const oldReply = await saidAgo(fixture, room, 'Saya, sampai bulan lalu.', 45, root);
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query("INSERT INTO room_reactions (company_id, message_id, principal, emoji) VALUES ($1, $2, 'owner', '👍')", [fixture.companyId, oldReply]);
      await tx.query("INSERT INTO room_pins (company_id, room_id, message_id, pinned_by) VALUES ($1, $2, $3, 'owner')", [fixture.companyId, room, oldReply]);
    });
    const newReply = await said(owner, room, { body: 'Sekarang Sari yang pegang.', threadOf: root });
    ok(await owner.post('/retention', { messageDays: 30 }));
    await runRetention(fixture.companyId);

    assert.deepEqual((await left(fixture)).map((row) => row.id), [root, newReply], 'the old reply went, whatever its thread\'s newer replies');
    const gone = await withControlPlane((tx) => tx.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM room_reactions WHERE message_id = $1)::int + (SELECT count(*) FROM room_pins WHERE message_id = $1)::int AS n`,
      [oldReply]));
    assert.equal(gone.rows[0]!.n, 0, 'with its reactions and its pin');
    const thread = ok(await owner.thread(room, root));
    assert.deepEqual(thread.replies.map((one: { id: string }) => one.id), [newReply]);
    assert.equal(thread.root.replies.count, 1, 'the thread counts the replies it has');
  } finally {
    await api.close();
  }
});

test('a root past the window with live replies keeps no words, and goes with its last reply', async () => {
  const { fixture, api, owner, root: filesRoot } = await workspace('retention-root');
  try {
    const room = await companyRoomOf(owner);
    const root = await saidAgo(fixture, room, 'Rencana promosi lama, dengan lampiran.', 60);
    // Its file, kept as a post keeps one, and what an edit replaced.
    const folder = peopleFilesFolder({ root: filesRoot }, fixture.companyId)!;
    const fileId = randomUUID();
    const bytes = Buffer.from('%PDF-1.4 rencana');
    await mkdir(join(folder, 'rooms', room), { recursive: true });
    await writeFile(join(folder, 'rooms', room, `${fileId}.pdf`), bytes);
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query(
        `INSERT INTO room_files (id, company_id, message_id, name, mime, bytes, sha256, path)
         VALUES ($1, $2, $3, 'rencana.pdf', 'application/pdf', $4, $5, $6)`,
        [fileId, fixture.companyId, root, bytes.length, createHash('sha256').update(bytes).digest('hex'), `rooms/${room}/${fileId}.pdf`]);
      await tx.query('INSERT INTO room_message_revisions (company_id, message_id, body) VALUES ($1, $2, $3)', [fixture.companyId, root, 'Rencana yang pertama.']);
    });
    const reply = await saidAgo(fixture, room, 'Masih jalan sampai akhir bulan.', 10, root);
    ok(await owner.post('/retention', { messageDays: 30 }));
    await runRetention(fixture.companyId, new Date(), { filesRoot });

    const [tombstone] = await left(fixture);
    assert.deepEqual([tombstone!.id, tombstone!.body, tombstone!.deleted_at !== null, tombstone!.deleted_by], [root, null, true, null],
      'no words, removed by nobody: its time was up');
    const shown = (await shownIn(owner, room)).find((one) => one.id === root)!;
    assert.deepEqual([shown.deleted, shown.expired, shown.body, shown.files.length], [true, true, null, 1]);
    assert.equal((shown.files[0] as { inline: boolean }).inline, false);
    refusedWith(await owner.get(`/rooms/${room}/files/${fileId}`), 404, 'file.not_kept');
    assert.deepEqual(await readdir(join(folder, 'rooms', room)), [], 'its bytes are gone');
    const revisions = await withControlPlane((tx) => tx.query('SELECT 1 FROM room_message_revisions WHERE message_id = $1', [root]));
    assert.equal(revisions.rowCount, 0);
    // A person's own removal is not one whose time was up.
    const mine = await said(owner, room, 'Salah ketik.');
    ok(await owner.on(room, mine, 'delete'));
    assert.deepEqual((await shownIn(owner, room)).filter((one) => one.id === mine).map((one) => [one.deleted, one.expired]), [[true, false]]);
    assert.equal(ok(await owner.thread(room, root)).replies[0].id, reply);

    // Twenty-five days on, the reply is past the window too: it goes, and the root with it.
    await runRetention(fixture.companyId, new Date(Date.now() + 25 * DAY), { filesRoot });
    assert.deepEqual((await left(fixture)).map((row) => row.id), [mine]);
  } finally {
    await api.close();
  }
});

test('a card keeps no task alive, and a purged task leaves the conversation', async () => {
  const { fixture, api, owner } = await workspace('retention-cards');
  try {
    const room = await companyRoomOf(owner);
    const taskId = await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO tasks (company_id, project_id, division_id, role_id, budget_account_id, status, input, idempotency_key,
                            input_hash, created_by, created_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, 'completed', '{"goal":"Kirim surat penawaran"}', 'old-work', 'h', 'owner',
                 now() - interval '501 days', now() - interval '500 days')
         RETURNING id`,
        [fixture.companyId, fixture.projectId, fixture.divisionId, fixture.roleId, fixture.budgetAccountId]);
      return rows[0]!.id;
    });
    // The words that asked for it, and the card the platform drew of it in the room.
    const asked = randomUUID();
    const card = randomUUID();
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, fixture.companyId);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, became, became_by, became_at, task_id, position)
         VALUES ($1, $2, $3, 'text', 'owner', 'Tolong kirim surat penawaran.', 'work', 'owner', now(), $4, 0)`,
        [asked, fixture.companyId, room, taskId]);
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, via, task_id, position)
         VALUES ($1, $2, $3, 'work', 'platform', 'platform', $4, 0)`, [card, fixture.companyId, room, taskId]);
    });
    const before = await shownIn(owner, room);
    assert.deepEqual(before.map((one) => [one.id, one.card !== null]), [[asked, true], [card, true]]);

    // Messages are kept here, and the work goes by its own windows all the same.
    await runRetention(fixture.companyId);
    const tasksLeft = await withControlPlane((tx) => tx.query('SELECT 1 FROM tasks WHERE id = $1', [taskId]));
    assert.equal(tasksLeft.rowCount, 0, 'the cards did not keep it');
    const after_ = await shownIn(owner, room);
    assert.deepEqual(after_.map((one) => [one.id, one.card]), [[asked, null]], 'the card went with its work; the words that asked stay');
  } finally {
    await api.close();
  }
});

test('a window under thirty days is refused', async () => {
  const { api, owner } = await workspace('retention-refused');
  try {
    for (const days of [0, 29, 3651, 30.5, 'thirty']) {
      refusedWith(await owner.post('/retention', { messageDays: days }), 400, 'contract.violation', `${days} days`);
    }
    assert.equal(ok(await owner.get('/retention')).policy.messageDays, null, 'nothing was set');
    ok(await owner.post('/retention', { messageDays: 3650 }));
    assert.equal(ok(await owner.get('/retention')).policy.messageDays, 3650);
  } finally {
    await api.close();
  }
});
