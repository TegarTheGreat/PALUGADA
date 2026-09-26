/**
 * What a run says while it works, kept for the owner to read (0055).
 *
 * An agent CLI narrates -- "reading the zone", "the invoice does not match,
 * checking the ledger" -- and the wire threw every line away, so a task that
 * had been running for twenty minutes showed a step count and nothing of what
 * the agent was doing. This keeps the narration per run, in order, beside the
 * task.
 *
 * It is not the journal: nothing is replayed from it and nothing depends on
 * it. So it is kept the way a person would want to read it and no more --
 * redacted like everything else stored (F12.4), each line cut to a length a
 * screen can show, and a run's narration bounded, with the bound saying so,
 * because a runtime that narrated in a loop must not fill the database.
 */
import { withTenant } from '../db/tenant.ts';
import { redactor } from '../secrets/manager.ts';

/** How many lines of one run's narration are kept. */
export const NOTES_PER_RUN = 300;
/** The longest line kept, in characters. */
export const NOTE_MAX_CHARS = 2_000;

export interface RunNote {
  seq: number;
  body: string;
  saidAt: Date;
  agentRunId: string;
  attempt: number;
}

/** The function a run's narration is handed to, one line at a time. */
export function narrator(companyId: string, taskId: string, agentRunId: string): (text: string) => Promise<void> {
  let seq = 0;
  let closed = false;
  return async (text) => {
    if (closed) return;
    const body = redactor.redact(String(text ?? '')).trim();
    if (!body) return;
    seq += 1;
    let kept = body.length > NOTE_MAX_CHARS ? `${body.slice(0, NOTE_MAX_CHARS - 1)}…` : body;
    if (seq > NOTES_PER_RUN) {
      closed = true;
      kept = `[${NOTES_PER_RUN} lines kept; no more of this run's narration is kept]`;
    }
    await withTenant(companyId, (tx) => tx.query(
      `INSERT INTO run_notes (company_id, task_id, agent_run_id, seq, body)
       VALUES ($1, $2, $3, $4, $5)`,
      [companyId, taskId, agentRunId, seq, kept],
    ));
  };
}

/** A task's narration, every run of it, oldest first; at most `limit` lines from the end. */
export async function transcriptOf(companyId: string, taskId: string, limit = 500): Promise<RunNote[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      seq: number; body: string; said_at: Date; agent_run_id: string; attempt: number;
    }>(
      `SELECT * FROM (
         SELECT n.seq, n.body, n.said_at, n.agent_run_id, r.attempt
           FROM run_notes n JOIN agent_runs r ON r.id = n.agent_run_id
          WHERE n.task_id = $1
          ORDER BY n.said_at DESC, n.seq DESC
          LIMIT $2) recent
        ORDER BY said_at, seq`,
      [taskId, Math.min(Math.max(limit, 1), 2_000)],
    );
    return rows.map((row) => ({
      seq: row.seq, body: row.body, saidAt: row.said_at, agentRunId: row.agent_run_id, attempt: row.attempt,
    }));
  });
}
