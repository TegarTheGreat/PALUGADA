/**
 * Closing a company, and erasing it (0088; UU 27/2022 on personal data).
 *
 * The owner closes a company with their device and names how long it has:
 * 7 to 90 days. It is frozen at once -- nothing of it starts, and what is
 * running stops at its next step -- and until the day it can be kept. On the
 * day, the worker erases it: every row of it in one transaction, the
 * append-only history included, and the keys its divisions held, which live
 * in the deployment's sealed store rather than under the company. What is
 * left is one line in `company_erasures`: its name, when it was closed and
 * erased, and how many rows of what went.
 *
 * What this cannot reach, and the guide says so: the backups taken before
 * the day, until they age out; what the model providers and vendors were
 * sent; and the owner's own chat history on Telegram or WhatsApp.
 */
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { CREDENTIAL_SECRETS } from '../secrets/manager.ts';

/** How long a closing company waits, in days: at least a week to notice a mistake, at most a quarter. */
export const CLOSING_GRACE_DAYS = { least: 7, most: 90 } as const;

/** What an erasure counts, for the line it leaves: the tables an owner would recognise. */
const COUNTED = [
  'tasks', 'events', 'agent_runs', 'llm_traces', 'memories', 'documents', 'inbox_items', 'credentials',
] as const;

/** Refuses a grace outside the bounds, before anything is written or a code spent. */
export function assertClosingDays(days: number): void {
  if (!Number.isInteger(days) || days < CLOSING_GRACE_DAYS.least || days > CLOSING_GRACE_DAYS.most) {
    throw new PalugadaError('contract.violation',
      `a company is erased ${CLOSING_GRACE_DAYS.least} to ${CLOSING_GRACE_DAYS.most} days after it is closed, in whole days`,
      { field: 'days' });
  }
}

export async function closeCompany(companyId: string, days: number): Promise<{ eraseAfter: Date }> {
  assertClosingDays(days);
  const eraseAfter = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ closing_at: Date | null }>(
      'SELECT closing_at FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    if (!rows[0]) throw new PalugadaError('contract.violation', `no company ${companyId}`, { companyId });
    if (rows[0].closing_at) {
      throw new PalugadaError('contract.violation', 'this company is already closing; keep it first to choose another day', { companyId });
    }
    // Frozen in the same statement: a company that is closing and still
    // starting work would be doing things the owner has decided to end.
    const { rows: closed } = await tx.query<{ erase_after: Date }>(
      `UPDATE companies
          SET frozen_at = coalesce(frozen_at, now()), closing_at = now(),
              erase_after = now() + make_interval(days => $2)
        WHERE id = $1
        RETURNING erase_after`,
      [companyId, days]);
    return closed[0]!.erase_after;
  });
  await withTenant(companyId, (tx) => appendEvent(tx, {
    companyId, type: 'company.closing', actor: 'owner', payload: { days, eraseAfter: eraseAfter.toISOString() },
  }));
  return { eraseAfter };
}

/** Takes a closing back. The company stays frozen: starting it again is the owner's other decision. */
export async function keepCompany(companyId: string): Promise<void> {
  const kept = await withControlPlane((tx) => tx.query(
    'UPDATE companies SET closing_at = NULL, erase_after = NULL WHERE id = $1 AND closing_at IS NOT NULL',
    [companyId]));
  if (kept.rowCount === 0) {
    throw new PalugadaError('contract.violation', 'this company is not closing', { companyId });
  }
  await withTenant(companyId, (tx) => appendEvent(tx, { companyId, type: 'company.kept', actor: 'owner', payload: {} }));
}

/** Whether a company is closing, for a control that would start it again. */
export async function closingOf(companyId: string): Promise<Date | null> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ erase_after: Date | null }>('SELECT erase_after FROM companies WHERE id = $1', [companyId]);
    return rows[0]?.erase_after ?? null;
  });
}

export interface Erasure {
  companyId: string;
  slug: string;
  name: string;
  closedAt: Date;
  erasedAt: Date;
  counts: Record<string, number>;
}

/** Erases every company whose day has come. Answers what it erased. */
export async function eraseDueCompanies(): Promise<Erasure[]> {
  const due = await withControlPlane((tx) => tx.query<{ id: string }>(
    'SELECT id FROM companies WHERE erase_after <= now() ORDER BY erase_after'));
  const erased: Erasure[] = [];
  for (const { id } of due.rows) {
    const one = await eraseCompany(id);
    if (one) erased.push(one);
  }
  return erased;
}

async function eraseCompany(companyId: string): Promise<Erasure | null> {
  return withControlPlane(async (tx) => {
    // Locked, and checked again under the lock: two workers that both saw it
    // due erase it once, and a closing kept a moment ago is not erased.
    const { rows } = await tx.query<{ slug: string; name: string; closing_at: Date }>(
      'SELECT slug, name, closing_at FROM companies WHERE id = $1 AND erase_after <= now() FOR UPDATE',
      [companyId]);
    const company = rows[0];
    if (!company) return null;

    const counts: Record<string, number> = {};
    for (const table of COUNTED) {
      const { rows: counted } = await tx.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId]);
      counts[table] = counted[0]!.n;
    }
    // The keys its divisions held are sealed in the deployment's store, under
    // names only a division's credential uses; the company's rows name them.
    const { rows: held } = await tx.query<{ secret_ref: string }>(
      'SELECT secret_ref FROM credentials WHERE company_id = $1', [companyId]);
    const sealed = held.map((row) => row.secret_ref)
      .filter((reference) => reference.startsWith(`db://${CREDENTIAL_SECRETS}`))
      .map((reference) => reference.slice('db://'.length));

    const { rows: line } = await tx.query<{ erased_at: Date }>(
      `INSERT INTO company_erasures (company_id, slug, name, closed_at, counts)
       VALUES ($1, $2, $3, $4, $5) RETURNING erased_at`,
      [companyId, company.slug, company.name, company.closing_at, JSON.stringify(counts)]);
    await tx.query("SELECT set_config('app.erase_company', $1, true)", [companyId]);
    // Not a key of the company's, so not reached by the cascade: a sign-in
    // for a vendor that was under way.
    await tx.query('DELETE FROM credential_authorizations WHERE company_id = $1', [companyId]);
    await tx.query('DELETE FROM companies WHERE id = $1', [companyId]);
    if (sealed.length > 0) await tx.query('DELETE FROM deployment_secrets WHERE name = ANY($1::text[])', [sealed]);
    return {
      companyId, slug: company.slug, name: company.name, closedAt: company.closing_at, erasedAt: line[0]!.erased_at, counts,
    };
  });
}

/** Every company erased here, newest first. */
export async function erasures(): Promise<Erasure[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      company_id: string; slug: string; name: string; closed_at: Date; erased_at: Date; counts: Record<string, number>;
    }>('SELECT company_id, slug, name, closed_at, erased_at, counts FROM company_erasures ORDER BY erased_at DESC');
    return rows.map((row) => ({
      companyId: row.company_id, slug: row.slug, name: row.name, closedAt: row.closed_at, erasedAt: row.erased_at, counts: row.counts,
    }));
  });
}
