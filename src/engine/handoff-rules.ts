/**
 * Handoffs the owner configures (0058).
 *
 * `handoff.ts` runs rules, and a rule was code a deployment had to compose:
 * the deployment `npm start` boots had none, so no work followed on from
 * other work unless an agent delegated it. Paperclip chains issues by
 * dependency. Here the owner says it in a sentence -- when this role
 * finishes, that one takes over, with this brief -- and the engine does the
 * rest under the rules every handoff keeps: once per completion, a sub-task
 * of the finished work (so the hop limit, the fan-out bound, the budget chain
 * and "begun outside" all carry), in the successor's own division.
 *
 * What the successor is handed is the predecessor's output, as context
 * beside the owner's brief -- never as the brief. The brief is the owner's
 * instruction; the output is material, and it may carry whatever the
 * predecessor read.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { HandoffRule } from './handoff.ts';

/** The most of a predecessor's output a successor is handed; past it, cut and said so. */
const HANDED_MAX_CHARS = 20_000;

export interface HandoffRuleView {
  id: string;
  fromRoleId: string;
  fromRoleSlug: string;
  toRoleId: string;
  toRoleSlug: string;
  brief: string;
  enabled: boolean;
  createdAt: Date;
}

/** The owner chains two roles. */
export async function createHandoffRule(
  companyId: string,
  input: { fromRoleId: string; toRoleId: string; brief: string },
): Promise<string> {
  const brief = String(input.brief ?? '').trim();
  if (!brief || brief.length > 2_000) {
    throw new PalugadaError(
      'contract.violation',
      'say what the next role should do with what it is handed, in at most 2000 characters',
      { field: 'brief' },
    );
  }
  if (input.fromRoleId === input.toRoleId) {
    throw new PalugadaError('contract.violation', 'a role cannot hand work to itself', { field: 'toRoleId' });
  }
  return withControlPlane(async (tx) => {
    const { rows: roles } = await tx.query<{ id: string }>(
      'SELECT id FROM roles WHERE company_id = $1 AND id = ANY($2::uuid[])', [companyId, [input.fromRoleId, input.toRoleId]]);
    if (roles.length !== 2) {
      throw new PalugadaError('contract.violation', 'no such role in this company', { field: 'roleId' });
    }
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO handoff_rules (company_id, from_role_id, to_role_id, brief) VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, from_role_id, to_role_id) DO UPDATE SET brief = EXCLUDED.brief, enabled = true
       RETURNING id`,
      [companyId, input.fromRoleId, input.toRoleId, brief],
    );
    await appendEvent(tx, {
      companyId,
      type: 'handoff_rule.created',
      actor: 'owner',
      payload: { ruleId: rows[0]!.id, fromRoleId: input.fromRoleId, toRoleId: input.toRoleId },
    });
    return rows[0]!.id;
  });
}

export async function setHandoffRuleEnabled(companyId: string, ruleId: string, enabled: boolean): Promise<void> {
  await withControlPlane(async (tx) => {
    const { rowCount } = await tx.query(
      'UPDATE handoff_rules SET enabled = $3 WHERE id = $1 AND company_id = $2', [ruleId, companyId, enabled]);
    if (rowCount !== 1) throw new PalugadaError('contract.violation', 'no such handoff in this company', { ruleId });
    await appendEvent(tx, {
      companyId, type: enabled ? 'handoff_rule.opened' : 'handoff_rule.closed', actor: 'owner', payload: { ruleId },
    });
  });
}

/** The company's handoffs, as the owner reads them. */
export async function handoffRulesOf(companyId: string): Promise<HandoffRuleView[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; from_role_id: string; from_slug: string; to_role_id: string; to_slug: string;
      brief: string; enabled: boolean; created_at: Date;
    }>(
      `SELECT h.id, h.from_role_id, f.slug AS from_slug, h.to_role_id, t.slug AS to_slug, h.brief, h.enabled,
              h.created_at
         FROM handoff_rules h JOIN roles f ON f.id = h.from_role_id JOIN roles t ON t.id = h.to_role_id
        ORDER BY h.created_at`,
    );
    return rows.map((row) => ({
      id: row.id, fromRoleId: row.from_role_id, fromRoleSlug: row.from_slug, toRoleId: row.to_role_id,
      toRoleSlug: row.to_slug, brief: row.brief, enabled: row.enabled, createdAt: row.created_at,
    }));
  });
}

/** The company's switched-on handoffs, as rules the engine runs. */
export async function ownerHandoffRules(companyId: string): Promise<HandoffRule[]> {
  const rules = (await handoffRulesOf(companyId)).filter((rule) => rule.enabled);
  return rules.map((rule) => ({
    fromRoleSlug: rule.fromRoleSlug,
    toRoleSlug: rule.toRoleSlug,
    mapInput: (output) => {
      const handed = JSON.stringify(output, null, 2);
      const cut = handed.length > HANDED_MAX_CHARS
        ? `${handed.slice(0, HANDED_MAX_CHARS)}\n[cut: the result was ${handed.length} characters]`
        : handed;
      return { goal: rule.brief, context: `${rule.fromRoleSlug} finished with this result:\n${cut}` };
    },
  }));
}
