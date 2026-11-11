/**
 * What the owner's conversations may spend, and how each turn is paid for
 * before it is made (F19.12, STATUS 2.205).
 *
 * A company's CEO answering its owner is a model call like any of the
 * company's, so it is held to the company's money as a task is: each turn
 * reserves its estimate from the narrowest account that covers the CEO --
 * its role's, its division's, the company's -- before the call, and spends
 * from that reservation when the call answers (`budget.ts`). The reservation
 * is also a row (`conversation_holds`, STATUS 2.205), written in the transaction that
 * reserves and deleted in the one that spends or lets it go, so a process
 * killed in the middle of a call leaves something the worker's sweep can
 * release rather than an account short for the rest of the month.
 *
 * PALUGADA's own assistant belongs to no company and has no account: what
 * it may spend is the deployment's monthly allowance
 * (`platform_control.assistant_month_cents`, 0149), and a turn is admitted
 * only while what the month has spent, with the turn's estimate, still fits.
 * That is an admission, not a reservation: two answers at once can both be
 * admitted, by at most a turn each.
 */
import type { LlmTurnRequest } from '../llm/client.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { accountFor, release, reserve, spend } from '../engine/budget.ts';
import { costOf, DEFAULT_PRICE_TABLE } from '../engine/pricing.ts';
import { periodBounds } from '../governance/spend-guard.ts';
import { assistantCost } from '../reporting/cost.ts';
import { PalugadaError } from '../errors.ts';

/**
 * How long a hold outlives the turn that made it before it is taken for a
 * dead process's. A call is given ten minutes an attempt and three attempts,
 * with waits between them (`src/llm/transport.ts`), so no live turn holds for
 * much more than half an hour; a sweep that took a live turn's hold would let
 * other work reserve what that turn is about to spend.
 */
const HOLD_LAPSES_MS = 45 * 60_000;

/** The most PALUGADA's own conversation may be allowed in a month: what the column holds, in cents. */
const ALLOWANCE_MAX_CENTS = 2_147_483_647;

/** A turn's reservation, while the model thinks. */
export interface Hold {
  id: string;
  companyId: string;
  accountId: string;
  tokens: number;
}

/**
 * What a turn may use, reckoned before it is asked: a quarter of every
 * character it sends -- the instructions, the conversation, the tools -- as
 * what it reads, and the whole of the room it is given to answer in. A token
 * is about four characters of English and fewer of most other scripts, so a
 * turn in Thai or Japanese may read more than this says; the spend that
 * follows is what the provider counted, whatever was reserved.
 */
export function turnUse(request: LlmTurnRequest): { input: number; output: number } {
  const characters = request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
  return { input: Math.ceil(characters / 4), output: request.maxTokens ?? 0 };
}

/**
 * Reserves a CEO's turn, and keeps the reservation in a row, in one
 * transaction: null when the account has no room, which then holds nothing.
 *
 * No room is no tokens left, as a task's admission says it, and also money
 * spent: an account at its money ceiling (one above nothing) has no room
 * however many tokens it has, or each question would buy one more call past
 * it. An account allowed no money at all still lets a call that costs
 * nothing go, as the engine's own check before a call does.
 */
export async function holdTurn(
  speaker: { companyId: string; roleId: string; divisionId: string }, tokens: number,
): Promise<Hold | null> {
  return withTenant(speaker.companyId, async (tx) => {
    const accountId = await accountFor(tx, { companyId: speaker.companyId, roleId: speaker.roleId, divisionId: speaker.divisionId });
    if (!accountId) return null;
    const { rows } = await tx.query<{ spent: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM budget_accounts WHERE id = ANY(app.budget_chain($1))
                       AND (money_spent_cents > money_max_cents
                            OR (money_max_cents > 0 AND money_spent_cents >= money_max_cents))) AS spent`,
      [accountId]);
    if (rows[0]?.spent) return null;
    if (!(await reserve(tx, accountId, tokens))) return null;
    const { rows: held } = await tx.query<{ id: string }>(
      'INSERT INTO conversation_holds (company_id, budget_account_id, tokens) VALUES ($1, $2, $3) RETURNING id',
      [speaker.companyId, accountId, tokens]);
    return { id: held[0]!.id, companyId: speaker.companyId, accountId, tokens };
  });
}

/**
 * Takes a hold's row away, and answers what it still held: nothing when the
 * sweep took it first, which already gave its tokens back. The row first,
 * then the account, the order the sweep takes them in too.
 */
async function takeHold(tx: TenantClient, hold: Hold): Promise<number> {
  const { rows } = await tx.query<{ tokens: number }>('DELETE FROM conversation_holds WHERE id = $1 RETURNING tokens', [hold.id]);
  return rows[0] ? Number(rows[0].tokens) : 0;
}

/**
 * Spends what a turn used from its reservation and lets the rest go, in the
 * transaction that records the call (`recordCallOutsideTask`). False when
 * the account cannot pay for it: the call was made and stays a trace, which
 * the month's ceiling reads, everything the turn held goes back, its tokens
 * are not spent, and the answer goes no further. Its money is still settled
 * into the account and every account above it, past the ceiling, as a
 * task's refused call is (`budget_settle`, 0037): the provider billed it,
 * and an account that never read as spent would admit the next question,
 * and buy one more call past its ceiling with each.
 */
export async function spendTurn(tx: TenantClient, hold: Hold, used: number, moneyCents: number): Promise<boolean> {
  const held = await takeHold(tx, hold);
  const paid = await spend(tx, hold.accountId, { tokens: used, moneyCents, fromReservation: held });
  // `budget_spend` takes from the reservation what the turn used, up to what
  // it held; what is left of it goes back now.
  const left = paid ? Math.max(0, held - used) : held;
  if (left > 0) await release(tx, hold.accountId, left);
  if (!paid && moneyCents > 0) await tx.query('SELECT app.budget_settle($1, $2)', [hold.accountId, moneyCents]);
  return paid;
}

/** Lets a turn's whole reservation go: the call failed, was stopped, or never counted. */
export async function letGo(hold: Hold): Promise<void> {
  await withTenant(hold.companyId, async (tx) => {
    const held = await takeHold(tx, hold);
    if (held > 0) await release(tx, hold.accountId, held);
  });
}

/**
 * Releases what turns that died in the middle of a call still hold in one
 * company, and says how many: the worker's `holds` stage, once a minute.
 *
 * Every account the released holds reach is locked first, together and in
 * the order every budget function takes them (0024, 0040), so releasing
 * several in one transaction cannot deadlock with work spending on one.
 */
export async function releaseStaleHolds(companyId: string, now = new Date()): Promise<number> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ budget_account_id: string; tokens: number }>(
      'DELETE FROM conversation_holds WHERE held_at < $1 RETURNING budget_account_id, tokens',
      [new Date(now.getTime() - HOLD_LAPSES_MS)]);
    if (rows.length === 0) return 0;
    const accounts = [...new Set(rows.map((row) => row.budget_account_id))];
    await tx.query(
      'SELECT app.budget_lock_chain(ARRAY(SELECT DISTINCT unnest(app.budget_chain(account)) FROM unnest($1::uuid[]) AS account))',
      [accounts]);
    for (const row of rows) await release(tx, row.budget_account_id, Number(row.tokens));
    return rows.length;
  });
}

/** What PALUGADA's own conversation may spend this month, and has: both in US cents. */
export async function assistantAllowance(now = new Date()): Promise<{ monthCents: number; spentThisMonthCents: number }> {
  const { rows } = await withControlPlane((tx) => tx.query<{ assistant_month_cents: number }>(
    'SELECT assistant_month_cents FROM platform_control'));
  const { start, end } = periodBounds(now);
  const spent = await assistantCost({ from: start, to: end });
  return { monthCents: Number(rows[0]?.assistant_month_cents ?? 0), spentThisMonthCents: spent.costCents };
}

/**
 * Sets what PALUGADA's own conversation may spend each month; zero
 * switches it off. The value is checked before `allowed` is asked, with what
 * the allowance was, so the caller can tell a raise, which loosens a control,
 * from a cut, and a mistyped value costs no second factor.
 */
export async function setAssistantAllowance(
  monthCents: unknown, allowed: (before: number, after: number) => Promise<void>,
): Promise<void> {
  if (typeof monthCents !== 'number' || !Number.isInteger(monthCents) || monthCents < 0 || monthCents > ALLOWANCE_MAX_CENTS) {
    throw new PalugadaError('contract.violation',
      `monthCents is what PALUGADA's own conversation may spend in a month, in whole US cents from 0 to ${ALLOWANCE_MAX_CENTS}; 0 switches it off`,
      { field: 'monthCents' });
  }
  await allowed((await assistantAllowance()).monthCents, monthCents);
  await withControlPlane((tx) => tx.query('UPDATE platform_control SET assistant_month_cents = $1, updated_at = now()', [monthCents]));
}

/**
 * Whether PALUGADA's own conversation may take this turn: what the month
 * has spent, what this answer has spent so far (kept with the answer only
 * once it is written), and the turn's estimate, within the allowance.
 *
 * The estimate is priced at the fallback rate, the top of the market
 * (`pricing.ts`): the conversation is not handed the deployment's price list,
 * and an estimate too high stops it a turn early, where one too low lets it
 * spend what nobody allowed.
 */
export async function allowanceAdmits(request: LlmTurnRequest, answerCents: number): Promise<boolean> {
  const { monthCents, spentThisMonthCents } = await assistantAllowance();
  const estimate = Math.ceil(costOf(DEFAULT_PRICE_TABLE, request.model, turnUse(request)).cents);
  return spentThisMonthCents + answerCents + estimate <= monthCents;
}
