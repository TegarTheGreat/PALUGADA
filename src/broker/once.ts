/**
 * A write the platform keeps itself, made once for each call (0131).
 *
 * The engine keys a tool call by what it does (journal.ts, `callKey`) and
 * journals it when the broker answers. Between a capability committing its
 * write and that answer being kept, a worker can die; the step then runs
 * again under the same key, and a write that does not know the key makes
 * itself twice. A writer that runs inside `once` keeps its answer under the
 * key in the transaction that writes, so the second run finds it and answers
 * the same way, writing nothing.
 *
 * What the key says is "the same call", not "the same words": the engine gives
 * a second call with the same input in the same task the same key, which is
 * why two identical entries a run means to make are made by two calls the run
 * tells apart (a different memo or date), as a person would write them.
 */
import type { CapabilityContext } from './registry.ts';
import type { TenantClient } from '../db/tenant.ts';

/**
 * Runs `write` once for this call: inside `tx`, which must be the transaction
 * the write is made in, so that the write and the record of it commit or
 * vanish together. Two runs of the same call at the same moment queue on the
 * key; the second reads what the first wrote.
 */
export async function once<T>(
  tx: TenantClient,
  ctx: Pick<CapabilityContext, 'companyId' | 'taskId' | 'idempotencyKey'>,
  capability: string,
  write: () => Promise<T>,
): Promise<T> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
    [`call:${ctx.companyId}:${capability}:${ctx.idempotencyKey}`]);
  const { rows } = await tx.query<{ answer: T }>(
    'SELECT answer FROM call_answers WHERE company_id = $1 AND capability = $2 AND call_key = $3',
    [ctx.companyId, capability, ctx.idempotencyKey]);
  if (rows[0]) return rows[0].answer;
  const answer = await write();
  await tx.query(
    `INSERT INTO call_answers (company_id, capability, call_key, task_id, answer)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [ctx.companyId, capability, ctx.idempotencyKey, ctx.taskId, JSON.stringify(answer ?? null)]);
  return answer;
}
