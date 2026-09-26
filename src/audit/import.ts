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
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
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
   * JSON columns whose values may carry ids from the archive -- an inbox
   * item's payload names the memory, skill or schedule its answer acts on.
   * Any string in them that is an id this import has mapped is replaced by
   * the id it has here.
   */
  remapJson?: readonly string[];
}

/**
 * Sections in import order.
 *
 * A section appears after everything it references. Four of the export's
 * sections are deliberately absent, and `audit-export.test.ts` asserts that
 * the difference between the two lists is exactly these four -- so a fifth
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
 *   - `gateway_devices`: pairing a device is a decision about trusting it on
 *     *this* instance, made with a challenge this instance issued. A restored
 *     device would act here on the strength of a pairing nobody made here --
 *     the argument F15.8 makes about outside knowledge, made about machines.
 *     The owner pairs them again.
 *
 * All four stay in the archive. An auditor reading it is exactly who should
 * see what was installed, what was deleted, and what it cost -- what they must
 * not do is silently become the destination's own history.
 */
const SECTIONS: ImportSection[] = [
  { name: 'projects', table: 'projects', references: [] },
  { name: 'divisions', table: 'divisions', references: ['parent_division_id'] },
  { name: 'goals', table: 'goals', references: ['parent_goal_id'] },
  { name: 'goal_metrics', table: 'goal_metrics', references: ['goal_id'] },
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
    // Before the tasks, which name the schedule that made them (0049).
    name: 'schedules',
    table: 'schedules',
    references: ['project_id', 'division_id', 'role_id', 'budget_account_id', 'goal_id'],
  },
  {
    name: 'tasks',
    table: 'tasks',
    references: [
      'project_id', 'division_id', 'role_id', 'parent_task_id', 'budget_account_id', 'goal_id',
      'schedule_id',
    ],
    // The worker that held the lease is on the other instance and is not
    // coming back for it.
    drop: ['lease_holder', 'lease_expires_at'],
  },
  { name: 'task_steps', table: 'task_steps', references: ['task_id'] },
  {
    // A door into the company is not left open by a restore: it arrives
    // closed, at a new address, with no token, and the owner opens it by
    // making one (0054).
    name: 'triggers',
    table: 'triggers',
    references: ['project_id', 'division_id', 'role_id', 'goal_id'],
    force: { enabled: false },
  },
  { name: 'trigger_deliveries', table: 'trigger_deliveries', references: ['trigger_id', 'task_id'] },
  { name: 'metric_observations', table: 'metric_observations', references: ['metric_id', 'task_id'] },
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
    // `quarantined` travels as it was, and the destination's own gate is
    // applied afterwards instead of here. Forcing it true looked like the
    // stricter choice and was not: 0026 refuses a quarantined skill that is
    // not division-scoped, so a company-scoped skill aborted the entire
    // import -- and it also quarantined skills this company wrote itself,
    // which F15.8's argument about external knowledge never covered.
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
  },
  // Before `skill_versions`, and the ordering is load-bearing rather than
  // tidy: 0021's `skill_versions_require_an_eval` refuses an `active` version
  // whose skill has no eval case, so importing the versions first aborted the
  // whole archive and left an orphaned destination company. Only a company
  // whose skills were all still `candidate` restored at all.
  { name: 'skill_evals', table: 'skill_evals', references: ['skill_id'] },
  { name: 'skill_versions', table: 'skill_versions', references: ['skill_id', 'review_request_id'] },
  { name: 'role_eval_cases', table: 'role_eval_cases', references: ['role_id', 'source_agent_run_id'] },
  { name: 'role_eval_runs', table: 'role_eval_runs', references: ['role_id'] },
  { name: 'task_handoffs', table: 'task_handoffs', references: ['from_task_id', 'to_task_id'] },
  // A distillation's scope is the division it read.
  { name: 'distillation_state', table: 'distillation_state', references: ['scope_id'] },
  { name: 'charters', table: 'charters', references: [] },
  {
    // After everything its payload can name: memories, skills, schedules.
    name: 'inbox_items',
    table: 'inbox_items',
    references: ['task_id'],
    remapJson: ['payload'],
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
  { name: 'policies', table: 'policies', references: ['division_id'] },
  { name: 'spend_limits', table: 'spend_limits', references: [] },
  { name: 'alert_thresholds', table: 'alert_thresholds', references: [] },
  { name: 'retention_policies', table: 'retention_policies', references: [] },
  { name: 'batch_windows', table: 'batch_windows', references: [] },
  { name: 'capability_windows', table: 'capability_windows', references: ['division_id'] },
  // Last, because a version's subject can be anything above: a role, a
  // charter, a policy. Before `policies`, a policy's history had nothing to
  // map its subject to, came in with a NULL subject, and collided with the
  // next one on the identity index -- which ON CONFLICT DO NOTHING dropped
  // without a word.
  { name: 'config_versions', table: 'config_versions', references: ['subject_id'] },
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
export const NOT_RESTORED: readonly string[] = [
  'bundle_installs', 'retention_log', 'llm_traces', 'gateway_devices',
];

/**
 * An archive as lines, from either form it is kept in.
 *
 * The console downloads `{ summary, sections }` -- what `collectExport`
 * returns -- and a deployment streaming a large company writes one
 * `{ section, row }` per line. Both are the same archive; this reads either,
 * and refuses anything else by saying what an archive looks like, because the
 * person holding the wrong file is the owner.
 */
export function archiveLines(value: unknown): ArchiveLine[] {
  const invalid = (why: string) =>
    new PalugadaError('archive.invalid', `${why}; an archive is the file the console's export downloads`, {});
  if (Array.isArray(value)) {
    return value.map((line) => {
      const { section, row } = (line ?? {}) as Partial<ArchiveLine>;
      if (typeof section !== 'string' || !row || typeof row !== 'object' || Array.isArray(row)) {
        throw invalid('a line of the archive is not { section, row }');
      }
      return { section, row };
    });
  }
  const sections = (value as { sections?: unknown } | null)?.sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) {
    throw invalid('the archive has no sections');
  }
  const lines: ArchiveLine[] = [];
  for (const [section, rows] of Object.entries(sections as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw invalid(`section ${section} is not a list of rows`);
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid(`section ${section} holds something that is not a row`);
      lines.push({ section, row: row as Record<string, unknown> });
    }
  }
  if (!lines.some((line) => line.section === 'company')) {
    throw new PalugadaError('archive.invalid', 'the archive has no company section', {});
  }
  return lines;
}

/** An archive from a file: the console's JSON, or one line per row. */
export function parseArchive(text: string): ArchiveLine[] {
  const trimmed = text.trim();
  try {
    return archiveLines(JSON.parse(trimmed));
  } catch (error) {
    if (error instanceof PalugadaError) throw error;
  }
  return archiveLines(trimmed.split('\n').filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new PalugadaError('archive.invalid', `line ${index + 1} of the archive is not JSON`, { line: index + 1 });
    }
  }));
}

export interface ArchivePreview {
  company: { slug: string; name: string };
  /** Rows per section that would be restored. */
  sections: Record<string, number>;
  /** Sections in the archive that would not be, deliberately or unknown here. */
  skipped: string[];
}

/**
 * What an import would restore, without writing anything: the owner reads
 * this before pressing the button that creates a company.
 */
export function previewArchive(lines: ArchiveLine[]): ArchivePreview {
  const company = lines.find((line) => line.section === 'company')?.row;
  if (!company) throw new PalugadaError('archive.invalid', 'the archive has no company section', {});
  const sections: Record<string, number> = {};
  const skipped = new Set<string>();
  for (const line of lines) {
    if (line.section === 'company') continue;
    if (SECTIONS.some((section) => section.name === line.section)) {
      sections[line.section] = (sections[line.section] ?? 0) + 1;
    } else {
      skipped.add(line.section);
    }
  }
  return {
    company: { slug: String(company.slug ?? ''), name: String(company.name ?? '') },
    sections,
    skipped: [...skipped].sort(),
  };
}

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

  const skipped = [...bySection.keys()].filter(
    (name) => !SECTIONS.some((section) => section.name === name),
  );

  // One transaction, on the control plane, for the whole company.
  //
  // Each section used to commit on its own after the company row had, so an
  // archive that failed half-way -- a constraint, a reference, a malformed
  // row -- left a company with a slug, some divisions and no tasks, and a
  // retry under the same slug was refused because the slug was taken. All of
  // it lands now or none of it does.
  //
  // The control plane rather than the tenant scope, because several sections
  // are tables the application role may not write -- goals, the governance
  // log, every table that carries a rule -- and restoring a company is an
  // owner action that goes the way the owner console does. What row security
  // would have checked, `importSection` states: every row is written with this
  // company's id and no other.
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO companies (slug, name, timezone, work_language, talk_language)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        options.slug, options.name ?? String(source!.name ?? options.slug), String(source!.timezone ?? 'UTC'),
        // What the company works and talks in travels with it; an archive from
        // before languages existed has neither, and gets the default here.
        typeof source!.work_language === 'string' ? source!.work_language : null,
        typeof source!.talk_language === 'string' ? source!.talk_language : null,
      ],
    );
    const companyId = rows[0]!.id;
    // For anything below that asks which tenant it is working for.
    await tx.query("SELECT set_config('app.company_id', $1, true)", [companyId]);

    // Every id the archive carried, mapped to the one it has here. Seeded with
    // the company itself so that a reference to the old company id -- which
    // should not appear, but might in a payload -- resolves rather than dangles.
    const remap = new Map<string, string>([[String(source!.id), companyId]]);
    const counts: Record<string, number> = {};

    for (const section of SECTIONS) {
      const sectionRows = bySection.get(section.name) ?? [];
      if (sectionRows.length === 0) continue;
      counts[section.name] = await importSection(tx, companyId, section, sectionRows, remap);
    }

    await requireLocalVouching(tx, companyId);

    await appendEvent(tx, {
      companyId,
      type: 'company.imported',
      actor: 'owner',
      payload: { slug: options.slug, sections: counts, skipped },
    });

    return { companyId, slug: options.slug, sections: counts, skipped };
  });
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
    for (const column of section.remapJson ?? []) {
      if (values[column] !== null && values[column] !== undefined) {
        values[column] = remapIds(values[column], remap);
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

/**
 * F15.8: knowledge from outside is not vouched for by arriving in an archive.
 *
 * The destination cannot inherit the source's judgement -- F16.4 says a company
 * moves between instances, not that the second one trusts what the first
 * decided. The obvious way to express that was to force every imported skill
 * back into quarantine, and it was wrong twice: 0026 refuses a quarantined
 * skill that is not division-scoped, so a company-scoped one aborted the whole
 * import, and it also quarantined skills the company wrote itself.
 *
 * The gate that fits is the one F15.3 already built. An external skill's
 * versions come back as candidates, so the knowledge reaches no context until
 * a reviewer and the owner here have said so and F15.4's eval has run. That
 * holds at any scope, needs no trigger to cooperate, and leaves a company's own
 * skills exactly as they were -- which is what restoring a company means.
 */
async function requireLocalVouching(tx: TenantClient, companyId: string): Promise<void> {
  // The company named in every statement: this runs on the control plane,
  // where row security does not narrow anything, and an UPDATE without it
  // would re-gate every company's external skills.
  // Quarantine where the database allows it, which is division scope (0026).
  // This is the caveat F15.8 wants printed above the procedure in every
  // context pack that carries it.
  await tx.query(
    `UPDATE skills SET quarantined = true
      WHERE company_id = $1
        AND provenance = 'external' AND scope_type = 'division' AND NOT quarantined`,
    [companyId],
  );

  // And the gate that holds at any scope. A skill too wide to quarantine
  // cannot be marked, so it must not be live: its versions come back as
  // candidates and it reaches no context until a reviewer and the owner here
  // have said so, with F15.4's eval behind them.
  await tx.query(
    `UPDATE skill_versions SET state = 'candidate',
            reviewed_at = NULL, approved_at = NULL, activated_at = NULL
      WHERE company_id = $1
        AND state <> 'candidate'
        AND skill_id IN (SELECT id FROM skills WHERE company_id = $1 AND provenance = 'external')`,
    [companyId],
  );
}

/**
 * The same value with every string that is a mapped id replaced.
 *
 * Only whole strings, and only ids this import itself assigned: text that
 * merely contains an id is left alone, and a string that happens to look
 * like one but was never in the archive is not rewritten into something else.
 */
function remapIds(value: unknown, remap: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return remap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => remapIds(item, remap));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, remapIds(item, remap)]),
    );
  }
  return value;
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
