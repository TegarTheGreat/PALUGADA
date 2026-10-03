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
import { PalugadaError } from '../errors.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';

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
  // A narrower account that says nothing about money inherits its parent's
  // ceiling rather than getting zero. `budget_spend` refuses any spend past
  // `money_max_cents`, so zero means "may never spend a cent": a division
  // account opened with only a token ceiling halted every task that drew on
  // it at its first priced model call. The chain check still binds at the
  // smallest ancestor, so inheriting narrows nothing it should not. The
  // company's own account has no parent to inherit from and keeps zero,
  // which is a ceiling the owner has to state.
  let moneyMaxCents = input.moneyMaxCents;
  if (moneyMaxCents === undefined && scope.scopeType !== 'company') {
    const { rows: parent } = await tx.query<{ money_max_cents: string }>(
      'SELECT money_max_cents FROM budget_accounts WHERE id = $1',
      [scope.parentAccountId],
    );
    moneyMaxCents = parent[0] ? Number(parent[0].money_max_cents) : 0;
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO budget_accounts
       (company_id, label, tokens_max, money_max_cents, scope_type, scope_id,
        parent_account_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      input.companyId,
      input.label,
      input.tokensMax,
      moneyMaxCents ?? 0,
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
 *
 * Two accounts on one scope -- the owner opened "Ramadan promotion" on a
 * division that has its own -- are told apart by the tree: the deeper is the
 * narrower, and between two as deep, the older. Ordered by scope alone, the
 * one charged was whichever row the database read first, and every charge
 * rewrites a row and moves it.
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
                 WHEN 'project' THEN 2 ELSE 3 END,
               cardinality(app.budget_chain(id)) DESC,
               created_at, id
      LIMIT 1`,
    [scope.companyId, scope.roleId ?? null, scope.divisionId ?? null, scope.projectId ?? null],
  );
  return rows[0]?.id ?? null;
}

/**
 * Changes an account's ceilings: the owner's way back for a company that has
 * spent them.
 *
 * On the control plane, because the ceilings are the owner's and the
 * application role may move only the running totals (0047). The account must
 * be the company's own -- an id from another company is refused, not
 * changed. Answers what the ceilings were, so the caller can tell a raise,
 * which loosens a control and takes a factor, from a cut, which does not.
 * Spent tokens stay spent for the rest of the month (0101): raising is how
 * an account is given more before the next one starts (defect L11 of the
 * live run of 2026-09-28, where nothing but SQL could).
 */
export async function setCeilings(
  companyId: string,
  accountId: string,
  ceilings: { tokensMax: number; moneyMaxCents?: number },
  allowed: (before: { tokensMax: number; moneyMaxCents: number }) => Promise<void>,
): Promise<void> {
  const before = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ tokens_max: string; money_max_cents: string }>(
      'SELECT tokens_max, money_max_cents FROM budget_accounts WHERE id = $1 AND company_id = $2',
      [accountId, companyId],
    );
    return rows[0];
  });
  if (!before) {
    throw new PalugadaError('contract.violation', 'this company has no budget account with that id', { accountId });
  }
  const current = { tokensMax: Number(before.tokens_max), moneyMaxCents: Number(before.money_max_cents) };
  await allowed(current);
  await withControlPlane((tx) => tx.query(
    `UPDATE budget_accounts SET tokens_max = $3, money_max_cents = $4
      WHERE id = $1 AND company_id = $2`,
    [accountId, companyId, ceilings.tokensMax, ceilings.moneyMaxCents ?? current.moneyMaxCents],
  ));
}

/** The account and every ancestor it also spends against, nearest first. */
/**
 * Starts a new month in every account of the company whose counts are of a
 * passed one (F1.9, 0101), and says how many.
 *
 * A reservation or a charge does this for its own chain before it checks
 * it, so admission is right without this. It is for the owner: on the first
 * of the month, before anything has run, the Money page would otherwise show
 * last month's total as this one's. The accounts are locked in id order, the
 * order every budget function takes them in, and only when one has a passed
 * month -- most ticks of a month find none and lock nothing.
 */
export async function startNewPeriods(companyId: string): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      'SELECT id FROM budget_accounts WHERE period_start < app.budget_month() ORDER BY id');
    if (rows.length === 0) return 0;
    const ids = rows.map((row) => row.id);
    await tx.query('SELECT app.budget_lock_chain($1::uuid[])', [ids]);
    const { rows: started } = await tx.query<{ n: number }>('SELECT app.budget_new_period($1::uuid[]) AS n', [ids]);
    return started[0]!.n;
  });
}

/**
 * What an account is called, for the owner (§2.3 item 7). An account a
 * template made is labelled with the platform's codes -- "company", a
 * division's short name -- and is named for what it covers instead: its
 * division's name, or null for the whole company, which the reader says in
 * their own language. One the owner labelled keeps its label. `a` is the
 * account; the division it covers is looked up by its id.
 */
export const ACCOUNT_NAME = `CASE
  WHEN a.scope_type = 'company' AND a.label = 'company' THEN NULL
  WHEN a.scope_type = 'division' THEN coalesce(
    (SELECT CASE WHEN dv.slug = a.label THEN dv.name END FROM divisions dv WHERE dv.id = a.scope_id), a.label)
  ELSE a.label END`;

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
