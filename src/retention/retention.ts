/**
 * Retention (PRD F11.5).
 *
 * Events and traces are kept at least twelve months and full prompts at least
 * ninety days. The windows differ because the rows differ in risk: a trace
 * says a call happened and what it cost, while the prompt inside it may hold a
 * customer's message. So prompts are scrubbed first and the trace survives,
 * which keeps cost history and audit trail intact while shrinking the
 * sensitive surface.
 *
 * This is the only code in the system that deletes anything durable, and it is
 * built to be hard to misuse:
 *
 *   - The purge flag is set transaction-locally. A session-level setting on a
 *     pooled connection would outlive the transaction and hand the next
 *     borrower the ability to delete history, which is the exact failure mode
 *     the tenant-scope code already avoids.
 *   - The database re-checks every row against the retention window, so a bug
 *     here cannot delete anything recent even with the flag set.
 *   - Every purge is recorded. Deleting history is the one operation that can
 *     make the log lie by omission, so "there are no events from March" and
 *     "March was quiet" have to stay distinguishable.
 */
import { roomsOnControlPlane, withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { NOTICE_DAYS } from '../owner/member-notify.ts';
import { keptPaths, peopleFolderOf, removeRoomFiles, sweepRoomFiles, type PeopleRoots } from '../workspace/files.ts';
import { sweepImportParts } from '../workspace/import-slack.ts';
import { takeClock } from '../workspace/rooms.ts';

export interface RetentionPolicy {
  eventDays: number;
  traceDays: number;
  promptDays: number;
  /**
   * How long people's messages are kept, in days (F19.15): null keeps them,
   * which is the default. Thirty days at least, which the database holds too.
   */
  messageDays: number | null;
}

/**
 * The floors PRD F11.5 states, used when no policy row exists.
 *
 * A missing configuration row must not take retention down with it. The
 * database enforces the same floors on any row that is written, so these are
 * the same numbers from the other side.
 */
export const DEFAULT_RETENTION: RetentionPolicy = {
  eventDays: 400,
  traceDays: 400,
  promptDays: 90,
  messageDays: null,
};

/** The fewest days a company may keep its messages for, and the most it may say. */
export const MESSAGE_DAYS = { least: 30, most: 3650 } as const;

/** How long the rooms' feed of changes is kept: it is how an open room catches up, not anyone's record (STATUS 2.212). */
const ROOM_FEED_DAYS = 14;

export interface RetentionOutcome {
  promptsScrubbed: number;
  journalScrubbed: number;
  tracesPurged: number;
  eventsPurged: number;
  bookkeepingPurged: number;
  workPurged: number;
  /** Messages removed or left without words, and cards whose work went (F19.15). */
  messagesPurged: number;
  /** Room files on disk that no message named any more. */
  roomFilesSwept: number;
  /** Imports whose uploaded parts went: ended, or a week old (STATUS 2.214). */
  importPartsSwept: number;
}

export async function retentionFor(companyId: string): Promise<RetentionPolicy> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      event_days: number;
      trace_days: number;
      prompt_days: number;
      message_days: number | null;
    }>(
      `SELECT event_days, trace_days, prompt_days, message_days
         FROM retention_policies
        WHERE company_id = $1 OR company_id IS NULL
        ORDER BY company_id NULLS LAST
        LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    if (!row) return DEFAULT_RETENTION;
    return {
      eventDays: row.event_days,
      traceDays: row.trace_days,
      promptDays: row.prompt_days,
      messageDays: row.message_days,
    };
  });
}

/**
 * Changes what a policy says, and only what is given. `messageDays` given as
 * null keeps messages again; left out, it is left as it was.
 */
export async function setRetention(
  companyId: string | null,
  policy: Partial<RetentionPolicy>,
): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO retention_policies (company_id, event_days, trace_days, prompt_days, message_days)
       VALUES ($1, coalesce($2, 400), coalesce($3, 400), coalesce($4, 90), $6)
       ON CONFLICT (company_id) DO UPDATE
         SET event_days = coalesce($2, retention_policies.event_days),
             trace_days = coalesce($3, retention_policies.trace_days),
             prompt_days = coalesce($4, retention_policies.prompt_days),
             message_days = CASE WHEN $5 THEN $6 ELSE retention_policies.message_days END`,
      [companyId, policy.eventDays ?? null, policy.traceDays ?? null, policy.promptDays ?? null,
        policy.messageDays !== undefined, policy.messageDays ?? null],
    );
  });
}

/** What a retention pass did, as `retention_action_known` names it (0046, 0105). */
type RetentionAction =
  | 'events_purged' | 'traces_purged' | 'prompts_scrubbed'
  | 'journal_scrubbed' | 'bookkeeping_purged' | 'work_purged' | 'messages_purged';

async function recordRetention(
  tx: TenantClient,
  companyId: string,
  action: RetentionAction,
  rowsAffected: number,
  throughAt: Date,
): Promise<void> {
  if (rowsAffected === 0) return;
  await tx.query(
    `INSERT INTO retention_log (company_id, action, rows_affected, through_at)
     VALUES ($1, $2, $3, $4)`,
    [companyId, action, rowsAffected, throughAt],
  );
}

/**
 * Removes prompt and response bodies past the prompt window.
 *
 * An update rather than a delete: the trace row itself carries the model, the
 * token counts and the cost, which the twelve-month audit and cost history
 * need long after the text is gone.
 */
export async function scrubExpiredPrompts(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - policy.promptDays * 86_400_000);

  return withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      // A NULL prompt is left NULL. It means the runtime never shared it
      // (F11.1 traces what the adapter reports), and overwriting that with the
      // redaction marker would claim retention removed something that was
      // never there.
      `UPDATE llm_traces
          SET prompt = CASE WHEN prompt IS NULL THEN NULL
                            ELSE '{"redacted":"retention"}'::jsonb END,
              response = CASE WHEN response IS NULL THEN NULL
                              ELSE '{"redacted":"retention"}'::jsonb END
        WHERE company_id = $1
          AND occurred_at < $2
          AND ((prompt IS NOT NULL AND prompt <> '{"redacted":"retention"}'::jsonb)
            OR (response IS NOT NULL AND response <> '{"redacted":"retention"}'::jsonb))`,
      [companyId, cutoff],
    );
    // What each run was told (0076) is prompt text too, and goes with it.
    const briefings = await tx.query(
      `UPDATE agent_runs SET briefing = '{"redacted":"retention"}'::jsonb
        WHERE company_id = $1 AND started_at < $2
          AND briefing IS NOT NULL AND briefing <> '{"redacted":"retention"}'::jsonb`,
      [companyId, cutoff],
    );
    const scrubbed = (rowCount ?? 0) + (briefings.rowCount ?? 0);
    await recordRetention(tx, companyId, 'prompts_scrubbed', scrubbed, cutoff);
    return scrubbed;
  });
}

/**
 * Removes model replies from finished tasks' journals past the prompt window.
 *
 * The same text as a trace's response: an `llm` step's output is what the
 * model said. Scrubbing the trace and keeping the journal kept every reply
 * for ever, and F11.5's ninety days held for one copy and not the other.
 *
 * Finished tasks only. A live task replays its journal on resume, and a
 * redaction marker handed back as the model's answer would be worse than the
 * text it replaced; a task that has been live for three months has a
 * different problem, which the stranded sweep is for.
 */
export async function scrubExpiredJournal(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - policy.promptDays * 86_400_000);

  return withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE task_steps step
          SET output = '{"redacted":"retention"}'::jsonb
         FROM tasks task
        WHERE task.id = step.task_id
          AND task.company_id = $1
          -- Set when a task ends and never before, so a live task never
          -- matches.
          AND task.finished_at < $2
          AND step.kind = 'llm'
          AND step.output IS NOT NULL
          AND step.output <> '{"redacted":"retention"}'::jsonb`,
      [companyId, cutoff],
    );
    await recordRetention(tx, companyId, 'journal_scrubbed', rowCount ?? 0, cutoff);
    return rowCount ?? 0;
  });
}

export async function purgeExpiredTraces(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - policy.traceDays * 86_400_000);

  return withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      'DELETE FROM llm_traces WHERE company_id = $1 AND occurred_at < $2',
      [companyId, cutoff],
    );
    await recordRetention(tx, companyId, 'traces_purged', rowCount ?? 0, cutoff);
    return rowCount ?? 0;
  });
}

/**
 * Removes events past the event window.
 *
 * The purge flag is transaction-local, so it is impossible for it to survive
 * this function: it is discarded at COMMIT or ROLLBACK along with everything
 * else in the transaction, whether the purge succeeded, failed or threw.
 */
export async function purgeExpiredEvents(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - policy.eventDays * 86_400_000);

  return withControlPlane(async (tx) => {
    await tx.query('SELECT set_config($1, $2, true)', ['app.retention_purge', 'on']);
    const { rowCount } = await tx.query(
      'DELETE FROM events WHERE company_id = $1 AND occurred_at < $2',
      [companyId, cutoff],
    );
    await recordRetention(tx, companyId, 'events_purged', rowCount ?? 0, cutoff);
    return rowCount ?? 0;
  });
}

/**
 * Removes the platform's own bookkeeping past the event window.
 *
 * Each of these tables records how something got done rather than what was
 * decided -- a notification delivered, a wake consumed, a device challenge
 * issued, a request already answered, an eval run's tally -- and each grew by
 * a row for every such thing, for ever. The event window is the right one:
 * it is the company's own answer to how long its operational history is
 * worth keeping, and these are that history's footnotes.
 *
 * A wake is removed only with every wake folded into it. A folded wake points
 * at the one that absorbed it, and removing the target alone would clear
 * that pointer and make the folded wake look due again.
 */
export async function purgeExpiredBookkeeping(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - policy.eventDays * 86_400_000);

  return withControlPlane(async (tx) => {
    let removed = 0;
    const purge = async (sql: string) => {
      const { rowCount } = await tx.query(sql, [companyId, cutoff]);
      removed += rowCount ?? 0;
    };
    await purge('DELETE FROM owner_notifications WHERE company_id = $1 AND created_at < $2');
    await purge(
      `DELETE FROM wake_queue wake
        WHERE wake.company_id = $1 AND wake.created_at < $2
          AND (wake.consumed_at IS NOT NULL OR wake.coalesced_into IS NOT NULL)
          AND NOT EXISTS (
                SELECT 1 FROM wake_queue folded
                 WHERE folded.coalesced_into = wake.id AND folded.created_at >= $2)`,
    );
    await purge('DELETE FROM gateway_challenges WHERE company_id = $1 AND expires_at < $2');
    await purge('DELETE FROM gateway_dedupe WHERE company_id = $1 AND created_at < $2');
    await purge('DELETE FROM role_eval_runs WHERE company_id = $1 AND ran_at < $2');
    // What changed in the rooms, which an open room catches up from: two
    // weeks, whatever the event window, since it is nobody's record (0150).
    const { rowCount: feed } = await tx.query('DELETE FROM room_feed WHERE company_id = $1 AND created_at < $2',
      [companyId, new Date(now.getTime() - ROOM_FEED_DAYS * 86_400_000)]);
    removed += feed ?? 0;
    // What each person was told outside PALUGADA, and when: a month, whatever
    // the event window, since it is delivery's bookkeeping and nobody's record
    // (STATUS 2.213). Here as well as in the notify planner's hourly pass,
    // because retention runs on every worker and the notify stage does not:
    // a worker started with no owner's channel and no relay plans nothing,
    // and would keep every notice made before for ever.
    const { rowCount: notices } = await tx.query('DELETE FROM people_notices WHERE company_id = $1 AND created_at < $2',
      [companyId, new Date(now.getTime() - NOTICE_DAYS * 86_400_000)]);
    removed += notices ?? 0;
    await recordRetention(tx, companyId, 'bookkeeping_purged', removed, cutoff);
    return removed;
  });
}

/**
 * Removes finished work past both windows, and closed cards that belonged to
 * no task past the event window (M10).
 *
 * The rest of retention removed what was said about the work and kept the
 * work: every task, every step of it with what it was given and what it
 * returned, every run and every card, for ever. A task goes with what hangs
 * from it -- its steps, runs, cards, notes and the events and traces still
 * about it -- so it waits for the later of the two windows that keep those.
 *
 * Work something still points at stays, however old, and so does what it
 * points at in turn:
 *
 *   - anything said about it since the cutoff (an event: the owner's word on
 *     it, a rerun asked for), which also keeps every event a removal would
 *     take inside the window the database holds events to;
 *   - a card about it still open in the owner's inbox, which is the owner's
 *     to close and not retention's;
 *   - a parent of work that stays, since removing a task removes the tasks
 *     under it;
 *   - work a task that stays was asked for again in place of, whose answers
 *     and notes that task still reads (L6);
 *   - work that handed on to a task that stays.
 *
 * Removed from the top of what goes: the database removes what is under it.
 */
export async function purgeExpiredWork(companyId: string, now = new Date()): Promise<number> {
  const policy = await retentionFor(companyId);
  const cutoff = new Date(now.getTime() - Math.max(policy.eventDays, policy.traceDays) * 86_400_000);
  const cardCutoff = new Date(now.getTime() - policy.eventDays * 86_400_000);

  return withControlPlane(async (tx) => {
    // The events a removed task takes with it are removed under the same
    // rule as any purged event, and the database checks each against it.
    await tx.query('SELECT set_config($1, $2, true)', ['app.retention_purge', 'on']);
    const { rows } = await tx.query<{ removed: number }>(
      `WITH RECURSIVE kept AS (
         SELECT t.id, t.parent_task_id FROM tasks t
          WHERE t.company_id = $1
            AND (t.finished_at IS NULL OR t.finished_at >= $2
                 OR EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.occurred_at >= $2)
                 OR EXISTS (SELECT 1 FROM inbox_items i WHERE i.task_id = t.id AND i.status = 'open'))
         UNION
         SELECT held.id, held.parent_task_id
           FROM kept k
           CROSS JOIN LATERAL (
             SELECT p.id, p.parent_task_id FROM tasks p WHERE p.id = k.parent_task_id
             UNION ALL
             SELECT r.id, r.parent_task_id FROM events e
               JOIN tasks r ON r.id = CASE WHEN e.payload->>'rerunOf' ~ '^[0-9a-f-]{36}$'
                                           THEN (e.payload->>'rerunOf')::uuid END
              -- Both records of an instruction (F19.9), though only the owner runs work again.
              WHERE e.task_id = k.id AND e.type IN ('owner.instructed', 'staff.instructed')
             UNION ALL
             SELECT f.id, f.parent_task_id FROM task_handoffs h JOIN tasks f ON f.id = h.from_task_id
              WHERE h.to_task_id = k.id
           ) held
       ),
       gone AS (
         SELECT t.id, t.parent_task_id FROM tasks t
          WHERE t.company_id = $1 AND t.finished_at < $2
            AND NOT EXISTS (SELECT 1 FROM kept WHERE kept.id = t.id)
       ),
       removed AS (
         DELETE FROM tasks t
          WHERE t.id IN (SELECT id FROM gone)
            AND (t.parent_task_id IS NULL OR t.parent_task_id NOT IN (SELECT id FROM gone))
       )
       SELECT count(*)::int AS removed FROM gone`,
      [companyId, cutoff],
    );
    const cards = await tx.query(
      `DELETE FROM inbox_items
        WHERE company_id = $1 AND task_id IS NULL AND status <> 'open'
          AND coalesce(decided_at, created_at) < $2`,
      [companyId, cardCutoff],
    );
    const removed = rows[0]!.removed + (cards.rowCount ?? 0);
    await recordRetention(tx, companyId, 'work_purged', removed, cutoff);
    return removed;
  });
}

/** What one pass of message retention took, by message: so whatever else must forget them is told of each. */
export interface PurgedMessages {
  /** Removed outright, with their reactions, revisions, mentions, pins and files. */
  deleted: string[];
  /** Left in their thread without words or files: a root whose replies are still alive. */
  tombstoned: string[];
  /** Where the bytes of their files were, removed once the transaction has committed. */
  paths: string[];
}

/** The kinds of a card: the platform's drawing of work, a question, an approval or a meeting, which holds no words. */
const CARD_KINDS = ['work', 'question', 'approval', 'meeting'];

/**
 * How many messages one turn of a purge takes at most. Each turn is a
 * transaction of its own that holds the company's room clock, which every
 * post, edit, reaction and read mark of the company takes first, so a turn
 * is kept to well under a second however long the history behind it
 * (STATUS 2.217): a purge of a backlog in one transaction held the clock for
 * minutes and then ran past the pool's statement timeout and kept nothing.
 */
const PURGE_TURN = 2000;

/**
 * Which messages of a turn's kind are still to be taken: spent -- past the
 * window, or a card whose work and item retention took -- and, for a message
 * that began a thread, not the words of a people's meeting that has not yet
 * ended, which wait for it. `$1` is the company; the answer's `values` follow.
 */
function stillToTake(replies: boolean, cutoff: Date | null, now: Date): { where: string; values: unknown[] } {
  const spent = '(m.created_at < $2 OR (m.kind = ANY($3::text[]) AND m.task_id IS NULL AND m.inbox_item_id IS NULL))';
  if (replies) return { where: `m.thread_of IS NOT NULL AND ${spent}`, values: [cutoff, CARD_KINDS] };
  return {
    where: `m.thread_of IS NULL AND ${spent}
            AND NOT EXISTS (SELECT 1 FROM room_meetings g
                             WHERE g.company_id = m.company_id AND g.message_id = m.id AND g.cancelled_at IS NULL
                               AND g.starts_at + make_interval(mins => g.minutes) > $4::timestamptz)`,
    values: [cutoff, CARD_KINDS, now],
  };
}

/**
 * Every message one pass of retention takes, in one place, on the control
 * plane after `roomsOnControlPlane`: replies past the window, and cards whose
 * work or item retention took, go outright; then a message that began a
 * thread and is past the window, or is such a card, goes when no reply is
 * left under it, and otherwise keeps no words (deleted by nobody: its time
 * was up). Each message goes by its own age, so a busy thread keeps none of
 * its old words, and nothing here waits for a thread to fall quiet.
 *
 * But for one: the words of a people's meeting not yet ended at `now`, and
 * not cancelled, wait until it has ended (F19.26, STATUS section 2.215).
 * Those words are the meeting -- taken, it goes with them; left without
 * words, it is cancelled by nobody -- and a meeting may be set up to a year
 * ahead, past any window, so taking them by their age would call off a
 * meeting nobody called off and remind the people asked of nothing. The
 * notes under them are replies like any other, and go by their own age.
 *
 * In turns (`PURGE_TURN`), oldest first, replies before the messages they
 * answer: each turn chooses what it may take without the clock, reading
 * forward from where the last turn stopped, then takes the clock and asks
 * again of just those messages -- a reply posted to an old message, or a
 * removal, is either committed and read then or waits for the turn, so a
 * reply written today is never taken with the message it answers and a
 * removal never fails the pass. A turn writes no feed row per message: it
 * touches each room it changed once, which is what an open room reloads by,
 * and records what it took in the same transaction, so a pass stopped
 * between turns has recorded exactly what it removed.
 *
 * A relay's copy of a message's excerpt is retracted by the worker's notify
 * stage (`retractRemoved`, STATUS section 2.213), which finds each notice
 * whose message is gone or keeps no words, a tombstone left here included.
 * Nothing is called from these transactions: a retraction takes each relay's
 * row first, and taken here it would come after the clock and the
 * messages' rows, the reverse of the order a notice going out takes them.
 */
async function purgeMessages(
  companyId: string, cutoff: Date | null, now: Date, folder: string | null,
): Promise<PurgedMessages> {
  const taken: PurgedMessages = { deleted: [], tombstoned: [], paths: [] };
  for (const replies of [true, false]) {
    const { where, values } = stillToTake(replies, cutoff, now);
    const next = values.length + 2;
    let after = -1;
    for (;;) {
      const { rows: chosen } = await withControlPlane((tx) => tx.query<{ id: string; position: string }>(
        `SELECT m.id, m.position FROM room_messages m
          WHERE m.company_id = $1 AND ${where} AND m.position > $${next}
          ORDER BY m.position LIMIT $${next + 1}`,
        [companyId, ...values, after, PURGE_TURN]));
      if (chosen.length === 0) break;
      after = Number(chosen[chosen.length - 1]!.position);
      const turn = await purgeTurn(companyId, chosen.map((row) => row.id), replies, cutoff, now);
      taken.deleted.push(...turn.deleted);
      taken.tombstoned.push(...turn.tombstoned);
      taken.paths.push(...turn.paths);
      await removeRoomFiles(folder, turn.paths);
      if (chosen.length < PURGE_TURN) break;
    }
  }
  return taken;
}

/**
 * One turn: the messages `ids` names that are still to be taken once the
 * clock is held -- replies outright, or roots outright when nothing is left
 * under them and without words otherwise -- then each room they were in
 * touched once, and the turn recorded.
 */
async function purgeTurn(
  companyId: string, ids: readonly string[], replies: boolean, cutoff: Date | null, now: Date,
): Promise<PurgedMessages> {
  return withControlPlane(async (tx) => {
    await roomsOnControlPlane(tx, companyId, { quiet: true });
    // The company's clock before anything is decided, as every room write takes it first (0150).
    await takeClock(tx);
    const { where, values } = stillToTake(replies, cutoff, now);
    const { rows } = await tx.query<{ id: string; room_id: string; replied: boolean; removed: boolean }>(
      `SELECT m.id, m.room_id, m.deleted_at IS NOT NULL AS removed,
              ${replies ? 'false' : 'EXISTS (SELECT 1 FROM room_messages r WHERE r.company_id = m.company_id AND r.thread_of = m.id)'} AS replied
         FROM room_messages m
        WHERE m.company_id = $1 AND ${where} AND m.id = ANY($${values.length + 2}::uuid[])`,
      [companyId, ...values, ids]);
    const deleted = rows.filter((row) => !row.replied).map((row) => row.id);
    const tombstoned = rows.filter((row) => row.replied && !row.removed).map((row) => row.id);
    const paths = await keptPaths(tx, [...deleted, ...tombstoned]);
    if (deleted.length > 0) {
      await tx.query('DELETE FROM room_messages WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, deleted]);
    }
    if (tombstoned.length > 0) {
      // The control plane's tombstone (0150): the words, revisions and files' paths go, and nobody is named as removing it.
      await tx.query('UPDATE room_messages SET deleted_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, tombstoned]);
    }
    const changed = new Set([...deleted, ...tombstoned]);
    const touched = [...new Set(rows.filter((row) => changed.has(row.id)).map((row) => row.room_id))];
    if (touched.length > 0) {
      // Each room once, no longer quiet: the one change an open stream reloads the room by.
      await roomsOnControlPlane(tx, companyId);
      await tx.query('UPDATE rooms SET name = name WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, touched]);
    }
    await recordRetention(tx, companyId, 'messages_purged', deleted.length + tombstoned.length, cutoff ?? now);
    return { deleted, tombstoned, paths };
  });
}

/**
 * Takes the messages the company's window has passed, and the cards whose
 * work is gone, whatever the window (F19.15). Rooms stay. The bytes of their
 * files are removed after each turn has let them go; a stop between the two
 * leaves bytes for the sweep. Answers what went, by message.
 */
export async function purgeExpiredMessages(companyId: string, now = new Date(), roots: PeopleRoots = {}): Promise<PurgedMessages> {
  const policy = await retentionFor(companyId);
  const cutoff = policy.messageDays === null ? null : new Date(now.getTime() - policy.messageDays * 86_400_000);
  return purgeMessages(companyId, cutoff, now, peopleFolderOf(roots, companyId));
}

/**
 * Applies the whole policy, oldest-risk first.
 *
 * Prompts are scrubbed before traces are purged so that a trace passing both
 * windows is not read for its text on the way out. Messages go after the
 * work, so a card whose work went in this pass goes in it too; and the room
 * files no message names are swept last, and the parts of a Slack import
 * that ended or is a week old with them (STATUS 2.214).
 */
export async function runRetention(
  companyId: string,
  now = new Date(),
  roots: PeopleRoots = {},
): Promise<RetentionOutcome> {
  const promptsScrubbed = await scrubExpiredPrompts(companyId, now);
  const journalScrubbed = await scrubExpiredJournal(companyId, now);
  const tracesPurged = await purgeExpiredTraces(companyId, now);
  const eventsPurged = await purgeExpiredEvents(companyId, now);
  const bookkeepingPurged = await purgeExpiredBookkeeping(companyId, now);
  const workPurged = await purgeExpiredWork(companyId, now);
  const messages = await purgeExpiredMessages(companyId, now, roots);
  const roomFilesSwept = await sweepRoomFiles(companyId, peopleFolderOf(roots, companyId), now);
  const importPartsSwept = await sweepImportParts(companyId, peopleFolderOf(roots, companyId), now);
  return {
    promptsScrubbed, journalScrubbed, tracesPurged, eventsPurged, bookkeepingPurged, workPurged,
    messagesPurged: messages.deleted.length + messages.tombstoned.length, roomFilesSwept, importPartsSwept,
  };
}

export interface RetentionRecord {
  action: string;
  rowsAffected: number;
  throughAt: Date;
}

export async function readRetentionLog(companyId: string): Promise<RetentionRecord[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      action: string;
      rows_affected: number;
      through_at: Date;
    }>(
      'SELECT action, rows_affected, through_at FROM retention_log ORDER BY occurred_at, id',
    );
    return rows.map((row) => ({
      action: row.action,
      rowsAffected: row.rows_affected,
      throughAt: row.through_at,
    }));
  });
}
