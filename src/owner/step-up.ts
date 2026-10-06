/**
 * How long a code the owner just showed keeps covering what builds the
 * company (0120).
 *
 * A second factor is single use, so a console that asked for one per change
 * had the owner reach for their phone for every division, role and goal of a
 * company they were setting up. A code or passkey shown for an action -- or
 * to sign in -- now opens a window of this many minutes in which the actions
 * the API marks as covered need no new one (`WITHIN_THE_WINDOW`, api.ts).
 * Zero asks every time, as before. Raising it loosens, so it takes a code;
 * lowering does not.
 */
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

/** The lengths offered; the database holds the same list. */
export const STEP_UP_CHOICES = [0, 5, 10, 30, 60] as const;

export async function stepUpMinutes(): Promise<number> {
  const { rows } = await withControlPlane((tx) => tx.query<{ step_up_minutes: number }>('SELECT step_up_minutes FROM platform_control'));
  return rows[0]?.step_up_minutes ?? 0;
}

export function checkedStepUp(minutes: unknown): number {
  if (typeof minutes !== 'number' || !(STEP_UP_CHOICES as readonly number[]).includes(minutes)) {
    throw new PalugadaError('contract.violation',
      `the window is one of ${STEP_UP_CHOICES.join(', ')} minutes; 0 asks for a code every time`, { field: 'minutes' });
  }
  return minutes;
}

export async function setStepUpMinutes(minutes: number): Promise<void> {
  await withControlPlane((tx) => tx.query('UPDATE platform_control SET step_up_minutes = $1, updated_at = now()', [minutes]));
}

/** Whether a proof at `provedAt` still covers, for a window of `minutes`, at `now`. */
export function withinWindow(provedAt: Date | null, minutes: number, now: Date): boolean {
  return provedAt !== null && minutes > 0 && now.getTime() < provedAt.getTime() + minutes * 60_000;
}
