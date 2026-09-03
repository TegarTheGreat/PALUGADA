/**
 * Budget accounting (PRD F5.4, F1.6, principle 8).
 *
 * "Budget diwariskan, bukan diberikan ulang": a sub-task draws on its
 * parent's account rather than receiving a fresh allowance, so a tree of
 * delegations cannot mint spending power by growing. F1.6 applies the same
 * rule to the org chart: an account belongs to a company, a project, a
 * division or a role, and spending against a narrow one also spends against
 * every account above it. Raising a division's ceiling therefore cannot raise
 * the company's, which is the only arrangement under which a company ceiling
 * means anything.
 *
 * The arithmetic is in the database and it is all-or-nothing. A charge that
 * succeeded against the division and failed against the company would leave
 * the two disagreeing about what has been spent, with no good way to tell
 * afterwards which is right -- so the whole chain is locked in a fixed order,
 * checked, and only then moved. Concurrent sub-tasks (permitted by F5.7)
 * therefore cannot interleave a read and a write to overspend, and two
 * overlapping chains cannot deadlock against each other.
 */
import type { TenantClient } from '../db/tenant.ts';

export interface BudgetSnapshot {
  tokensMax: number;
  tokensSpent: number;
  tokensReserved: number;
  moneyMaxCents: number;
  moneySpentCents: number;
}

/**
 * F1.6: which scope an account belongs to.
 *
 * A company account is the root. Everything narrower names its subject and its
 * parent, and spending against it also spends against every ancestor -- which
 * is what makes a division's ceiling a limit rather than a suggestion.
 */
export type BudgetScope =
  | { scopeType: 'company' }
  | { scopeType: 'project' | 'division' | 'role'; scopeId: string; parentAccountId: string };

export async function createAccount(
  tx: TenantClient,
  input: {
    companyId: string;
    label: string;
    tokensMax: number;
    moneyMaxCents?: number;
    scope?: BudgetScope;
  },
): Promise<string> {
  const scope = input.scope ?? { scopeType: 'company' as const };
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO budget_accounts
       (company_id, label, tokens_max, money_max_cents, scope_type, scope_id,
        parent_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.companyId,
      input.label,
      input.tokensMax,
      input.moneyMaxCents ?? 0,
      scope.scopeType,
      scope.scopeType === 'company' ? null : scope.scopeId,
      scope.scopeType === 'company' ? null : scope.parentAccountId,
    ],
  );
  return rows[0]!.id;
}

/**
 * The account a task should draw on, given where it belongs (F1.6).
 *
 * Narrowest first: a role's own account, then its division's, then the
 * company's. A task charged to the company account when its division has one
 * would make the division's ceiling unenforceable, which is the failure this
 * lookup exists to prevent.
 */
export async function accountFor(
  tx: TenantClient,
  scope: { companyId: string; roleId?: string | null; divisionId?: string | null;
           projectId?: string | null },
): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM budget_accounts
      WHERE company_id = $1
        AND ((scope_type = 'role'     AND scope_id = $2)
          OR (scope_type = 'division' AND scope_id = $3)
          OR (scope_type = 'project'  AND scope_id = $4)
          OR  scope_type = 'company')
      ORDER BY CASE scope_type
                 WHEN 'role' THEN 0 WHEN 'division' THEN 1
                 WHEN 'project' THEN 2 ELSE 3 END
      LIMIT 1`,
    [scope.companyId, scope.roleId ?? null, scope.divisionId ?? null, scope.projectId ?? null],
  );
  return rows[0]?.id ?? null;
}

/** The account and every ancestor it also spends against, nearest first. */
export async function chainFor(tx: TenantClient, accountId: string): Promise<string[]> {
  const { rows } = await tx.query<{ chain: string[] | null }>(
    'SELECT app.budget_chain($1) AS chain',
    [accountId],
  );
  return rows[0]?.chain ?? [];
}

export async function snapshot(tx: TenantClient, accountId: string): Promise<BudgetSnapshot> {
  const { rows } = await tx.query<{
    tokens_max: string;
    tokens_spent: string;
    tokens_reserved: string;
    money_max_cents: string;
    money_spent_cents: string;
  }>(
    `SELECT tokens_max, tokens_spent, tokens_reserved, money_max_cents, money_spent_cents
       FROM budget_accounts WHERE id = $1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) throw new Error(`budget account ${accountId} not found`);
  return {
    tokensMax: Number(row.tokens_max),
    tokensSpent: Number(row.tokens_spent),
    tokensReserved: Number(row.tokens_reserved),
    moneyMaxCents: Number(row.money_max_cents),
    moneySpentCents: Number(row.money_spent_cents),
  };
}

/**
 * Admission control. Reserves an allowance before a task is allowed to start,
 * so that the fourth sibling is refused while three are still in flight rather
 * than discovering the shortfall halfway through.
 */
export async function reserve(
  tx: TenantClient,
  accountId: string,
  tokens: number,
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    'SELECT app.budget_reserve($1, $2) AS ok',
    [accountId, tokens],
  );
  return rows[0]!.ok;
}

export async function release(
  tx: TenantClient,
  accountId: string,
  tokens: number,
): Promise<void> {
  await tx.query('SELECT app.budget_release($1, $2)', [accountId, tokens]);
}

/**
 * Charges actual consumption. Returns false when the charge would breach the
 * ceiling, which the caller turns into a halt rather than a retry: the PRD is
 * explicit that a task stopped by budget is never resumed automatically.
 */
export async function spend(
  tx: TenantClient,
  accountId: string,
  input: { tokens: number; moneyCents?: number; fromReservation?: number },
): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>(
    'SELECT app.budget_spend($1, $2, $3, $4) AS ok',
    [accountId, input.tokens, input.moneyCents ?? 0, input.fromReservation ?? 0],
  );
  return rows[0]!.ok;
}
