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
 * `FOR UPDATE SKIP LOCKED` is what makes two workers that want the last
 * place at the same moment take it once: the second skips the row the first
 * is taking, and finds none.
 */
import { withTenant } from '../db/tenant.ts';

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
  return withTenant(holder.companyId, async (tx) => {
    // The places are made the first time they are wanted, and a raised
    // limit makes the new ones; a lowered one leaves the extra ones unused.
    await tx.query(
      `INSERT INTO capability_places (company_id, division_id, capability_name, place)
       SELECT $1, $2, $3, n FROM generate_series(1, $4::int) AS n
       ON CONFLICT DO NOTHING`,
      [holder.companyId, holder.divisionId, holder.capability, limit],
    );
    const { rows } = await tx.query<{ place: number }>(
      `UPDATE capability_places p
          SET task_id = $4, holder_key = $5, taken_at = now(),
              lease_holder = (SELECT lease_holder FROM tasks WHERE id = $4)
        WHERE (p.division_id, p.capability_name, p.place) = (
          SELECT s.division_id, s.capability_name, s.place
            FROM capability_places s
            LEFT JOIN tasks t ON t.id = s.task_id
           WHERE s.division_id = $1 AND s.capability_name = $2 AND s.place <= $3
             AND (s.holder_key IS NULL
                  -- The same call again: an attempt that could not say it
                  -- was done before it was retried.
                  OR s.holder_key = $5
                  OR t.id IS NULL
                  OR t.lease_holder IS DISTINCT FROM s.lease_holder
                  OR (s.lease_holder IS NOT NULL AND t.lease_expires_at <= now())
                  OR (s.lease_holder IS NULL AND s.taken_at <= now() - interval '15 minutes'))
           ORDER BY s.place
           LIMIT 1
           FOR UPDATE OF s SKIP LOCKED)
        RETURNING p.place`,
      [holder.divisionId, holder.capability, limit, holder.taskId, holder.holderKey],
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
