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
   * Only for `goals`, which the application role is granted SELECT on and
   * nothing more: F3.10 makes strategy the owner's, so an agent cannot write a
   * goal. Restoring a company is an owner action, and keeping that withholding
   * intact means the import has to say so explicitly rather than the
   * application role quietly gaining a privilege it must not have.
   */
  viaControlPlane?: boolean;
}

/**
 * Sections in import order.
 *
 * A section appears after everything it references. `bundle_installs` is
 * absent: an install points at a bundle row in the *platform's* catalogue, and
 * the destination may not have that bundle at all -- so a company's bundles are
 * reinstalled deliberately rather than restored into a dangling reference.
 */
const SECTIONS: ImportSection[] = [
  { name: 'projects', table: 'projects', references: [] },
  { name: 'divisions', table: 'divisions', references: ['parent_division_id'] },
  { name: 'goals', table: 'goals', references: ['parent_goal_id'], viaControlPlane: true },
  { name: 'roles', table: 'roles', references: ['division_id'] },
  { name: 'capability_grants', table: 'capability_grants', references: ['division_id'] },
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
    references: ['project_id', 'division_id', 'role_id'],
  },
];

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
      columns.map((column) => normalise(values[column])),
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
function normalise(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}
