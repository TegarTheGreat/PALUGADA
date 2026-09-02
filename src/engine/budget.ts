/**
 * Budget accounting (PRD F5.4, principle 8).
 *
 * "Budget diwariskan, bukan diberikan ulang": a sub-task draws on its
 * parent's account rather than receiving a fresh allowance, so a tree of
 * delegations cannot mint spending power by growing. All arithmetic happens
 * inside single SQL statements whose guard is in the WHERE clause, which keeps
 * concurrent sub-tasks (permitted by F5.7) from interleaving a read and a
 * write to overspend.
 */
import type { TenantClient } from '../db/tenant.ts';

export interface BudgetSnapshot {
  tokensMax: number;
  tokensSpent: number;
  tokensReserved: number;
  moneyMaxCents: number;
  moneySpentCents: number;
}

export async function createAccount(
  tx: TenantClient,
  input: { companyId: string; label: string; tokensMax: number; moneyMaxCents?: number },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO budget_accounts (company_id, label, tokens_max, money_max_cents)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.companyId, input.label, input.tokensMax, input.moneyMaxCents ?? 0],
  );
  return rows[0]!.id;
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
