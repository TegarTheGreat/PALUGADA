/**
 * Time windows (PRD F9.2, F9.3, F9.6).
 *
 * F9.6 is the point worth keeping in view: there is no such thing as an
 * agent's working hours. Agents run around the clock. What is restricted is
 * when an action may touch the outside world, and when the owner may be
 * disturbed. Those are two different windows with two different reasons, so
 * they are two separate functions here.
 *
 * All arithmetic is done through Intl in a named IANA zone rather than by
 * adding offsets, so daylight saving transitions are handled by the platform's
 * time zone database instead of by assumptions that break twice a year.
 */
import { withTenant, withControlPlane, type TenantClient } from '../db/tenant.ts';

export interface LocalTime {
  hour: number;
  /** 0 = Sunday, matching the days_of_week column. */
  dayOfWeek: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export function localTimeIn(timezone: string, instant: Date): LocalTime {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(instant);

  const hourPart = parts.find((part) => part.type === 'hour')?.value ?? '0';
  const weekdayPart = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';

  // hour12:false yields 24 for midnight in some ICU versions.
  const hour = Number(hourPart) % 24;
  return { hour, dayOfWeek: WEEKDAY_INDEX[weekdayPart] ?? 0 };
}

export interface Window {
  timezone: string;
  startHour: number;
  endHour: number;
  daysOfWeek: number[];
}

/**
 * Whether an instant falls inside a window.
 *
 * The interval is half-open, [start, end), and a window whose start is after
 * its end wraps past midnight -- a 22:00-06:00 window is one window, not two.
 * For a wrapping window the day is judged by the day the window opened, so the
 * small hours belong to the previous evening rather than being dropped.
 */
export function isWithin(window: Window, instant: Date): boolean {
  const { hour, dayOfWeek } = localTimeIn(window.timezone, instant);
  const wraps = window.startHour > window.endHour;

  if (!wraps) {
    return window.daysOfWeek.includes(dayOfWeek) && hour >= window.startHour && hour < window.endHour;
  }

  if (hour >= window.startHour) {
    return window.daysOfWeek.includes(dayOfWeek);
  }
  if (hour < window.endHour) {
    const previousDay = (dayOfWeek + 6) % 7;
    return window.daysOfWeek.includes(previousDay);
  }
  return false;
}

const HOUR_MS = 3_600_000;
const SEARCH_HORIZON_HOURS = 24 * 8;

/**
 * The next instant at which the window is open.
 *
 * Stepping hour by hour rather than computing the boundary directly: windows
 * are hour-granular, the horizon is eight days, and the straightforward loop
 * is correct across daylight saving shifts and arbitrary day sets, where
 * closed-form date arithmetic is where these functions usually go wrong.
 * Returns null when the window never opens within the horizon, which means a
 * misconfigured day set rather than a long wait.
 */
export function nextOpening(window: Window, from: Date): Date | null {
  if (isWithin(window, from)) return from;

  const cursor = new Date(Math.ceil(from.getTime() / HOUR_MS) * HOUR_MS);
  for (let step = 0; step < SEARCH_HORIZON_HOURS; step += 1) {
    const candidate = new Date(cursor.getTime() + step * HOUR_MS);
    if (isWithin(window, candidate)) return candidate;
  }
  return null;
}

/**
 * The window governing one capability for one division (F9.2).
 *
 * A division-specific row wins over the company-wide row for the same
 * capability, so a stricter local rule is possible without restating the
 * general one.
 */
export async function capabilityWindow(
  tx: TenantClient,
  divisionId: string,
  capabilityName: string,
): Promise<Window | null> {
  const { rows } = await tx.query<{
    timezone: string;
    start_hour: number;
    end_hour: number;
    days_of_week: number[];
  }>(
    `SELECT timezone, start_hour, end_hour, days_of_week
       FROM capability_windows
      WHERE capability_name = $1
        AND (division_id = $2 OR division_id IS NULL)
      ORDER BY division_id NULLS LAST
      LIMIT 1`,
    [capabilityName, divisionId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    timezone: row.timezone,
    startHour: row.start_hour,
    endHour: row.end_hour,
    daysOfWeek: row.days_of_week,
  };
}

/**
 * The company's cheap hours, if it has declared any (F9.5).
 *
 * Absent is the normal state and means "there are no cheap hours here", not
 * "any hour will do": a company with no window runs its batchable work
 * immediately, because deferring it would be waiting for a discount that does
 * not exist.
 */
export async function batchWindow(
  tx: TenantClient,
  companyId: string,
): Promise<Window | null> {
  const { rows } = await tx.query<{
    timezone: string;
    start_hour: number;
    end_hour: number;
    days_of_week: number[];
  }>(
    `SELECT timezone, start_hour, end_hour, days_of_week
       FROM batch_windows WHERE company_id = $1`,
    [companyId],
  );

  const row = rows[0];
  if (!row) return null;
  return {
    timezone: row.timezone,
    startHour: row.start_hour,
    endHour: row.end_hour,
    daysOfWeek: row.days_of_week,
  };
}

export async function setBatchWindow(input: {
  companyId: string;
  timezone: string;
  startHour: number;
  endHour: number;
  daysOfWeek?: number[];
}): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `INSERT INTO batch_windows (company_id, timezone, start_hour, end_hour, days_of_week)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id) DO UPDATE
         SET timezone = EXCLUDED.timezone,
             start_hour = EXCLUDED.start_hour,
             end_hour = EXCLUDED.end_hour,
             days_of_week = EXCLUDED.days_of_week`,
      [
        input.companyId,
        input.timezone,
        input.startHour,
        input.endHour,
        input.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
      ],
    );
  });
}

export interface OwnerWindow extends Window {}

export async function ownerWindow(): Promise<OwnerWindow> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      owner_timezone: string;
      owner_window_start_hour: number;
      owner_window_end_hour: number;
    }>(
      `SELECT owner_timezone, owner_window_start_hour, owner_window_end_hour
         FROM platform_control`,
    );
    const row = rows[0]!;
    return {
      timezone: row.owner_timezone,
      startHour: row.owner_window_start_hour,
      endHour: row.owner_window_end_hour,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    };
  });
}

export async function setOwnerWindow(input: {
  timezone: string;
  startHour: number;
  endHour: number;
}): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE platform_control
          SET owner_timezone = $1,
              owner_window_start_hour = $2,
              owner_window_end_hour = $3,
              updated_at = now()`,
      [input.timezone, input.startHour, input.endHour],
    );
  });
}

/**
 * Kinds of inbox item that may wake the owner outside their window (F9.3).
 *
 * Section 14.5 leaves the definition of an emergency open, so this is the
 * conservative reading rather than a settled answer: an incident is something
 * already going wrong, and a tier 3 approval is an irreversible action waiting
 * on a human. Everything else waits. Widening this list is an owner decision,
 * not an engineering one, which is why it is a named constant instead of a
 * condition buried in a query.
 */
export const BREAKS_OWNER_WINDOW: ReadonlySet<string> = new Set(['incident']);

/**
 * When the owner may be notified about an item.
 *
 * Returns `now` for anything urgent enough to break the window, otherwise the
 * next moment the window opens.
 */
export async function notifyAfterFor(
  kind: string,
  options: { tier?: number | null | undefined; now?: Date } = {},
): Promise<Date> {
  const now = options.now ?? new Date();
  if (BREAKS_OWNER_WINDOW.has(kind)) return now;
  if (kind === 'approval' && (options.tier ?? 0) >= 3) return now;

  const window = await ownerWindow();
  return nextOpening(window, now) ?? now;
}

/** Items the owner may be shown right now. */
export async function pendingNotifications(
  companyId: string,
  now = new Date(),
): Promise<Array<{ id: string; kind: string; title: string }>> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string; kind: string; title: string }>(
      `SELECT id, kind, title FROM inbox_items
        WHERE status = 'open' AND notify_after <= $1
        ORDER BY created_at`,
      [now],
    );
    return rows;
  });
}
