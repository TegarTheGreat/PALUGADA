/**
 * F5.7, its second half: a place for each call to a capability a division
 * may have in flight at once (0091).
 *
 * The grant says how many (`max_in_flight`). A call takes a free place
 * before it reaches the vendor and gives it back when the vendor has
 * answered, and because the places are rows every worker counts the same
 * calls. A place is free when nobody holds it, or when whoever holds it no
 * longer holds the task's lease: a worker that died mid-call gives its place
 * back when its lease lapses, without anyone having to notice it died. A
 * call made outside any lease -- the owner's own, a test -- holds a place for
 * fifteen minutes at most.
 *
 * Takers of one capability's places in one division take turns, on an
 * advisory lock held to the end of the transaction. `FOR UPDATE SKIP LOCKED`
 * alone was not enough (the review of d1b8142): a place taken and committed
 * between a second taker's snapshot and its lock was re-checked by
 * PostgreSQL against the row's new version but the old join, found "free",
 * and taken again -- two calls in flight on a limit of one. After the lock,
 * each taker's statement sees every place taken before it.
 *
 * Every live holder counts against the limit, whichever place it holds, so a
 * limit lowered while calls are running holds at once rather than when they
 * end.
 */
import { withTenant } from '../db/tenant.ts';

/**
 * The most calls a grant may allow in flight at once. A place is a row, made
 * the first time it is wanted: a limit in the millions was a million rows on
 * the first call, and a probe of each on every one after.
 */
export const MAX_IN_FLIGHT = 100;

export interface PlaceHolder {
  companyId: string;
  divisionId: string;
  capability: string;
  taskId: string;
  /** The call's own idempotency key: what it gives the place back by. */
  holderKey: string;
}

/** Takes a free place, if the limit leaves one. */
export async function takePlace(holder: PlaceHolder, limit: number): Promise<boolean> {
  const places = Math.min(Math.max(1, Math.floor(limit)), MAX_IN_FLIGHT);
  return withTenant(holder.companyId, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('capability-places:' || $1 || ':' || $2))",
      [holder.divisionId, holder.capability]);
    // The places are made the first time they are wanted, and a raised
    // limit makes the new ones; a lowered one leaves the extra ones unused.
    await tx.query(
      `INSERT INTO capability_places (company_id, division_id, capability_name, place)
       SELECT $1, $2, $3, n FROM generate_series(1, $4::int) AS n
       ON CONFLICT DO NOTHING`,
      [holder.companyId, holder.divisionId, holder.capability, places],
    );
    const { rows } = await tx.query<{ place: number }>(
      `WITH live AS (
         -- Held by a call still being made: its task still holds the lease
         -- it held when it took the place, or, outside any lease, taken in
         -- the last fifteen minutes. The same call again -- an attempt that
         -- could not say it was done before it was retried -- is not in the
         -- way of itself.
         SELECT s.place FROM capability_places s JOIN tasks t ON t.id = s.task_id
          WHERE s.division_id = $1 AND s.capability_name = $2
            AND s.holder_key IS NOT NULL AND s.holder_key <> $5
            AND t.lease_holder IS NOT DISTINCT FROM s.lease_holder
            AND ((s.lease_holder IS NOT NULL AND t.lease_expires_at > now())
                 OR (s.lease_holder IS NULL AND s.taken_at > now() - interval '15 minutes'))
       )
       UPDATE capability_places p
          SET task_id = $4, holder_key = $5, taken_at = now(),
              lease_holder = (SELECT lease_holder FROM tasks WHERE id = $4)
        WHERE (SELECT count(*) FROM live) < $3
          AND (p.division_id, p.capability_name, p.place) = (
            SELECT s.division_id, s.capability_name, s.place
              FROM capability_places s
             WHERE s.division_id = $1 AND s.capability_name = $2 AND s.place <= $3
               AND s.place NOT IN (SELECT place FROM live)
             ORDER BY s.holder_key IS NOT DISTINCT FROM $5 DESC, s.place
             LIMIT 1
             FOR UPDATE OF s)
        RETURNING p.place`,
      [holder.divisionId, holder.capability, places, holder.taskId, holder.holderKey],
    );
    return rows.length > 0;
  });
}

/** Gives the place back; a place another call has since taken is left alone. */
export async function givePlaceBack(holder: PlaceHolder): Promise<void> {
  await withTenant(holder.companyId, (tx) => tx.query(
    `UPDATE capability_places
        SET task_id = NULL, holder_key = NULL, lease_holder = NULL, taken_at = NULL
      WHERE division_id = $1 AND capability_name = $2 AND holder_key = $3`,
    [holder.divisionId, holder.capability, holder.holderKey],
  ));
}
