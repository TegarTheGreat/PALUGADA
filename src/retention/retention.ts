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
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';

export interface RetentionPolicy {
  eventDays: number;
  traceDays: number;
  promptDays: number;
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
};

export interface RetentionOutcome {
  promptsScrubbed: number;
  journalScrubbed: number;
  tracesPurged: number;
  eventsPurged: number;
  bookkeepingPurged: number;
}

export async function retentionFor(companyId: string): Promise<RetentionPolicy> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      event_days: number;
      trace_days: number;
      prompt_days: number;
    }>(
      `SELECT event_days, trace_days, prompt_days
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
    };
  });
}

export async function setRetention(
  companyId: string | null,
  policy: Partial<RetentionPolicy>,
): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO retention_policies (company_id, event_days, trace_days, prompt_days)
       VALUES ($1, coalesce($2, 400), coalesce($3, 400), coalesce($4, 90))
       ON CONFLICT (company_id) DO UPDATE
         SET event_days = coalesce($2, retention_policies.event_days),
             trace_days = coalesce($3, retention_policies.trace_days),
             prompt_days = coalesce($4, retention_policies.prompt_days)`,
      [companyId, policy.eventDays ?? null, policy.traceDays ?? null, policy.promptDays ?? null],
    );
  });
}

/** What a retention pass did, as `retention_action_known` names it (0046). */
type RetentionAction =
  | 'events_purged' | 'traces_purged' | 'prompts_scrubbed'
  | 'journal_scrubbed' | 'bookkeeping_purged';

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
    await recordRetention(tx, companyId, 'bookkeeping_purged', removed, cutoff);
    return removed;
  });
}

/**
 * Applies the whole policy, oldest-risk first.
 *
 * Prompts are scrubbed before traces are purged so that a trace passing both
 * windows is not read for its text on the way out.
 */
export async function runRetention(
  companyId: string,
  now = new Date(),
): Promise<RetentionOutcome> {
  const promptsScrubbed = await scrubExpiredPrompts(companyId, now);
  const journalScrubbed = await scrubExpiredJournal(companyId, now);
  const tracesPurged = await purgeExpiredTraces(companyId, now);
  const eventsPurged = await purgeExpiredEvents(companyId, now);
  const bookkeepingPurged = await purgeExpiredBookkeeping(companyId, now);
  return { promptsScrubbed, journalScrubbed, tracesPurged, eventsPurged, bookkeepingPurged };
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
