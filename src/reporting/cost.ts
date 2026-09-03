/**
 * Cost reporting (PRD F11.3).
 *
 * Cost is broken down per company, project, division, role and capability, and
 * summarised daily and monthly. It is assembled from two sources that measure
 * different things and must not be conflated:
 *
 *   - LLM traces hold what the models actually cost, per call, already
 *     attributed to a task and therefore to a role and division.
 *   - Budget accounts hold money committed through capabilities.
 *
 * Per-capability figures come from the `tool.cost` event the broker writes
 * after every call (F8.5). A capability that reports what it was billed is
 * counted at that figure; one that reports nothing falls back to the estimate
 * it was charged, and the row is flagged `estimated` so the fallback is
 * visible. The flag is deliberately pessimistic: one unmeasured call in the
 * group marks the whole row, because a dashboard that presents a guess next to
 * a measurement without saying which is which teaches the owner to distrust
 * both.
 */
import { withTenant, withControlPlane } from '../db/tenant.ts';

export type CostDimension = 'project' | 'division' | 'role' | 'capability';

export interface CostRow {
  key: string;
  label: string;
  costCents: number;
  tokens: number;
  calls: number;
  /** True when the figure is an estimate rather than a measured cost. */
  estimated: boolean;
}

export interface CostWindow {
  from: Date;
  to: Date;
}

const MEASURED_SQL: Record<Exclude<CostDimension, 'capability'>, string> = {
  project: `
    SELECT t.project_id::text AS key, p.slug AS label,
           coalesce(sum(tr.cost_cents), 0)::text AS cost_cents,
           coalesce(sum(tr.input_tokens + tr.output_tokens), 0)::text AS tokens,
           count(tr.id)::text AS calls
      FROM llm_traces tr
      JOIN tasks t ON t.id = tr.task_id
      JOIN projects p ON p.id = t.project_id
     WHERE tr.occurred_at >= $1 AND tr.occurred_at < $2
     GROUP BY 1, 2 ORDER BY 3 DESC`,
  division: `
    SELECT t.division_id::text AS key, d.slug AS label,
           coalesce(sum(tr.cost_cents), 0)::text AS cost_cents,
           coalesce(sum(tr.input_tokens + tr.output_tokens), 0)::text AS tokens,
           count(tr.id)::text AS calls
      FROM llm_traces tr
      JOIN tasks t ON t.id = tr.task_id
      JOIN divisions d ON d.id = t.division_id
     WHERE tr.occurred_at >= $1 AND tr.occurred_at < $2
     GROUP BY 1, 2 ORDER BY 3 DESC`,
  role: `
    SELECT t.role_id::text AS key, r.slug AS label,
           coalesce(sum(tr.cost_cents), 0)::text AS cost_cents,
           coalesce(sum(tr.input_tokens + tr.output_tokens), 0)::text AS tokens,
           count(tr.id)::text AS calls
      FROM llm_traces tr
      JOIN tasks t ON t.id = tr.task_id
      JOIN roles r ON r.id = t.role_id
     WHERE tr.occurred_at >= $1 AND tr.occurred_at < $2
     GROUP BY 1, 2 ORDER BY 3 DESC`,
};

export async function costBreakdown(
  companyId: string,
  dimension: CostDimension,
  window: CostWindow,
): Promise<CostRow[]> {
  return withTenant(companyId, async (tx) => {
    if (dimension === 'capability') {
      const { rows } = await tx.query<{
        key: string;
        cost_cents: string;
        calls: string;
        estimated: boolean;
      }>(
        // Three sources in falling order of authority: what the capability was
        // billed, what it was charged before the call, and the registry's flat
        // figure for capabilities that declare neither.
        `SELECT e.payload->>'capability' AS key,
                coalesce(sum(coalesce(
                  nullif(e.payload->>'actualCents', '')::bigint,
                  nullif(e.payload->>'estimatedCents', '')::bigint,
                  c.estimated_cost_cents,
                  0)), 0)::text AS cost_cents,
                count(*)::text AS calls,
                bool_or(e.payload->>'actualCents' IS NULL) AS estimated
           FROM events e
           LEFT JOIN capabilities c ON c.name = e.payload->>'capability'
          WHERE e.type = 'tool.cost'
            AND e.occurred_at >= $1 AND e.occurred_at < $2
            AND e.payload->>'capability' IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
        [window.from, window.to],
      );
      return rows.map((row) => ({
        key: row.key,
        label: row.key,
        costCents: Number(row.cost_cents),
        tokens: 0,
        calls: Number(row.calls),
        estimated: row.estimated,
      }));
    }

    const { rows } = await tx.query<{
      key: string;
      label: string;
      cost_cents: string;
      tokens: string;
      calls: string;
    }>(MEASURED_SQL[dimension], [window.from, window.to]);

    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      costCents: Number(row.cost_cents),
      tokens: Number(row.tokens),
      calls: Number(row.calls),
      estimated: false,
    }));
  });
}

export interface CostPeriod {
  period: string;
  costCents: number;
  tokens: number;
}

export async function costTimeline(
  companyId: string,
  granularity: 'day' | 'month',
  window: CostWindow,
): Promise<CostPeriod[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ period: string; cost_cents: string; tokens: string }>(
      `SELECT to_char(date_trunc($3, occurred_at), $4) AS period,
              coalesce(sum(cost_cents), 0)::text AS cost_cents,
              coalesce(sum(input_tokens + output_tokens), 0)::text AS tokens
         FROM llm_traces
        WHERE occurred_at >= $1 AND occurred_at < $2
        GROUP BY 1 ORDER BY 1`,
      [window.from, window.to, granularity, granularity === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM'],
    );
    return rows.map((row) => ({
      period: row.period,
      costCents: Number(row.cost_cents),
      tokens: Number(row.tokens),
    }));
  });
}

export interface CompanyCost {
  companyId: string;
  slug: string;
  costCents: number;
  tokens: number;
}

/**
 * Cost across every company, for the platform view.
 *
 * The only deliberately cross-tenant read in the reporting layer, and it runs
 * on the control plane because that is the one place allowed to see across
 * companies. It returns totals rather than rows, so a platform summary cannot
 * become a way to read one tenant's content from another's session.
 */
export async function platformCost(window: CostWindow): Promise<CompanyCost[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      company_id: string;
      slug: string;
      cost_cents: string;
      tokens: string;
    }>(
      `SELECT c.id AS company_id, c.slug,
              coalesce(sum(tr.cost_cents), 0)::text AS cost_cents,
              coalesce(sum(tr.input_tokens + tr.output_tokens), 0)::text AS tokens
         FROM companies c
         LEFT JOIN llm_traces tr
           ON tr.company_id = c.id AND tr.occurred_at >= $1 AND tr.occurred_at < $2
        GROUP BY 1, 2 ORDER BY 3 DESC`,
      [window.from, window.to],
    );
    return rows.map((row) => ({
      companyId: row.company_id,
      slug: row.slug,
      costCents: Number(row.cost_cents),
      tokens: Number(row.tokens),
    }));
  });
}
