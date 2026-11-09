/**
 * A person's own settings: the language they read the console in, their
 * time zone and quiet hours, how many notices a day they are sent, whether a
 * hidden tab may show them one, and, for the owner alone, whether people
 * reach them outside the inbox at all (F19.2, F19.22, F10.5; STATUS 2.209).
 *
 * Kept in `principal_prefs` (0149), the control plane's alone: when a person
 * sleeps is nobody's business but theirs and the platform's that respects
 * it, and no agent reads it. A row is made the first time a person sets
 * something; until then each setting is its default, and the owner's notices
 * a day are fewer than a seat's, since the owner's attention is the scarcest
 * thing the deployment has.
 */
import { withControlPlane } from '../db/tenant.ts';
import { languageCode } from '../domain/language.ts';
import { PalugadaError } from '../errors.ts';

export interface Settings {
  /** Null: the deployment's console language. */
  language: string | null;
  /** Null: the company's. */
  timezone: string | null;
  quietStart: number | null;
  quietEnd: number | null;
  notifyInTab: boolean;
  noticesPerDay: number;
  /** Meaningful for the owner only, and off until the owner turns it on. */
  ownerHearsPeople: boolean;
}

export type SettingsChange = Partial<Settings>;

/** A seat's notices a day unless it says otherwise (0149's default), and the owner's. */
const SEAT_NOTICES = 30;
const OWNER_NOTICES = 10;

const defaults = (principal: string): Settings => ({
  language: null, timezone: null, quietStart: null, quietEnd: null, notifyInTab: true,
  noticesPerDay: principal === 'owner' ? OWNER_NOTICES : SEAT_NOTICES, ownerHearsPeople: false,
});

function hour(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
    throw new PalugadaError('contract.violation', `${field} is an hour, 0 to 23, or null for no quiet hours`, { field });
  }
  return value;
}

/** A time zone the platform knows by its IANA name, such as Asia/Jakarta; null for the company's. */
function timezoneOf(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && value.length <= 64) {
    try {
      // Intl knows every IANA zone, and throws on anything else; kept as Intl spells it.
      return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
    } catch {
      // Refused below, saying what is accepted.
    }
  }
  throw new PalugadaError('contract.violation', 'timezone is an IANA time zone, such as Asia/Jakarta, or null for the company\'s', { field: 'timezone' });
}

/**
 * The settings a request changes, each checked, with what is accepted named
 * when it is not; a field left out keeps its value. Quiet hours are set or
 * cleared together. Whether the person may set `ownerHearsPeople` is the
 * caller's to ask.
 */
export function settingsChange(body: Record<string, unknown>): SettingsChange {
  const change: SettingsChange = {};
  if (body.language !== undefined) change.language = body.language === null ? null : languageCode(body.language, 'language');
  if (body.timezone !== undefined) change.timezone = timezoneOf(body.timezone);
  if (body.quietStart !== undefined || body.quietEnd !== undefined) {
    if (body.quietStart === undefined || body.quietEnd === undefined) {
      const missing = body.quietStart === undefined ? 'quietStart' : 'quietEnd';
      throw new PalugadaError('contract.violation', 'quiet hours are a start and an end, given together, or both null', { field: missing });
    }
    change.quietStart = hour(body.quietStart, 'quietStart');
    change.quietEnd = hour(body.quietEnd, 'quietEnd');
    if ((change.quietStart === null) !== (change.quietEnd === null)) {
      throw new PalugadaError('contract.violation', 'quiet hours are a start and an end, given together, or both null',
        { field: change.quietStart === null ? 'quietStart' : 'quietEnd' });
    }
  }
  if (body.noticesPerDay !== undefined) {
    const notices = body.noticesPerDay;
    if (typeof notices !== 'number' || !Number.isInteger(notices) || notices < 0 || notices > 200) {
      throw new PalugadaError('contract.violation', 'noticesPerDay is 0 to 200', { field: 'noticesPerDay' });
    }
    change.noticesPerDay = notices;
  }
  for (const field of ['notifyInTab', 'ownerHearsPeople'] as const) {
    if (body[field] === undefined) continue;
    if (typeof body[field] !== 'boolean') throw new PalugadaError('contract.violation', `${field} is true or false`, { field });
    change[field] = body[field];
  }
  return change;
}

/** A person's settings as they stand: their own where they set one, the default where they did not. */
export async function settingsOf(principal: string): Promise<Settings> {
  const { rows } = await withControlPlane((tx) => tx.query<{
    language: string | null; timezone: string | null; quiet_start: number | null; quiet_end: number | null;
    notify_in_tab: boolean; notices_per_day: number; owner_hears_people: boolean;
  }>(
    `SELECT language, timezone, quiet_start, quiet_end, notify_in_tab, notices_per_day, owner_hears_people
       FROM principal_prefs WHERE principal = $1`, [principal]));
  const row = rows[0];
  if (!row) return defaults(principal);
  return {
    language: row.language, timezone: row.timezone, quietStart: row.quiet_start, quietEnd: row.quiet_end,
    notifyInTab: row.notify_in_tab, noticesPerDay: row.notices_per_day, ownerHearsPeople: row.owner_hears_people,
  };
}

/**
 * Writes what changed over what was there. A seat's row names its company,
 * so erasing the company erases it; the owner's names none.
 */
export async function changeSettings(principal: string, companyId: string | null, change: SettingsChange): Promise<void> {
  if (Object.keys(change).length === 0) return;
  await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      language: string | null; timezone: string | null; quiet_start: number | null; quiet_end: number | null;
      notify_in_tab: boolean; notices_per_day: number; owner_hears_people: boolean;
    }>(
      `SELECT language, timezone, quiet_start, quiet_end, notify_in_tab, notices_per_day, owner_hears_people
         FROM principal_prefs WHERE principal = $1 FOR UPDATE`, [principal]);
    const row = rows[0];
    const was: Settings = row
      ? {
        language: row.language, timezone: row.timezone, quietStart: row.quiet_start, quietEnd: row.quiet_end,
        notifyInTab: row.notify_in_tab, noticesPerDay: row.notices_per_day, ownerHearsPeople: row.owner_hears_people,
      }
      : defaults(principal);
    const next: Settings = { ...was, ...change };
    await tx.query(
      `INSERT INTO principal_prefs (principal, company_id, language, timezone, quiet_start, quiet_end,
                                    notify_in_tab, notices_per_day, owner_hears_people, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (principal) DO UPDATE SET
         language = EXCLUDED.language, timezone = EXCLUDED.timezone, quiet_start = EXCLUDED.quiet_start,
         quiet_end = EXCLUDED.quiet_end, notify_in_tab = EXCLUDED.notify_in_tab, notices_per_day = EXCLUDED.notices_per_day,
         owner_hears_people = EXCLUDED.owner_hears_people, updated_at = now()`,
      [principal, companyId, next.language, next.timezone, next.quietStart, next.quietEnd,
        next.notifyInTab, next.noticesPerDay, next.ownerHearsPeople]);
  });
}
