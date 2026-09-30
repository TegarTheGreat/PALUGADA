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
  { name: 'company', sql: 'SELECT id, slug, name, timezone, frozen_at, created_at, work_language, talk_language, stage FROM companies' },
  { name: 'projects', sql: 'SELECT id, slug, name, created_at, description, archived_at FROM projects ORDER BY created_at' },
  {
    name: 'divisions',
    // With its escalation policy (F2.1): who hears about a problem first and
    // how long they have. A division restored without it sends every
    // escalation straight to the owner.
    sql: `SELECT id, parent_division_id, depth, slug, name, max_concurrency,
                 escalation_role_slug, escalate_after_minutes, created_at
            FROM divisions ORDER BY depth, slug`,
  },
  {
    name: 'roles',
    // F1.5 counts a role's runtime, routing, completion criteria and run
    // length as config: an archive that restored a role without them would
    // restore something that behaves differently and is still called the
    // same thing.
    sql: `SELECT id, division_id, slug, system_prompt, model, tools, input_schema,
                 output_schema, max_tokens_per_run, attempt_max, done_criteria,
                 runtime, backend, model_primary, model_fallback,
                 heartbeat_minutes, dormant_until, frozen_at, frozen_reason, created_at,
                 display_name, title, persona, max_run_seconds
            FROM roles ORDER BY slug`,
  },
  {
    name: 'goals',
    // `status`, or an abandoned goal comes back active and its work with it.
    sql: `SELECT id, parent_goal_id, kind, slug, statement, status, created_at
            FROM goals ORDER BY created_at`,
  },
  {
    name: 'goal_metrics',
    sql: `SELECT id, goal_id, slug, name, unit, direction, baseline, target, due_on,
                 source_capability, created_at, retired_at
            FROM goal_metrics ORDER BY created_at`,
  },
  {
    name: 'capability_grants',
    sql: `SELECT id, division_id, capability_name, tier_override, rate_limit_per_hour, max_in_flight, created_at
            FROM capability_grants ORDER BY created_at`,
  },
  {
    name: 'credentials',
    // Reference and version only. There is no secret value in this database to
    // export, and this list says so explicitly rather than relying on that.
    // `scopes` too (F12.6): a credential restored without its declared scopes
    // is refused by every capability that checks them.
    sql: `SELECT id, division_id, alias, secret_ref, scopes, version, rotated_at, created_at
            FROM credentials ORDER BY created_at`,
  },
  {
    name: 'budget_accounts',
    sql: `SELECT id, label, tokens_max, tokens_spent, tokens_reserved,
                 money_max_cents, money_spent_cents, scope_type, scope_id,
                 parent_account_id, created_at
            FROM budget_accounts ORDER BY created_at`,
  },
  {
    name: 'tasks',
    sql: `SELECT id, project_id, division_id, role_id, parent_task_id, budget_account_id,
                 status, halt_reason, input, output, hop_depth, hop_max, deadline_at,
                 idempotency_key, input_hash, created_by, attempt, attempt_max,
                 tokens_reserved, goal_id, lane_key, batchable, priority,
                 wait_until, plan, schedule_id, created_at, started_at, finished_at
            FROM tasks ORDER BY created_at`,
  },
  {
    // 0054. The door without its key: the URL's id and the token's hash are
    // this instance's, and a restored trigger is given new ones, closed. A
    // signed trigger's secret reference travels, like a credential's (0056):
    // it names where the secret is, and the secret stays there.
    name: 'triggers',
    sql: `SELECT id, slug, project_id, division_id, role_id, goal_id, instruction, max_per_hour,
                 enabled, scheme, secret_ref, created_at
            FROM triggers ORDER BY created_at`,
  },
  {
    // 0058. Which role takes over when another finishes, and with what brief.
    name: 'handoff_rules',
    sql: `SELECT id, from_role_id, to_role_id, brief, enabled, created_at
            FROM handoff_rules ORDER BY created_at`,
  },
  {
    // After the tasks, which a delivery names.
    name: 'trigger_deliveries',
    sql: `SELECT id, trigger_id, delivery_key, received_at, outcome, task_id
            FROM trigger_deliveries ORDER BY received_at`,
  },
  {
    // After the tasks, which an agent's reading names.
    name: 'metric_observations',
    sql: `SELECT id, metric_id, value, observed_at, task_id, verified, recorded_by, note
            FROM metric_observations ORDER BY observed_at`,
  },
  {
    // The company's documents (0075), whole and in passages.
    name: 'documents',
    sql: `SELECT id, division_id, title, body, file_name, source, created_at, archived_at
            FROM documents ORDER BY created_at`,
  },
  {
    // Without `words`, which the database generates from the heading and the
    // text, and generates again on the way in.
    name: 'document_passages',
    sql: `SELECT document_id, seq, heading, body FROM document_passages ORDER BY document_id, seq`,
  },
  {
    // The backlog (0070): what was owed, who filed it, and what worked it.
    name: 'tickets',
    sql: `SELECT id, project_id, division_id, title, body, status, priority, opened_by, opened_by_task_id,
                 working_task_id, closed_reason, created_at, updated_at, closed_at
            FROM tickets ORDER BY created_at`,
  },
  {
    name: 'task_steps',
    sql: `SELECT task_id, step_index, name, kind, status, idempotency_key, input_hash,
                 output, error, attempt, started_at, committed_at, input
            FROM task_steps ORDER BY task_id, step_index`,
  },
  {
    name: 'agent_runs',
    sql: `SELECT id, task_id, role_id, attempt, status, tokens_used, started_at,
                 last_heartbeat_at, finished_at
            FROM agent_runs ORDER BY started_at`,
  },
  {
    // 0055. What each run said as it worked, already redacted when it was kept.
    name: 'run_notes',
    sql: `SELECT id, task_id, agent_run_id, seq, body, said_at
            FROM run_notes ORDER BY said_at, seq`,
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
                 approved_at, fact_kind, embedding, embedding_model, created_at,
                 outside, source_task_id, reinforced_count, last_reinforced_at
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
    sql: `SELECT id, project_id, proposer_task_id, proposer_role_id, reviewer_role_id,
                 review_task_id, capability_name, action_fingerprint, proposal, criteria,
                 round, status, decision, reason, created_at, decided_at
            FROM review_requests ORDER BY created_at`,
  },
  {
    name: 'inbox_items',
    // `closed_reason` because a withdrawn item without one is refused by 0036,
    // so an archive holding one could not be restored; `payload` because it is
    // what an answer acts on -- the memory an SOP candidate is, the schedule
    // an escalation is about -- and an item without it is a question whose
    // answer does nothing.
    sql: `SELECT id, task_id, kind, status, title, action_summary, rationale, tier,
                 estimated_cost_cents, consequence_if_denied, capability_name,
                 expires_at, decision, decided_at, decided_via, owner_note,
                 closed_reason, notify_after, payload, action_fingerprint,
                 consumed_at, snoozed_until, created_at
            FROM inbox_items ORDER BY created_at`,
  },
  {
    name: 'schedules',
    sql: `SELECT id, project_id, division_id, role_id, budget_account_id, slug,
                 cron_expression, timezone, input, reserve_tokens, batchable, goal_id,
                 priority, enabled, last_run_at, next_run_at, created_at
            FROM schedules ORDER BY created_at`,
  },
  {
    name: 'governance_log',
    sql: `SELECT id, subject, subject_id, division_id, action, before, after, actor, occurred_at
            FROM governance_log WHERE company_id = $1 ORDER BY occurred_at`,
    viaControlPlane: true,
  },
  {
    // F1.5: the knowledge, and the two gates it passed to become knowledge.
    name: 'skills',
    // `provenance`, `origin` and `quarantined` travel because an archive that
    // dropped them would lose the fact that a skill came from outside — and a
    // restored company would treat a hub's document as its own work (F15.8).
    // The destination re-quarantines regardless; what it needs from the archive
    // is to know there is something to re-quarantine.
    sql: `SELECT id, slug, scope_type, scope_id, summary, active_version,
                 provenance, origin, quarantined, created_at
            FROM skills ORDER BY slug`,
  },
  {
    name: 'skill_versions',
    sql: `SELECT id, skill_id, version, body, author, changelog, state,
                 review_request_id, reviewed_at, approved_at, activated_at,
                 rejected_reason, created_at, review_task_id, review_note
            FROM skill_versions ORDER BY skill_id, version`,
  },
  {
    name: 'skill_evals',
    sql: `SELECT id, skill_id, name, input, expect_contains, created_at
            FROM skill_evals ORDER BY skill_id, name`,
  },
  {
    // F1.5, F3.9: every version of every configuration, so an archive can
    // answer "what did this look like in March" as well as "what does it look
    // like now".
    name: 'config_versions',
    // `WHERE company_id IS NOT NULL`, and it is not decoration. 0027 made this
    // table shared-scope so a tenant can *read* the platform's own versions --
    // the platform charter, the platform policies -- and without the filter
    // every company archive carried them, and `importCompany` rewrote them as
    // the destination company's own. One company's archive would have installed
    // the source installation's platform charter as company configuration.
    sql: `SELECT id, kind, subject_id, version, snapshot, summary, changed_by, created_at
            FROM config_versions WHERE company_id IS NOT NULL
           ORDER BY kind, subject_id, version`,
  },
  {
    name: 'role_eval_cases',
    sql: `SELECT id, role_id, name, polarity, source_agent_run_id, task_input,
                 trajectory, expectation, accepted_at, created_at
            FROM role_eval_cases ORDER BY role_id, name`,
  },
  {
    name: 'bundle_installs',
    sql: `SELECT id, bundle_id, slug, version, installed_hash, quarantined, installed_at
            FROM bundle_installs ORDER BY installed_at`,
  },
  {
    name: 'retention_log',
    sql: 'SELECT id, action, rows_affected, through_at, occurred_at FROM retention_log ORDER BY occurred_at',
  },

  // F1.5's "config", and the reason this block exists rather than being
  // covered by `config_versions` above. That section carries the *history* of
  // a policy; these carry the rules in force. A company restored with its
  // version history and no live policies would run with nothing requiring
  // approval of anything, which is the worst shape a gap can take: silently
  // permissive, and an archive that looks complete.
  //
  // Every one of these is a rule the owner set and would have to set again.
  {
    name: 'policies',
    // Company- and division-scoped only. A platform-scoped policy
    // (company_id IS NULL) belongs to the installation, not to this company,
    // and carrying it would let an archive install a platform rule on import.
    sql: `SELECT id, division_id, slug, effect, condition, mode, params, created_at
            FROM policies WHERE company_id IS NOT NULL
           ORDER BY division_id NULLS FIRST, slug`,
  },
  {
    name: 'spend_limits',
    // `paused_at` and `pause_reason` are deliberately absent: whether this
    // company is currently paused for spending is a fact about the instance it
    // was paused on, and a restore that arrived already paused would be
    // reporting a ceiling it has not reached here.
    sql: `SELECT id, money_max_cents, override_until, created_at
            FROM spend_limits WHERE company_id IS NOT NULL`,
  },
  {
    name: 'alert_thresholds',
    sql: `SELECT id, daily_cost_cents, policy_denials_per_day,
                 verification_failures_per_day, task_failure_rate,
                 role_freeze_denials_per_day, spend_rate_multiple, spend_rate_floor_cents,
                 created_at
            FROM alert_thresholds WHERE company_id IS NOT NULL`,
  },
  {
    // The company's own charter (F3.2), every version. Company rows only, for
    // the reason `config_versions` gives: the platform's charter is readable
    // here and is not this company's to carry.
    name: 'charters',
    sql: `SELECT id, version, body, created_at
            FROM charters WHERE company_id IS NOT NULL ORDER BY version`,
  },
  {
    // How far distillation has read (F4.5). Without it the destination starts
    // from the beginning of the company's history: every fact distilled again,
    // as a duplicate, and paid for again in model calls.
    name: 'distillation_state',
    sql: `SELECT scope_id, kind, through_at, updated_at
            FROM distillation_state ORDER BY kind, scope_id`,
  },
  {
    // What each completion's handoff came to (0042). Without it every
    // completion still inside the handoff window is decided again.
    name: 'task_handoffs',
    sql: `SELECT from_task_id, to_role_slug, outcome, to_task_id, reason_code, reason, decided_at
            FROM task_handoffs ORDER BY decided_at`,
  },
  {
    // A role's eval history (F17): how it scored, run by run.
    name: 'role_eval_runs',
    sql: `SELECT id, role_id, triggered_by, passed, failed, detail, ran_at
            FROM role_eval_runs ORDER BY ran_at`,
  },
  {
    // Carried for the auditor, not restored; the import's section list says why.
    name: 'gateway_devices',
    sql: `SELECT id, name, runtime, public_key, status, quarantined, paired_at,
                 last_seen_at, created_at
            FROM gateway_devices ORDER BY created_at`,
  },
  {
    name: 'retention_policies',
    sql: `SELECT id, event_days, trace_days, prompt_days, created_at
            FROM retention_policies WHERE company_id IS NOT NULL`,
  },
  {
    name: 'batch_windows',
    sql: `SELECT id, timezone, start_hour, end_hour, days_of_week, created_at
            FROM batch_windows WHERE company_id IS NOT NULL`,
  },
  {
    name: 'capability_windows',
    sql: `SELECT id, division_id, capability_name, timezone, start_hour,
                 end_hour, days_of_week, created_at
            FROM capability_windows WHERE company_id IS NOT NULL
           ORDER BY capability_name, division_id NULLS FIRST`,
  },
];

const TRACES_WITH_PROMPTS = `
  SELECT id, task_id, agent_run_id, kind, model, prompt, response, input_tokens,
         output_tokens, cost_cents, latency_ms, occurred_at
    FROM llm_traces ORDER BY occurred_at`;

const TRACES_WITHOUT_PROMPTS = `
  SELECT id, task_id, agent_run_id, kind, model, input_tokens, output_tokens,
         cost_cents, latency_ms, occurred_at
    FROM llm_traces ORDER BY occurred_at`;

/**
 * Every section this export writes, so the import can be checked against it.
 *
 * `audit-export.test.ts` asserts that the difference between this list and the
 * import's is exactly the three sections deliberately left behind. Six
 * sections had gone missing from the import without anybody noticing --
 * credentials, review requests, decision records, the governance log, and two
 * on purpose -- which is what a comparison nobody can run looks like from the
 * inside. `company` and `llm_traces` are added by hand because neither is in
 * `SECTIONS`: the first is one row written before the loop, the second is
 * streamed separately so its prompt columns can be chosen at run time.
 */
export const EXPORT_SECTION_NAMES: readonly string[] = [
  'company',
  ...SECTIONS.map((section) => section.name),
  'llm_traces',
];

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
