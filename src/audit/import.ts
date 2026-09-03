/**
 * Company import (PRD v2 F16.4).
 *
 * The other half of `export.ts`: an archive written by one PALUGADA instance
 * becomes a company on another. What makes it more than a bulk insert is that
 * every identifier has to change. A uuid is unique within an instance, and the
 * destination may already hold a company whose ids collide -- or, worse, may
 * hold the *same* company, restored earlier, which a naive insert would merge
 * with rather than sit beside.
 *
 * So the import mints a new id for every row and rewrites every reference to
 * it. That is the whole design, and the reason the section list carries its
 * foreign keys explicitly: a remapper that guessed which columns were
 * references -- by name, by type -- would silently miss one the day a column
 * was added, and a foreign key pointing at another company's row is the exact
 * failure the tenant boundary exists to prevent.
 *
 * Ordering matters and is not sorted for the reader's benefit: a section is
 * imported after everything it references, so the map always has the
 * destination id by the time a reference to it is rewritten.
 *
 * What does not come across, and why:
 *
 *   - **A trust decision made elsewhere.** An external skill that was
 *     un-quarantined on the source instance comes back quarantined here. An
 *     archive is not a chain of custody, and inheriting somebody else's
 *     judgement about a document from a hub would make an archive a way past
 *     the one gate external knowledge has (F15.8).
 *   - **Credentials.** The archive carries references, never values, so an
 *     imported company has the shape of its credentials and none of their
 *     contents. That is correct: moving a company between instances must not
 *     move its secrets, and the operator re-provisions them deliberately.
 *   - **Leases and in-flight state.** A task arrives with its status but no
 *     lease holder: the worker that held it is on the other instance and is
 *     not coming.
 */
import { randomUUID } from 'node:crypto';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import type { ArchiveLine } from './export.ts';

interface ImportSection {
  name: string;
  table: string;
  /** Columns holding a reference to a row imported earlier. */
  references: string[];
  /** Columns to drop: instance-local state that must not travel. */
  drop?: string[];
  /**
   * Columns forced to a value, whatever the archive said.
   *
   * For a trust decision made on the instance the archive came from. An
   * external skill that was un-quarantined *there* has been vouched for by
   * somebody this installation has never heard of, and an archive is not a
   * chain of custody — F16.4 says a company moves between PALUGADA instances,
   * not that the destination inherits the source's judgement.
   */
  force?: Record<string, unknown>;
  /**
   * Written through the control plane instead of the tenant scope.
   *
   * For the tables the application role cannot write. `goals` is one -- F3.10
   * makes strategy the owner's, so an agent cannot write one -- and so is
   * every configuration table that carries a rule: a policy, a ceiling or a
   * window an agent could rewrite is not a rule (F2.9, F3.10). Restoring a
   * company is an owner action, so it goes the way the owner console goes
   * rather than the application role quietly gaining a privilege it must not
   * have. Marked explicitly per section rather than inferred, so adding a
   * section is a decision about which role writes it.
   */
  viaControlPlane?: boolean;
}

/**
 * Sections in import order.
 *
 * A section appears after everything it references. Three of the export's
 * sections are deliberately absent, and `audit-export.test.ts` asserts that
 * the difference between the two lists is exactly these three -- so a fourth
 * cannot be dropped by accident, which is how the first four went missing:
 *
 *   - `bundle_installs`: an install points at a bundle row in the *platform's*
 *     catalogue, and the destination may not have that bundle at all, so a
 *     company's bundles are reinstalled rather than restored into a dangling
 *     reference.
 *   - `retention_log`: it records what *this* instance deleted and when.
 *     Carrying it to another instance would assert deletions that installation
 *     never performed, which is the opposite of what a retention record is
 *     for.
 *   - `llm_traces`: the same reasoning about money. A trace is a charge that
 *     was billed on the instance it happened on, and restoring one puts it
 *     inside the destination's monthly period (F1.9) and its seven-day
 *     circuit-breaker baseline (F1.8) -- so a restored company would be paced
 *     by, and could be paused for, spending that was already paid for
 *     somewhere else. A genuine migration wants that spend carried and a clone
 *     does not, and nothing in an archive says which this is, so the import
 *     does not decide for the operator.
 *
 * All three stay in the archive. An auditor reading it is exactly who should
 * see what was installed, what was deleted, and what it cost -- what they must
 * not do is silently become the destination's own history.
 */
const SECTIONS: ImportSection[] = [
  { name: 'projects', table: 'projects', references: [] },
  { name: 'divisions', table: 'divisions', references: ['parent_division_id'] },
  { name: 'goals', table: 'goals', references: ['parent_goal_id'], viaControlPlane: true },
  { name: 'roles', table: 'roles', references: ['division_id'] },
  { name: 'capability_grants', table: 'capability_grants', references: ['division_id'] },
  {
    // F12.1: what travels is the reference and its division, never a value --
    // there is no value in this database to travel. Restored, because an
    // adapter asks for an alias and a company without its aliases is one where
    // every credentialled capability fails with `capability.not_granted` and
    // the reason is not in the archive.
    //
    // `rotated_at` and `version` come across with it: F12.3 keys the cache on
    // the version, so a restore that reset it to 1 would serve a value the
    // source had already rotated away from.
    name: 'credentials',
    table: 'credentials',
    references: ['division_id'],
  },
  {
    name: 'budget_accounts',
    table: 'budget_accounts',
    references: ['scope_id', 'parent_account_id'],
  },
  {
    name: 'tasks',
    table: 'tasks',
    references: [
      'project_id', 'division_id', 'role_id', 'parent_task_id', 'budget_account_id', 'goal_id',
    ],
    // The worker that held the lease is on the other instance and is not
    // coming back for it.
    drop: ['lease_holder', 'lease_expires_at'],
  },
  { name: 'task_steps', table: 'task_steps', references: ['task_id'] },
  { name: 'agent_runs', table: 'agent_runs', references: ['task_id', 'role_id'] },
  { name: 'events', table: 'events', references: ['project_id', 'task_id'] },
  {
    name: 'memories',
    table: 'memories',
    references: ['scope_id', 'source_event_id', 'superseded_by'],
  },
  {
    name: 'skills',
    table: 'skills',
    references: ['scope_id'],
    // F15.8: an imported external skill re-enters quarantine. The alternative
    // is that anybody who can hand an owner an archive can hand them an
    // unquarantined skill, which would make the archive a way around the one
    // gate external knowledge has.
    force: { quarantined: true },
  },
  {
    // Before `skill_versions`, which carries a `review_request_id`. That
    // reference was being remapped against a section the import did not have,
    // so it resolved to nothing: a restored skill version pointed at no review
    // and F15.3's "the owner cannot approve what no reviewer has seen" had
    // lost its evidence. Ordering is the fix, and the ordering only works
    // because this section exists at all.
    name: 'review_requests',
    table: 'review_requests',
    references: ['project_id', 'proposer_task_id', 'proposer_role_id', 'reviewer_role_id',
                 'review_task_id'],
  },
  {
    // The owner's decisions and what they were told at the time. F11.6 wants
    // an archive an auditor can read, and "who approved this" is most of what
    // one asks.
    name: 'decision_records',
    table: 'decision_records',
    references: ['project_id', 'task_id', 'source_event_id', 'review_request_id',
                 'proposer_role_id', 'reviewer_role_id'],
  },
  {
    // Every structural change and who made it (F2.9, F3.12). Through the
    // control plane: the application role cannot write it, which is the point
    // of a governance log.
    name: 'governance_log',
    table: 'governance_log',
    references: ['subject_id', 'division_id'],
    viaControlPlane: true,
  },
  { name: 'skill_versions', table: 'skill_versions', references: ['skill_id', 'review_request_id'] },
  { name: 'skill_evals', table: 'skill_evals', references: ['skill_id'] },
  { name: 'config_versions', table: 'config_versions', references: ['subject_id'] },
  { name: 'role_eval_cases', table: 'role_eval_cases', references: ['role_id', 'source_agent_run_id'] },
  {
    name: 'inbox_items',
    table: 'inbox_items',
    references: ['task_id'],
  },
  {
    name: 'schedules',
    table: 'schedules',
    references: ['project_id', 'division_id', 'role_id', 'budget_account_id', 'goal_id'],
  },

  // F1.5's configuration, restored last because it references divisions and
  // needs nothing itself. `config_versions` above carries what a policy *was*;
  // these are the rules in force, and a company restored without them would
  // run with nothing requiring approval of anything.
  //
  // Written through the control plane: all six carry a shared-scope or
  // SELECT-only policy under FORCE ROW LEVEL SECURITY, because a rule an agent
  // could rewrite is not a rule (F2.9, F3.10). Restoring a company is an owner
  // action, so it goes the same way the owner console does rather than the
  // application role quietly gaining a privilege it must not have.
  {
    name: 'policies',
    table: 'policies',
    references: ['division_id'],
    viaControlPlane: true,
  },
  { name: 'spend_limits', table: 'spend_limits', references: [], viaControlPlane: true },
  { name: 'alert_thresholds', table: 'alert_thresholds', references: [], viaControlPlane: true },
  {
    name: 'retention_policies',
    table: 'retention_policies',
    references: [],
    viaControlPlane: true,
  },
  { name: 'batch_windows', table: 'batch_windows', references: [], viaControlPlane: true },
  {
    name: 'capability_windows',
    table: 'capability_windows',
    references: ['division_id'],
    viaControlPlane: true,
  },
];

/**
 * Every section this import restores, so it can be checked against the export.
 *
 * `company` is in the list and not in SECTIONS: `importCompany` reads that one
 * line itself to create the destination company, so it is restored by the
 * function rather than by a row in the table above. Named here anyway, because
 * the check this list exists for asks "does every exported section reach the
 * destination", and the answer for `company` is yes.
 */
export const IMPORT_SECTION_NAMES: readonly string[] = [
  'company',
  ...SECTIONS.map((section) => section.name),
];

/**
 * The sections that are in an archive on purpose and are not restored.
 *
 * Named here rather than left as the difference between two lists, so the
 * decision is a value a test can assert against and the reasoning lives beside
 * the list rather than in a commit message. Each one is explained on SECTIONS
 * above.
 */
export const NOT_RESTORED: readonly string[] = ['bundle_installs', 'retention_log', 'llm_traces'];

export interface ImportSummary {
  companyId: string;
  slug: string;
  sections: Record<string, number>;
  /** Sections in the archive this import deliberately did not restore. */
  skipped: string[];
}

/**
 * Rebuilds a company from an archive.
 *
 * `slug` is required rather than taken from the archive: two instances can
 * hold companies with the same slug, and silently renaming one -- or silently
 * merging with it -- are both worse than making the caller say what this one
 * is called here.
 */
export async function importCompany(
  lines: AsyncIterable<ArchiveLine> | Iterable<ArchiveLine>,
  options: { slug: string; name?: string },
): Promise<ImportSummary> {
  const bySection = new Map<string, Array<Record<string, unknown>>>();
  let source: Record<string, unknown> | null = null;

  for await (const line of lines as AsyncIterable<ArchiveLine>) {
    if (line.section === 'company') {
      source = line.row;
      continue;
    }
    const rows = bySection.get(line.section) ?? [];
    rows.push(line.row);
    bySection.set(line.section, rows);
  }

  if (!source) {
    throw new PalugadaError('archive.invalid', 'the archive has no company section', {});
  }

  const companyId = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'INSERT INTO companies (slug, name, timezone) VALUES ($1, $2, $3) RETURNING id',
      [options.slug, options.name ?? String(source!.name ?? options.slug), String(source!.timezone ?? 'UTC')],
    );
    return rows[0]!.id;
  });

  // Every id the archive carried, mapped to the one it has here. Seeded with
  // the company itself so that a reference to the old company id -- which
  // should not appear, but might in a payload -- resolves rather than dangles.
  const remap = new Map<string, string>([[String(source.id), companyId]]);
  const counts: Record<string, number> = {};

  for (const section of SECTIONS) {
    const rows = bySection.get(section.name) ?? [];
    if (rows.length === 0) continue;
    counts[section.name] = section.viaControlPlane
      ? await withControlPlane((tx) => importSection(tx, companyId, section, rows, remap))
      : await withTenant(companyId, (tx) => importSection(tx, companyId, section, rows, remap));
  }

  const skipped = [...bySection.keys()].filter(
    (name) => !SECTIONS.some((section) => section.name === name),
  );

  await withTenant(companyId, async (tx) => {
    await appendEvent(tx, {
      companyId,
      type: 'company.imported',
      actor: 'owner',
      payload: { slug: options.slug, sections: counts, skipped },
    });
  });

  return { companyId, slug: options.slug, sections: counts, skipped };
}

async function importSection(
  tx: Pick<TenantClient, 'query'>,
  companyId: string,
  section: ImportSection,
  rows: Array<Record<string, unknown>>,
  remap: Map<string, string>,
): Promise<number> {
  // Ids first, for the whole section, so a row referring to a sibling -- a
  // division's parent, a memory it supersedes -- finds it. Within a section
  // the archive's own order decides which of two mutual references resolves,
  // and the export writes parents first for exactly that reason.
  for (const row of rows) {
    if (typeof row.id === 'string' && !remap.has(row.id)) {
      remap.set(row.id, randomUUID());
    }
  }

  const json = await jsonColumnsFor(tx, section.table);

  let written = 0;
  for (const row of rows) {
    const values: Record<string, unknown> = { ...row };

    for (const column of section.drop ?? []) delete values[column];

    // Applied before the id remap so it cannot be overwritten by anything the
    // archive carried under the same name.
    for (const [column, value] of Object.entries(section.force ?? {})) {
      // Only where the archive already has the column: forcing `quarantined`
      // onto a row that never had it would insert a column the section's own
      // export never wrote, and an import that invents columns is one that
      // fails the day a table gains one.
      if (column in values) values[column] = value;
    }

    if (typeof values.id === 'string') values.id = remap.get(values.id);
    for (const column of section.references) {
      const current = values[column];
      if (typeof current === 'string') {
        const mapped = remap.get(current);
        // An unmapped reference is one whose target was not in the archive --
        // a purged task, a superseded memory beyond retention. Null rather
        // than the old id: a foreign key pointing at nothing is a broken row,
        // and one pointing at *something else here* would be far worse.
        values[column] = mapped ?? null;
      }
    }

    values.company_id = companyId;

    const columns = Object.keys(values);
    const placeholders = columns.map((_column, index) => `$${index + 1}`);
    const { rowCount } = await tx.query(
      `INSERT INTO ${section.table} (${columns.map(quote).join(', ')})
       VALUES (${placeholders.join(', ')})
       ON CONFLICT DO NOTHING`,
      columns.map((column) => normalise(values[column], json.has(column))),
    );
    written += rowCount ?? 0;
  }

  return written;
}

/** Identifiers come from this module's own section list, never from an archive. */
function quote(column: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(column)) {
    throw new PalugadaError('archive.invalid', `unsafe column name ${column}`, { column });
  }
  return `"${column}"`;
}

/**
 * JSON columns arrive as objects and have to go back as text.
 *
 * `pg` sends a plain object as a record type rather than as jsonb, so a payload
 * that is not stringified fails with a type error at insert. Arrays are left
 * alone: those are genuine array columns, and stringifying one would store the
 * text of an array.
 */
/**
 * Which of a table's columns hold JSON, asked of the database rather than
 * guessed from the value.
 *
 * The distinction matters and cannot be made from a value alone. `pg` returns
 * a `jsonb` column and a `text[]` column both as JavaScript arrays, and they
 * have to go back as different things: a JSON string for one, an array for the
 * other. Guessing by shape -- "stringify objects, leave arrays" -- worked
 * until the first `jsonb` column that happened to hold an array, which is
 * `review_requests.criteria`, and produced `invalid input syntax for type
 * json` from an import that had looked complete.
 *
 * One query per table, cached for the run. The schema is the authority on its
 * own types, and asking it is cheaper than a per-column list to keep in step.
 */
const jsonColumns = new Map<string, Set<string>>();

async function jsonColumnsFor(tx: TenantClient, table: string): Promise<Set<string>> {
  const cached = jsonColumns.get(table);
  if (cached) return cached;

  const { rows } = await tx.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
        AND data_type IN ('json', 'jsonb')`,
    [table],
  );
  const names = new Set(rows.map((row) => row.column_name));
  jsonColumns.set(table, names);
  return names;
}

function normalise(value: unknown, isJson: boolean): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  // A JSON column takes text, whatever the shape. Everything else -- a
  // Postgres array in particular -- goes back as it came.
  if (isJson) return JSON.stringify(value);
  if (typeof value === 'object' && !Array.isArray(value)) return JSON.stringify(value);
  return value;
}
