/**
 * Company export (PRD F11.6, F1.5).
 *
 * One archive serves both requirements: F11.6 wants an audit export for legal
 * and accounting, F1.5 wants a company's full state, events and memory as an
 * archive. They are the same rows.
 *
 * Two decisions shape it.
 *
 * It streams. Rows are handed to a writer one at a time as NDJSON rather than
 * assembled into an object, because an export exists partly for the case where
 * a company has years of history, and an exporter that has to hold all of it
 * in memory fails exactly then.
 *
 * It reads through the tenant boundary, not around it. The export runs inside
 * the company's own scope, so row-level security constrains it like everything
 * else. A control-plane export with BYPASSRLS would be simpler and would mean
 * a bug in a table list could quietly include another tenant's rows -- the one
 * mistake an audit export must not be able to make.
 */
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';

export interface ArchiveLine {
  section: string;
  row: Record<string, unknown>;
}

export type ArchiveWriter = (line: ArchiveLine) => void | Promise<void>;

export interface ExportOptions {
  /**
   * Whether to include prompt and response bodies (F11.5 keeps these for a
   * shorter window than the traces themselves). Defaults to false: an audit
   * export usually needs to show that a call happened and what it cost, not
   * what was said, and the smaller archive is the safer one to hand over.
   */
  includePrompts?: boolean;
}

export interface ExportSummary {
  companyId: string;
  companySlug: string;
  exportedAt: string;
  counts: Record<string, number>;
}

/**
 * Sections in dependency order, so an archive can be read back top to bottom.
 *
 * `credentials` deliberately selects the reference and never a value; the
 * database holds no secret to export, and naming the columns explicitly keeps
 * a future column from being swept in by a `SELECT *`.
 */
interface Section {
  name: string;
  sql: string;
  /**
   * Read through the control plane instead of the tenant scope.
   *
   * Only for `governance_log`, which the application role is deliberately not
   * granted: a record of who changed the rules is an owner artefact, not
   * working material for the agents those rules constrain. Keeping that
   * withholding intact means the export cannot read it through the ordinary
   * path, so it reads it with an explicit company predicate instead -- the
   * predicate doing the work row-level security does everywhere else.
   */
  viaControlPlane?: boolean;
}

const SECTIONS: Section[] = [
  { name: 'company', sql: 'SELECT id, slug, name, timezone, frozen_at, created_at FROM companies' },
  { name: 'projects', sql: 'SELECT id, slug, name, created_at FROM projects ORDER BY created_at' },
  {
    name: 'divisions',
    sql: `SELECT id, parent_division_id, depth, slug, name, max_concurrency, created_at
            FROM divisions ORDER BY depth, slug`,
  },
  {
    name: 'roles',
    sql: `SELECT id, division_id, slug, system_prompt, model, tools, input_schema,
                 output_schema, max_tokens_per_run, attempt_max, created_at
            FROM roles ORDER BY slug`,
  },
  {
    name: 'capability_grants',
    sql: `SELECT id, division_id, capability_name, tier_override, rate_limit_per_hour, created_at
            FROM capability_grants ORDER BY created_at`,
  },
  {
    name: 'credentials',
    // Reference and version only. There is no secret value in this database to
    // export, and this list says so explicitly rather than relying on that.
    sql: `SELECT id, division_id, alias, secret_ref, version, rotated_at, created_at
            FROM credentials ORDER BY created_at`,
  },
  {
    name: 'budget_accounts',
    sql: `SELECT id, label, tokens_max, tokens_spent, tokens_reserved,
                 money_max_cents, money_spent_cents, created_at
            FROM budget_accounts ORDER BY created_at`,
  },
  {
    name: 'tasks',
    sql: `SELECT id, project_id, division_id, role_id, parent_task_id, budget_account_id,
                 status, halt_reason, input, output, hop_depth, hop_max, deadline_at,
                 idempotency_key, created_by, attempt, created_at, started_at, finished_at
            FROM tasks ORDER BY created_at`,
  },
  {
    name: 'task_steps',
    sql: `SELECT task_id, step_index, name, kind, status, idempotency_key, output,
                 error, attempt, started_at, committed_at
            FROM task_steps ORDER BY task_id, step_index`,
  },
  {
    name: 'agent_runs',
    sql: `SELECT id, task_id, role_id, attempt, status, tokens_used, started_at, finished_at
            FROM agent_runs ORDER BY started_at`,
  },
  {
    name: 'events',
    sql: `SELECT id, project_id, task_id, type, actor, payload, trace_id, occurred_at
            FROM events ORDER BY occurred_at, id`,
  },
  {
    name: 'memories',
    sql: `SELECT id, memory_type, scope_type, scope_id, body, confidence, source,
                 shared, source_event_id, valid_from, superseded_by, approval_state,
                 approved_at, fact_kind, embedding_model, created_at
            FROM memories ORDER BY created_at`,
  },
  {
    name: 'decision_records',
    sql: `SELECT id, project_id, task_id, proposal, critique, decision, criteria,
                 source_event_id, review_request_id, proposer_role_id, reviewer_role_id, created_at
            FROM decision_records ORDER BY created_at`,
  },
  {
    name: 'review_requests',
    sql: `SELECT id, proposer_task_id, proposer_role_id, reviewer_role_id, review_task_id,
                 capability_name, action_fingerprint, proposal, criteria, round, status,
                 decision, reason, created_at, decided_at
            FROM review_requests ORDER BY created_at`,
  },
  {
    name: 'inbox_items',
    sql: `SELECT id, task_id, kind, status, title, action_summary, rationale, tier,
                 estimated_cost_cents, consequence_if_denied, capability_name,
                 expires_at, decision, decided_at, owner_note, created_at
            FROM inbox_items ORDER BY created_at`,
  },
  {
    name: 'schedules',
    sql: `SELECT id, project_id, division_id, role_id, slug, cron_expression, timezone,
                 input, enabled, last_run_at, next_run_at, created_at
            FROM schedules ORDER BY created_at`,
  },
  {
    name: 'governance_log',
    sql: `SELECT id, subject, subject_id, division_id, action, before, after, actor, occurred_at
            FROM governance_log WHERE company_id = $1 ORDER BY occurred_at`,
    viaControlPlane: true,
  },
  {
    name: 'retention_log',
    sql: 'SELECT id, action, rows_affected, through_at, occurred_at FROM retention_log ORDER BY occurred_at',
  },
];

const TRACES_WITH_PROMPTS = `
  SELECT id, task_id, agent_run_id, model, prompt, response, input_tokens,
         output_tokens, cost_cents, latency_ms, occurred_at
    FROM llm_traces ORDER BY occurred_at`;

const TRACES_WITHOUT_PROMPTS = `
  SELECT id, task_id, agent_run_id, model, input_tokens, output_tokens,
         cost_cents, latency_ms, occurred_at
    FROM llm_traces ORDER BY occurred_at`;

/** Rows are fetched in pages so a long history does not arrive all at once. */
const PAGE_SIZE = 500;

async function streamSection(
  tx: TenantClient,
  section: string,
  sql: string,
  write: ArchiveWriter,
  params: unknown[] = [],
): Promise<number> {
  let offset = 0;
  let total = 0;

  for (;;) {
    const { rows } = await tx.query<Record<string, unknown>>(
      `${sql} LIMIT ${PAGE_SIZE} OFFSET ${offset}`,
      params,
    );
    for (const row of rows) {
      await write({ section, row });
      total += 1;
    }
    if (rows.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return total;
}

export async function exportCompany(
  companyId: string,
  write: ArchiveWriter,
  options: ExportOptions = {},
): Promise<ExportSummary> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ slug: string }>('SELECT slug FROM companies WHERE id = $1', [
      companyId,
    ]);
    const slug = rows[0]?.slug;
    if (!slug) throw new Error(`company ${companyId} not found, or not visible in this scope`);

    const counts: Record<string, number> = {};

    for (const section of SECTIONS) {
      if (section.viaControlPlane) {
        counts[section.name] = await withControlPlane((admin) =>
          streamSection(admin, section.name, section.sql, write, [companyId]),
        );
        continue;
      }
      counts[section.name] = await streamSection(tx, section.name, section.sql, write);
    }

    counts.llm_traces = await streamSection(
      tx,
      'llm_traces',
      options.includePrompts ? TRACES_WITH_PROMPTS : TRACES_WITHOUT_PROMPTS,
      write,
    );

    return {
      companyId,
      companySlug: slug,
      // Stamped by the caller's clock rather than the database's, so an
      // archive says when it was taken rather than when a row was written.
      exportedAt: new Date().toISOString(),
      counts,
    };
  });
}

/**
 * Collects an export into memory.
 *
 * For tests and for small companies. Anything that might be large should pass
 * a writer that streams to a file or an object store instead -- which is why
 * the streaming form is the primary interface and this is the convenience.
 */
export async function collectExport(
  companyId: string,
  options: ExportOptions = {},
): Promise<{ summary: ExportSummary; sections: Record<string, Array<Record<string, unknown>>> }> {
  const sections: Record<string, Array<Record<string, unknown>>> = {};
  const summary = await exportCompany(
    companyId,
    (line) => {
      (sections[line.section] ??= []).push(line.row);
    },
    options,
  );
  return { summary, sections };
}
