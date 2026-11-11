/**
 * The rooms of a company with a long history (F19.15, F1.5; STATUS section 2.217).
 *
 * A company that has talked for years has hundreds of thousands of messages
 * and tens of thousands of threads. Setting a window on it, a pass after the
 * worker was down, and restoring its archive must each finish within the
 * pool's statement timeout, and retention must never hold the company's room
 * clock -- which every post, edit, reaction and read mark takes first -- for
 * more than a few seconds at a time. Both failed at this size before section
 * 2.217: the purge took one clock position per removed message inside one
 * transaction, which grows with the square of the backlog, and the restore's
 * recount was planned per thread over rows the planner knew nothing of.
 *
 * The history is written in bulk with SQL, a few thousand rows a transaction,
 * as an import would write it, so the test spends its time on what it proves.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closePools } from '../../src/db/pool.ts';
import { roomsOnControlPlane, withControlPlane, withPeople } from '../../src/db/tenant.ts';
import { exportCompany, type ArchiveLine } from '../../src/audit/export.ts';
import { importCompany } from '../../src/audit/import.ts';
import { purgeExpiredMessages, readRetentionLog, setRetention } from '../../src/retention/retention.ts';
import { ensureCompanyRooms } from '../../src/workspace/rooms.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/** Rows a transaction of the builder writes: few enough that the builder's own clock stays cheap. */
const BUILD_BATCH = 5000;

async function companyRoom(fixture: Fixture): Promise<string> {
  await ensureCompanyRooms(fixture.companyId);
  const { rows } = await withControlPlane((tx) => tx.query<{ id: string }>(
    "SELECT id FROM rooms WHERE company_id = $1 AND kind = 'company'", [fixture.companyId]));
  return rows[0]!.id;
}

/**
 * `count` threads that began `daysAgo` days ago in `roomId`, each a root and
 * `replies` replies, the replies `replyDaysAgo` days ago, with a reaction on
 * every root and a pin on every hundredth. Written as an import writes, on
 * the control plane, so the dates are kept and nobody is owed anything.
 */
async function history(fixture: Fixture, roomId: string, shape: {
  count: number; replies: number; daysAgo: number; replyDaysAgo: number; tag: string;
}): Promise<void> {
  const { companyId } = fixture;
  for (let from = 0; from < shape.count; from += BUILD_BATCH) {
    const to = Math.min(shape.count, from + BUILD_BATCH);
    await withControlPlane(async (tx) => {
      await roomsOnControlPlane(tx, companyId, { importing: true });
      // The planner has not seen these rows yet; joined by hash, the builder's own statements stay cheap.
      await tx.query('SET LOCAL enable_nestloop = off');
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, via, created_at, position, external_id)
         SELECT gen_random_uuid(), $1, $2, 'text', 'owner', $3 || ' root ' || g, 'import',
                now() - make_interval(days => $4) + g * interval '1 second', 0, $3 || ':' || g
           FROM generate_series($5::int, $6::int) g ORDER BY g`,
        [companyId, roomId, shape.tag, shape.daysAgo, from + 1, to]);
      for (let reply = 1; reply <= shape.replies; reply += 1) {
        await tx.query(
          `INSERT INTO room_messages (id, company_id, room_id, thread_of, kind, author, body, via, created_at, position)
           SELECT gen_random_uuid(), $1, $2, m.id, 'text', 'owner', 'reply ' || $5::int, 'import',
                  now() - make_interval(days => $4) + $5::int * interval '1 minute', 0
             FROM room_messages m
            WHERE m.company_id = $1 AND m.external_id IN (SELECT $3 || ':' || g FROM generate_series($6::int, $7::int) g)
            ORDER BY m.position`,
          [companyId, roomId, shape.tag, shape.replyDaysAgo, reply, from + 1, to]);
      }
      // Each thread counts its replies, which an import's triggers leave to the importer.
      await tx.query(
        `UPDATE room_messages m SET reply_count = c.n, last_reply_position = c.last
           FROM (SELECT r.thread_of, count(*)::int AS n, max(r.position) AS last
                   FROM room_messages r JOIN room_messages t ON t.company_id = r.company_id AND t.id = r.thread_of
                  WHERE r.company_id = $1 AND t.external_id IN (SELECT $2 || ':' || g FROM generate_series($3::int, $4::int) g)
                  GROUP BY r.thread_of) c
          WHERE m.company_id = $1 AND m.id = c.thread_of`,
        [companyId, shape.tag, from + 1, to]);
      await tx.query(
        `INSERT INTO room_reactions (company_id, message_id, principal, emoji, created_at)
         SELECT $1, m.id, 'owner', '👍', m.created_at FROM room_messages m
          WHERE m.company_id = $1 AND m.external_id IN (SELECT $2 || ':' || g FROM generate_series($3::int, $4::int) g)`,
        [companyId, shape.tag, from + 1, to]);
      await tx.query(
        `INSERT INTO room_pins (company_id, room_id, message_id, pinned_by, pinned_at)
         SELECT $1, m.room_id, m.id, 'owner', m.created_at FROM room_messages m
          WHERE m.company_id = $1 AND m.external_id IN (SELECT $2 || ':' || g FROM generate_series($3::int, $4::int, 100) g)`,
        [companyId, shape.tag, from + 1, to]);
    });
  }
}

/**
 * Posts as the owner every `everyMs` while `work` runs, and answers how long
 * the slowest post waited: a post takes the company's clock first, so this is
 * how long the work held it at a stretch.
 */
async function slowestPostDuring<T>(fixture: Fixture, roomId: string, everyMs: number, work: Promise<T>): Promise<{ result: T; slowest: number; posts: number }> {
  let done = false;
  let slowest = 0;
  let posts = 0;
  const finished = work.finally(() => { done = true; });
  // Give the work a moment to take hold before the first post.
  await new Promise((resolve) => setTimeout(resolve, 500));
  while (!done) {
    const began = Date.now();
    await withPeople(fixture.companyId, { principal: 'owner', name: null }, (tx) => tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position) VALUES ($1, $2, $3, 'text', 'owner', 'Masih di sini?', 0)`,
      [randomUUID(), fixture.companyId, roomId]));
    slowest = Math.max(slowest, Date.now() - began);
    posts += 1;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  return { result: await finished, slowest, posts };
}

/** A count, joined by hash: the planner has not yet seen the rows this file wrote a moment ago. */
const counted = async (sql: string, values: unknown[]): Promise<number> => withControlPlane(async (tx) => {
  await tx.query('SET LOCAL enable_nestloop = off');
  return tx.query<{ n: string }>(sql, values);
}).then((result) => Number(result.rows[0]!.n));

test('retention takes a long history in short turns, and a person posting meanwhile is never held long', async () => {
  const fixture = await createCompany('scale-retention');
  const room = await companyRoom(fixture);
  // Sixty thousand threads two years old, each a root and one reply: all of it past the window.
  await history(fixture, room, { count: 60_000, replies: 1, daysAgo: 800, replyDaysAgo: 799, tag: 'old' });
  // Ten thousand threads as old whose reply came today: each root keeps its thread, without its words.
  await history(fixture, room, { count: 10_000, replies: 1, daysAgo: 800, replyDaysAgo: 0, tag: 'alive' });
  await setRetention(fixture.companyId, { messageDays: 30 });
  const clockBefore = await counted('SELECT position AS n FROM room_clock WHERE company_id = $1', [fixture.companyId]);
  const feedBefore = await counted('SELECT count(*) AS n FROM room_feed WHERE company_id = $1', [fixture.companyId]);

  const began = Date.now();
  const { result: purged, slowest, posts } = await slowestPostDuring(fixture, room, 100, purgeExpiredMessages(fixture.companyId));
  const took = Date.now() - began;
  console.log(`# retention of 140,000 messages: ${took} ms; ${posts} posts meanwhile, the slowest held ${slowest} ms`);

  assert.equal(purged.deleted.length, 120_000, 'every old root and old reply went');
  assert.equal(purged.tombstoned.length, 10_000, 'every old root with a reply from today stayed without its words');
  assert.ok(slowest < 3000, `a post waited ${slowest} ms behind retention; the clock is held a few seconds at most`);
  assert.equal(await counted("SELECT count(*) AS n FROM room_messages WHERE company_id = $1 AND body LIKE 'old%'", [fixture.companyId]), 0);
  assert.equal(await counted(
    `SELECT count(*) AS n FROM room_messages m
      WHERE m.company_id = $1 AND m.thread_of IS NULL AND m.external_id LIKE 'alive:%'
        AND m.deleted_at IS NOT NULL AND m.body IS NULL AND m.reply_count = 1`, [fixture.companyId]), 10_000,
  'a root left without words still counts the reply it keeps');
  assert.equal(await counted(
    `SELECT count(*) AS n FROM room_reactions r JOIN room_messages m ON m.company_id = r.company_id AND m.id = r.message_id
      WHERE r.company_id = $1 AND m.deleted_at IS NULL`, [fixture.companyId]), 0, 'reactions go with the words they were on');
  assert.equal(await counted(
    `SELECT count(*) AS n FROM room_pins p JOIN room_messages m ON m.company_id = p.company_id AND m.id = p.message_id
      WHERE p.company_id = $1 AND m.deleted_at IS NULL`, [fixture.companyId]), 0, 'and pins');
  assert.equal(await counted('SELECT count(*) AS n FROM room_pins WHERE company_id = $1', [fixture.companyId]), 100,
    'a pin on a message that keeps its thread stays, as a person removing it leaves it');

  // What open consoles are told: the room changed, a few times, not once per message.
  const feedWritten = await counted('SELECT count(*) AS n FROM room_feed WHERE company_id = $1', [fixture.companyId]) - feedBefore - posts;
  assert.ok(feedWritten <= 500, `the purge wrote ${feedWritten} feed rows; one per room a turn, not one per message`);
  const clockMoved = await counted('SELECT position AS n FROM room_clock WHERE company_id = $1', [fixture.companyId]) - clockBefore - posts;
  assert.ok(clockMoved <= 500, `the purge took ${clockMoved} positions of the clock`);

  const log = (await readRetentionLog(fixture.companyId)).filter((row) => row.action === 'messages_purged');
  assert.equal(log.reduce((sum, row) => sum + row.rowsAffected, 0), 130_000, 'every message taken is recorded, by the turn that took it');

  // A second pass finds nothing left to take, and takes nothing.
  const again = await purgeExpiredMessages(fixture.companyId);
  assert.deepEqual([again.deleted.length, again.tombstoned.length], [0, 0]);
});

test('an archive of a company with tens of thousands of threads restores whole', async () => {
  const fixture = await createCompany('scale-restore');
  const room = await companyRoom(fixture);
  // Thirty thousand threads of a root and two replies each: ninety thousand messages.
  await history(fixture, room, { count: 30_000, replies: 2, daysAgo: 200, replyDaysAgo: 199, tag: 'kept' });

  const lines: ArchiveLine[] = [];
  let began = Date.now();
  await exportCompany(fixture.companyId, (line) => { lines.push(line); });
  console.log(`# export of 90,000 messages: ${Date.now() - began} ms`);

  began = Date.now();
  const restored = await importCompany(lines, { slug: `${fixture.slug}-restored` });
  const took = Date.now() - began;
  console.log(`# restore of 90,000 messages in 30,000 threads: ${took} ms`);

  assert.equal(restored.sections.room_messages, 90_000);
  assert.equal(await counted(
    'SELECT count(*) AS n FROM room_messages WHERE company_id = $1 AND thread_of IS NULL AND reply_count = 2 AND last_reply_position IS NOT NULL',
    [restored.companyId]), 30_000, 'every thread counts its two replies once restored');
  assert.equal(await counted(
    `SELECT count(*) AS n FROM room_messages r JOIN room_messages m ON m.company_id = r.company_id AND m.id = r.thread_of
      WHERE r.company_id = $1 AND r.position <= m.position`, [restored.companyId]), 0, 'every reply comes after the message it answers');
  assert.equal(await counted(
    'SELECT count(*) AS n FROM room_messages WHERE company_id = $1 AND position > (SELECT position FROM room_clock WHERE company_id = $1)',
    [restored.companyId]), 0, 'no restored position is ahead of the clock');
  assert.equal(await counted('SELECT count(*) AS n FROM room_reactions WHERE company_id = $1', [restored.companyId]), 30_000);

  // The restored company's rooms take new words after what came back.
  const after = await withPeople(restored.companyId, { principal: 'owner', name: null }, async (tx) => {
    const { rows } = await tx.query<{ id: string }>("SELECT id FROM rooms WHERE company_id = $1 AND kind = 'company'", [restored.companyId]);
    const id = randomUUID();
    await tx.query(
      `INSERT INTO room_messages (id, company_id, room_id, kind, author, body, position) VALUES ($1, $2, $3, 'text', 'owner', 'Kembali.', 0)`,
      [id, restored.companyId, rows[0]!.id]);
    return id;
  });
  assert.equal(await counted(
    'SELECT count(*) AS n FROM room_messages WHERE company_id = $1 AND position > (SELECT position FROM room_messages WHERE id = $2)',
    [restored.companyId, after]), 0, 'a new message is the newest');
});
