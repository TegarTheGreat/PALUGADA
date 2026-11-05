/**
 * The company's fiscal quarters (F18.9, 0144).
 *
 * A quarter used to be read from a period's length alone (goals.ts, 92 days
 * or fewer), because nothing said where a company's year starts. Quarterly
 * planning needs to know which quarter today is in and when it ends, so the
 * owner says which month the fiscal year starts in (January by default, a
 * calendar year), and the quarters are cut from it: three months each, the
 * first starting on the first of that month.
 *
 * A fiscal year is named by the calendar year it starts in: the year that
 * runs from April 2026 to March 2027 is 2026, as India and Japan name theirs.
 * The other custom, naming it by the year it ends in, is the United States
 * government's; a company whose year is the calendar year reads the same
 * under both.
 */
import { wallClockAt } from '../scheduler/windows.ts';

export interface FiscalQuarter {
  /** `<fiscal year>-Q<n>`, the key quarterly planning is made once under. */
  label: string;
  fiscalYear: number;
  quarter: 1 | 2 | 3 | 4;
  /** The quarter's first and last day, YYYY-MM-DD. */
  startsOn: string;
  endsOn: string;
  /** The fiscal year's first and last day. */
  yearStartsOn: string;
  yearEndsOn: string;
}

/** A day of a month counted from January of `year`, which may run past December. */
function dayOf(year: number, monthIndex: number, day: number): string {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/** The fiscal quarter a day (YYYY-MM-DD) is in, for a year starting in `startMonth` (1 to 12). */
export function fiscalQuarterOf(day: string, startMonth: number): FiscalQuarter {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const first = Number.isInteger(startMonth) && startMonth >= 1 && startMonth <= 12 ? startMonth : 1;
  const fiscalYear = month >= first ? year : year - 1;
  const monthsIn = (month - first + 12) % 12;
  const quarter = (Math.floor(monthsIn / 3) + 1) as FiscalQuarter['quarter'];
  const opens = first - 1 + (quarter - 1) * 3;
  return {
    label: `${fiscalYear}-Q${quarter}`,
    fiscalYear,
    quarter,
    startsOn: dayOf(fiscalYear, opens, 1),
    // Day 0 of the month after is the last day of this one.
    endsOn: dayOf(fiscalYear, opens + 3, 0),
    yearStartsOn: dayOf(fiscalYear, first - 1, 1),
    yearEndsOn: dayOf(fiscalYear, first - 1 + 12, 0),
  };
}

/** The day `days` after a day, both YYYY-MM-DD. */
export function dayAfter(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The day it is at `at` where a company is, YYYY-MM-DD, with the zone read.
 * A zone this platform cannot read keeps UTC rather than no day at all.
 */
export function dayIn(timezone: string, at: Date): { day: string; timezone: string } {
  try {
    return { day: new Date(wallClockAt(timezone, at.getTime())).toISOString().slice(0, 10), timezone };
  } catch {
    return { day: new Date(wallClockAt('UTC', at.getTime())).toISOString().slice(0, 10), timezone: 'UTC' };
  }
}
