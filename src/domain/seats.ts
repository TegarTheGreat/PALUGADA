/**
 * Seats and accountabilities (PRD v2 F18.3; docs/STATUS.md 2.192).
 *
 * A role is a seat with exactly one occupant -- an agent, or a person the
 * owner hired -- so "one name in each seat" holds by construction. What a
 * seat lacked was a short list of what it answers for. The CEO handed work on
 * by the first sentence of each charter, which says what a role does and not
 * which results are its own, so two seats could both take a customer's
 * renewal, or neither.
 *
 * The list is the owner's, changed as the charter is (F2.9, versioned). The
 * checks below are what the chart shows the owner, and never what refuses a
 * change: a company being reorganised has a seat with nothing on it for a
 * while, and refusing that would make the owner write a placeholder to get
 * past the form.
 */
import { PalugadaError } from '../errors.ts';

/**
 * The most a seat answers for. More is a seat that answers for nothing in
 * particular; the operating methods this follows put the bound at five, and
 * migration 0138 holds the database to it.
 */
const ACCOUNTABILITIES_LIMIT = 5;
/** One line saying what the seat answers for: a result, not a procedure (0138). */
const ACCOUNTABILITY_LENGTH = 200;

/**
 * The form two accountabilities are compared in: the same words, whatever
 * their case or spacing. "Customer renewals" and "customer  renewals" are the
 * same claim, and the owner who typed them meant one.
 */
function sameWords(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * A seat's accountabilities from what was given: trimmed, blank lines
 * dropped, the same one said twice kept once, and few and short enough that
 * every run of the seat can be told them. An empty list is allowed: it is a
 * seat the chart names as having none.
 */
export function accountabilitiesFrom(lines: readonly unknown[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = String(line).trim().replace(/[ \t]+/g, ' ');
    if (text === '') continue;
    if (/[\r\n]/.test(text)) {
      throw new PalugadaError('contract.violation',
        `an accountability is one line; give each its own entry rather than "${text.slice(0, 60)}" over several lines`,
        { field: 'accountabilities' });
    }
    if (text.length > ACCOUNTABILITY_LENGTH) {
      throw new PalugadaError('contract.violation',
        `an accountability is at most ${ACCOUNTABILITY_LENGTH} characters, one line saying what the seat answers for; this one is ${text.length}`,
        { field: 'accountabilities' });
    }
    const key = sameWords(text);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  if (kept.length > ACCOUNTABILITIES_LIMIT) {
    throw new PalugadaError('contract.violation',
      `a seat has at most ${ACCOUNTABILITIES_LIMIT} accountabilities, and ${kept.length} were given: keep the ones it answers for and give the rest to another seat`,
      { field: 'accountabilities' });
  }
  return kept;
}

/** What the chart warns the owner of: shown, never refused. */
export interface SeatChecks {
  /** The seats, by role id, that answer for nothing yet. */
  withoutAccountabilities: string[];
  /**
   * An accountability two or more seats claim in the same words, written as
   * the first of them wrote it, with every seat that claims it. One result
   * with two seats answering for it is one nobody answers for.
   */
  sharedAccountabilities: Array<{ accountability: string; roleIds: string[] }>;
}

/** The checks over every seat in the company, in the order the seats are given. */
export function seatChecksOf(seats: ReadonlyArray<{ id: string; accountabilities: readonly string[] }>): SeatChecks {
  const claims = new Map<string, { accountability: string; roleIds: string[] }>();
  for (const seat of seats) {
    for (const accountability of seat.accountabilities) {
      const key = sameWords(accountability);
      const claim = claims.get(key) ?? { accountability, roleIds: [] };
      if (!claim.roleIds.includes(seat.id)) claim.roleIds.push(seat.id);
      claims.set(key, claim);
    }
  }
  return {
    withoutAccountabilities: seats.filter((seat) => seat.accountabilities.length === 0).map((seat) => seat.id),
    sharedAccountabilities: [...claims.values()].filter((claim) => claim.roleIds.length > 1),
  };
}
