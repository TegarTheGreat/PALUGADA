/**
 * Core processes: the handful of skills that are the way the company works
 * (PRD v2 F18.14; docs/STATUS.md 2.201).
 *
 * The operating method 2.189 adopts, after Wickman's *Traction*, names a few
 * core processes, has each written down short and owned by one seat, and
 * then asks whether the work follows them. PALUGADA already had the written
 * procedure with its review and the owner's approval: a skill (F15). So a
 * core process is not a new kind of document. It is an active skill the
 * owner has marked core and given one owning seat (migration 0143), and the
 * measure of whether it is followed is read from what the runs did: the
 * share of the owning seat's division's runs that opened it with
 * `skill.read`.
 *
 * A share is only a measure where the runs could have read it. A division
 * without the `skill.read` grant (the lab and assurance are left without it
 * on purpose) is refused every read, and a process that is quarantined or
 * has no version in force is not put to its seat at all. Both are marked on
 * the chart with no share, and warned of, rather than shown as a share of
 * none that blames runs for what they were never able to do.
 *
 * Everything here that is a number from the method -- five to twelve of
 * them, sixty lines, ninety days -- is a warning on the owner's chart and
 * never a refusal: a company putting its processes down is halfway through
 * for a while, and a limit that refused would make the owner mark a
 * placeholder to get past it.
 */
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { parseSkillDocument } from './skills.ts';

/**
 * How many core processes a company should have. The method's own pages
 * disagree: its process page says five to twelve, its glossary "typically
 * six to ten". The wider range is the one that warns less wrongly, so it is
 * the one used, and the guide says the sources differ.
 */
const FEWEST = 5;
const MOST = 12;
/**
 * The 20/80 rule: capture the fifth of the detail that drives most of the
 * result. The method puts a process at one or two pages of seven to fifteen
 * major steps; sixty lines of a skill's body is about two pages.
 */
const LINES = 60;
/**
 * The method reviews its processes every quarter, so one whose active
 * version is older than a quarter is one nobody has looked at since the
 * last planning: the chart marks it, and quarterly planning lists it.
 */
const STALE_AFTER_DAYS = 90;
/**
 * The window the followed share is read over unless one is asked for: a
 * month is long enough for a division's runs to have needed the process and
 * short enough that a process followed last spring and dropped since shows.
 */
const FOLLOWED_WINDOW_DAYS = 30;

export type CoreProcessWarning =
  | { kind: 'fewer_than_five'; count: number }
  | { kind: 'more_than_twelve'; count: number }
  | { kind: 'longer_than_sixty_lines'; slug: string; lines: number }
  /**
   * Marked, and not put to its seat: it is quarantined (an import from
   * outside landed on its name), or no version of it is in force (an archive
   * brought an outside skill's versions back as candidates, F15.8).
   */
  | { kind: 'not_in_force'; slug: string; reason: 'quarantined' | 'not_active' }
  /** Its seat's division does not hold `skill.read`, so none of its runs can open it. */
  | { kind: 'division_cannot_read'; slug: string; roleId: string };

export interface CoreProcess {
  skillId: string;
  slug: string;
  summary: string;
  /** The one seat that answers for it, and the division whose runs are counted. */
  ownerRoleId: string;
  ownerRole: string;
  divisionId: string;
  activeVersion: number | null;
  /** Came from outside and nobody here has vouched for it (F15.8). */
  quarantined: boolean;
  /**
   * Its active version is in force and it is not quarantined: what the
   * seat's runs are told to follow. The context builder asks the same.
   */
  inForce: boolean;
  /** The seat's division holds `skill.read`, without which no run of it can open the process. */
  divisionCanRead: boolean;
  /** When the version runs follow was switched on: the last time the process changed. */
  updatedAt: Date;
  /** Whole days since then. */
  ageDays: number;
  /** Not changed in a quarter (ninety days). */
  stale: boolean;
  /** Lines in the active version's body, past the front matter. */
  lines: number;
  /** Runs of the seat's division that started in the window. */
  runs: number;
  /** Of them, the runs that read the process with `skill.read`. */
  followedRuns: number;
  /**
   * followedRuns / runs, or null where it measures nothing: the division ran
   * nothing in the window, cannot read the process, or the process is not in
   * force.
   */
  followedShare: number | null;
}

export interface CoreProcessesReport {
  /** The window the followed share is read over, stated beside every share. */
  windowDays: number;
  since: Date;
  processes: CoreProcess[];
  warnings: CoreProcessWarning[];
}

/**
 * The company's core processes, with their age and how far they are
 * followed over the window (`windowDays`, thirty unless asked).
 *
 * A run follows a process when it read it during the run: a `skill.read`
 * event of the process's slug, on the run's task, between the run's start
 * and its end (or now, for one still running). Counted by run rather than by
 * read, so a run that opened the process three times counts once, and by
 * slug rather than by id, because an archive restores the events with their
 * payload as written and the skill under a new id.
 *
 * Every statement names the company, so this reads the same on the control
 * plane, where row security narrows nothing, as in the tenant's own
 * transaction.
 */
export async function coreProcessesOf(
  tx: TenantClient,
  companyId: string,
  options: { windowDays?: number; now?: Date } = {},
): Promise<CoreProcessesReport> {
  const windowDays = options.windowDays ?? FOLLOWED_WINDOW_DAYS;
  if (!Number.isInteger(windowDays) || windowDays < 1 || windowDays > 366) {
    throw new PalugadaError('contract.violation',
      `a window is 1 to 366 whole days; ${String(windowDays)} was asked for`, { field: 'windowDays' });
  }
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);
  const { rows } = await tx.query<{
    skill_id: string; slug: string; summary: string; owner_role_id: string; owner_role: string; division_id: string;
    active_version: number | null; body: string | null; updated_at: Date; age_days: number;
    quarantined: boolean; version_active: boolean; division_can_read: boolean;
    runs: number; followed_runs: number;
  }>(
    `WITH windowed AS (
            SELECT ar.task_id, ar.started_at, coalesce(ar.finished_at, $2::timestamptz) AS ended_at, t.division_id
              FROM agent_runs ar
              JOIN tasks t ON t.company_id = ar.company_id AND t.id = ar.task_id
             WHERE ar.company_id = $1 AND ar.started_at >= $3::timestamptz AND ar.started_at <= $2::timestamptz)
     SELECT s.id AS skill_id, s.slug, s.summary, s.owner_role_id, r.slug AS owner_role, r.division_id,
            s.active_version, v.body, s.quarantined,
            coalesce(v.state = 'active', false) AS version_active,
            EXISTS (SELECT 1 FROM capability_grants g
                     WHERE g.company_id = $1 AND g.division_id = r.division_id
                       AND g.capability_name = 'skill.read') AS division_can_read,
            coalesce(v.activated_at, v.created_at, s.created_at) AS updated_at,
            floor(extract(epoch FROM $2::timestamptz - coalesce(v.activated_at, v.created_at, s.created_at)) / 86400)::int AS age_days,
            (SELECT count(*)::int FROM windowed w WHERE w.division_id = r.division_id) AS runs,
            (SELECT count(*)::int FROM windowed w
              WHERE w.division_id = r.division_id
                AND EXISTS (SELECT 1 FROM events e
                             WHERE e.company_id = $1 AND e.task_id = w.task_id AND e.type = 'skill.read'
                               AND e.payload->>'slug' = s.slug
                               AND e.occurred_at BETWEEN w.started_at AND w.ended_at)) AS followed_runs
       FROM skills s
       JOIN roles r ON r.company_id = s.company_id AND r.id = s.owner_role_id
       LEFT JOIN skill_versions v ON v.company_id = s.company_id AND v.skill_id = s.id AND v.version = s.active_version
      WHERE s.company_id = $1 AND s.core
      ORDER BY s.slug`,
    [companyId, now, since],
  );

  const processes: CoreProcess[] = rows.map((row) => {
    const inForce = row.version_active && !row.quarantined;
    const measured = inForce && row.division_can_read && row.runs > 0;
    return {
      skillId: row.skill_id,
      slug: row.slug,
      summary: row.summary,
      ownerRoleId: row.owner_role_id,
      ownerRole: row.owner_role,
      divisionId: row.division_id,
      activeVersion: row.active_version,
      quarantined: row.quarantined,
      inForce,
      divisionCanRead: row.division_can_read,
      updatedAt: row.updated_at,
      ageDays: Math.max(0, row.age_days),
      stale: row.age_days >= STALE_AFTER_DAYS,
      lines: row.body === null ? 0 : linesOf(row.body),
      runs: row.runs,
      followedRuns: row.followed_runs,
      followedShare: measured ? row.followed_runs / row.runs : null,
    };
  });

  const warnings: CoreProcessWarning[] = [];
  // None marked is a company that has not started, and is not warned of:
  // the Skills page says what a core process is where one would be marked.
  if (processes.length > 0 && processes.length < FEWEST) warnings.push({ kind: 'fewer_than_five', count: processes.length });
  if (processes.length > MOST) warnings.push({ kind: 'more_than_twelve', count: processes.length });
  for (const process of processes) {
    if (process.lines > LINES) warnings.push({ kind: 'longer_than_sixty_lines', slug: process.slug, lines: process.lines });
    if (!process.inForce) {
      warnings.push({ kind: 'not_in_force', slug: process.slug, reason: process.quarantined ? 'quarantined' : 'not_active' });
    } else if (!process.divisionCanRead) {
      // Only for one in force: a process not put to its seat has the reason
      // above, and a missing grant would be the second thing to fix.
      warnings.push({ kind: 'division_cannot_read', slug: process.slug, roleId: process.ownerRoleId });
    }
  }
  return { windowDays, since, processes, warnings };
}

/**
 * The lines of a skill's procedure: its body past the front matter, as the
 * owner reads it. A stored document that no longer parses is counted whole,
 * since an import carries versions as they were written.
 */
function linesOf(source: string): number {
  let body = source.trim();
  try {
    body = parseSkillDocument(source).body;
  } catch {
    // Counted whole, as said above.
  }
  return body.split(/\r?\n/).length;
}

/**
 * The owner names a skill one of the company's core processes, with the
 * seat that owns it, or says it is one no longer.
 *
 * Only a skill that is switched on can be one: a candidate is a proposal,
 * and the process the work follows is the version that passed its checks, a
 * reviewer and the owner. Not a quarantined one, which nobody here has
 * vouched for. And only a seat whose division the skill's scope reaches,
 * since the share of that division's runs that read it is how it is
 * measured. Whether that division holds the `skill.read` grant is not a
 * refusal, because grants are the owner's to change on Team at any time
 * after: it comes back as a `division_cannot_read` warning, here and on the
 * chart, until the grant is there. On the control plane, because the application role holds no grant to the two
 * columns (0143): which procedures a division is measured by is the
 * owner's.
 */
export async function markCoreProcess(
  companyId: string,
  skillId: string,
  change: { core: boolean; roleId?: string | null },
): Promise<{ warnings: CoreProcessWarning[] }> {
  if (change.core && !change.roleId) {
    throw new PalugadaError('contract.violation',
      'a core process has one owning seat: give roleId, the role that keeps it current', { field: 'roleId' });
  }
  return withControlPlane(async (tx) => {
    const { rows: skills } = await tx.query<{
      slug: string; scope_type: string; scope_id: string | null; active_version: number | null; quarantined: boolean;
    }>(
      `SELECT slug, scope_type, scope_id, active_version, quarantined
         FROM skills WHERE id::text = $1 AND company_id = $2 FOR UPDATE`,
      [skillId, companyId]);
    const skill = skills[0];
    if (!skill) throw new PalugadaError('skill.unknown', `no skill ${skillId} in this company`, { skillId });

    let ownerRoleId: string | null = null;
    if (change.core) {
      const { rows: roles } = await tx.query<{ id: string; slug: string; division_id: string }>(
        'SELECT id, slug, division_id FROM roles WHERE id::text = $1 AND company_id = $2', [change.roleId, companyId]);
      const role = roles[0];
      if (!role) {
        throw new PalugadaError('contract.violation',
          `no role ${String(change.roleId)} in this company to own the process; name one of its roles by id`, { field: 'roleId' });
      }
      if (skill.active_version === null) {
        throw new PalugadaError('contract.violation',
          `${skill.slug} has no active version: only a skill that is switched on, after its checks, a reviewer and you, can be a core process`,
          { field: 'skillId' });
      }
      if (skill.quarantined) {
        throw new PalugadaError('contract.violation',
          `${skill.slug} came from outside and is quarantined: lift the quarantine before making it a core process`, { field: 'skillId' });
      }
      if (skill.scope_type === 'division' && skill.scope_id !== role.division_id) {
        throw new PalugadaError('contract.violation',
          `${skill.slug} applies to one division, and ${role.slug} works in another: widen the skill to the company, ` +
            'or name a seat of its own division, since its runs could not read it',
          { field: 'roleId' });
      }
      ownerRoleId = role.id;
    }

    await tx.query('UPDATE skills SET core = $3, owner_role_id = $4 WHERE id::text = $1 AND company_id = $2',
      [skillId, companyId, change.core, ownerRoleId]);
    await appendEvent(tx, {
      companyId,
      type: 'skill.core_changed',
      actor: 'owner',
      payload: { skillId, slug: skill.slug, core: change.core, ownerRoleId },
    });
    return { warnings: (await coreProcessesOf(tx, companyId)).warnings };
  });
}
