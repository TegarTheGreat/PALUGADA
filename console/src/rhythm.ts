/**
 * The weekly scorecard's three fields on a measure (0137): how often it is
 * reviewed, the seat that answers for it, and the measure it is watched with.
 *
 * Kept apart from the forms, and touching nothing of the page, so the suite
 * can run what a form sends.
 */
import type { Metric } from './types.ts';

export interface Rhythm {
  reviewEvery: 'week' | null;
  ownerRoleId: string | null;
  pairedWith: string | null;
}

/** A measure's three fields as the form starts them. */
export function rhythmOf(metric: Pick<Metric, 'reviewEvery' | 'ownerRoleId' | 'pairedWith'>): Rhythm {
  return { reviewEvery: metric.reviewEvery, ownerRoleId: metric.ownerRoleId, pairedWith: metric.pairedWith };
}

/**
 * Only the fields the owner changed in the form: those that differ from what
 * the form was opened with (`started`). A pair is written on two rows, so
 * pairing one measure changes another's partner behind that other's form; a
 * form that sent every field would put back whatever partner it was opened
 * with, and undo -- or remake -- a pair the owner never touched in it.
 */
export function rhythmChanges(started: Rhythm, form: Rhythm): Partial<Rhythm> {
  const changes: Partial<Rhythm> = {};
  if (form.reviewEvery !== started.reviewEvery) changes.reviewEvery = form.reviewEvery;
  if (form.ownerRoleId !== started.ownerRoleId) changes.ownerRoleId = form.ownerRoleId;
  if (form.pairedWith !== started.pairedWith) changes.pairedWith = form.pairedWith;
  return changes;
}
