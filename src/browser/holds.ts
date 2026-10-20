/**
 * The owner holding a company's browser (0114).
 *
 * Taken over with the owner's device, from the console; while it is held the
 * company's work waits (`capability.busy`, which parks a task and brings it
 * back), so nothing reads or acts under the owner's hands. Each input the
 * owner sends keeps it held; fifteen minutes without one and it has lapsed,
 * so a console left open does not stop the company. Giving it back answers
 * every question a role asked to be signed in (`browser.handover`).
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

/** How long a hold lasts without the owner's hand on it. */
export const HOLD_LAPSES_MINUTES = 15;

export interface Hold {
  since: string;
  touchedAt: string;
}

/** The hold, if the owner has the company's browser now; read as the company's work reads it. */
export async function holdOf(companyId: string): Promise<Hold | null> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ held_since: Date; touched_at: Date }>(
      `SELECT held_since, touched_at FROM browser_holds
        WHERE company_id = $1 AND touched_at > now() - make_interval(mins => $2)`, [companyId, HOLD_LAPSES_MINUTES]);
    return rows[0] ? { since: rows[0].held_since.toISOString(), touchedAt: rows[0].touched_at.toISOString() } : null;
  });
}

/** Refuses the company's work while the owner holds its browser, until a minute from now. */
export async function assertNotHeld(companyId: string, capability: string): Promise<void> {
  if (!(await holdOf(companyId))) return;
  throw new PalugadaError('capability.busy',
    'the owner has taken the company\'s browser over; this waits until they give it back', {
      capability, notBefore: new Date(Date.now() + 60_000).toISOString(), source: 'browser_hold',
    });
}

/** Takes it over, or keeps holding it; said once, when it is taken. */
export async function takeOver(companyId: string): Promise<Hold> {
  return withControlPlane(async (tx) => {
    const { rows: [before] } = await tx.query<{ live: boolean }>(
      `SELECT touched_at > now() - make_interval(mins => $2) AS live FROM browser_holds WHERE company_id = $1 FOR UPDATE`,
      [companyId, HOLD_LAPSES_MINUTES]);
    const { rows: [held] } = await tx.query<{ held_since: Date; touched_at: Date }>(
      `INSERT INTO browser_holds (company_id) VALUES ($1)
       ON CONFLICT (company_id) DO UPDATE
         SET held_since = CASE WHEN $2 THEN browser_holds.held_since ELSE now() END, touched_at = now()
       RETURNING held_since, touched_at`, [companyId, before?.live === true]);
    if (!before?.live) {
      await appendEvent(tx, { companyId, type: 'browser.taken_over', actor: 'owner', payload: {} });
    }
    return { since: held!.held_since.toISOString(), touchedAt: held!.touched_at.toISOString() };
  });
}

/** Keeps a live hold from lapsing; refuses when there is none. */
export async function touchHold(companyId: string): Promise<void> {
  const { rowCount } = await withControlPlane((tx) => tx.query(
    `UPDATE browser_holds SET touched_at = now()
      WHERE company_id = $1 AND touched_at > now() - make_interval(mins => $2)`, [companyId, HOLD_LAPSES_MINUTES]));
  if (rowCount === 0) {
    throw new PalugadaError('browser.not_held',
      'take the company\'s browser over first: nothing is typed into a browser the company\'s work may be using', {});
  }
}

/** Gives it back; answers whether there was a hold to give. */
export async function giveBack(companyId: string): Promise<boolean> {
  return withControlPlane(async (tx) => {
    const { rowCount } = await tx.query('DELETE FROM browser_holds WHERE company_id = $1', [companyId]);
    if (rowCount === 0) return false;
    await appendEvent(tx, { companyId, type: 'browser.given_back', actor: 'owner', payload: {} });
    return true;
  });
}
