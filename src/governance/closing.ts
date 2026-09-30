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
 * Then what it kept outside its rows (0096): its directory in the files
 * root, and its charter's folder in the charter repository, whose removal is
 * committed there. After the rows, never before, and a failure to remove them
 * is said without bringing the rows back: the rows are most of what the
 * people in them have the right to have erased.
 *
 * Each company is erased on its own (0096). One whose erasure fails keeps
 * the failure on its row, is named on the worker's tick, and waits longer
 * each time before it is tried again; the companies after it are erased
 * regardless.
 *
 * What this cannot reach, and the guide says so: the backups taken before
 * the day, until they age out; the charter repository's history, which
 * still holds every charter the company had; what the model providers and
 * vendors were sent; and the owner's own chat history on Telegram or
 * WhatsApp.
 */
import { join } from 'node:path';
import { withControlPlane } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { CREDENTIAL_SECRETS } from '../secrets/manager.ts';
import { removeCompanyFiles } from '../capabilities/files.ts';
import type { CharterRepository } from './charter-repository.ts';

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
    const day = closed[0]!.erase_after;
    // Recorded in the same transaction: written after it, a process that
    // stopped between the two closed a company with nothing in its history
    // to say who closed it, or when.
    await appendEvent(tx, {
      companyId, type: 'company.closing', actor: 'owner', payload: { days, eraseAfter: day.toISOString() },
    });
    return day;
  });
  return { eraseAfter };
}

/** Takes a closing back. The company stays frozen: starting it again is the owner's other decision. */
export async function keepCompany(companyId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    // A failed erasure goes with the closing it belonged to (0096): kept,
    // the company is due nothing, and closed again it starts from nothing.
    const kept = await tx.query(
      `UPDATE companies
          SET closing_at = NULL, erase_after = NULL, erase_attempts = 0, erase_failure = NULL, erase_retry_at = NULL
        WHERE id = $1 AND closing_at IS NOT NULL`,
      [companyId]);
    if (kept.rowCount === 0) {
      throw new PalugadaError('contract.violation', 'this company is not closing', { companyId });
    }
    // With its record, as a closing is.
    await appendEvent(tx, { companyId, type: 'company.kept', actor: 'owner', payload: {} });
  });
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

/**
 * Where a deployment keeps what a company has outside its rows (0096). Both
 * optional: a deployment with no files root keeps no files, and a test of
 * rows wants rows alone.
 */
export interface ErasureDisk {
  /** `PALUGADA_FILES_ROOT`: each company's files are the directory under it named by its id. */
  filesRoot?: string | null | undefined;
  /** The charter repository, whose `companies/<slug>/` holds the company's charter. */
  charters?: Pick<CharterRepository, 'root' | 'forget'> | null | undefined;
}

/** A company whose erasure failed, why, and when it is tried again (0096). */
export interface ErasureFailure {
  companyId: string;
  name: string;
  reason: string;
  /** How many times it has failed since it was closed. */
  attempts: number;
  /** When it is tried again; null when not even the failure could be recorded. */
  retryAt: Date | null;
}

/** Something an erased company kept that is still on disk, where, and why. */
export interface LeftBehind {
  companyId: string;
  path: string;
  reason: string;
}

/** What one pass over the due companies did. */
export interface ErasurePass {
  erased: Erasure[];
  failed: ErasureFailure[];
  leftBehind: LeftBehind[];
}

/** Erases every company whose day has come, each on its own. Answers what it erased, what failed, and what stayed on disk. */
export async function eraseDueCompanies(disk: ErasureDisk = {}): Promise<ErasurePass> {
  const due = await withControlPlane((tx) => tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM companies
      WHERE erase_after <= now() AND (erase_retry_at IS NULL OR erase_retry_at <= now())
      ORDER BY erase_after`));
  const pass: ErasurePass = { erased: [], failed: [], leftBehind: [] };
  for (const { id, name } of due.rows) {
    // One company that cannot be erased -- a trigger refusing, a statement
    // timing out on a large one -- is that company's failure. Thrown out of
    // the loop, it was every later company's too, on every tick.
    let one: Erasure | null;
    try {
      one = await eraseCompany(id);
    } catch (error) {
      pass.failed.push(await recordFailure(id, name, error));
      continue;
    }
    if (!one) continue;
    pass.erased.push(one);
    pass.leftBehind.push(...await removeFromDisk(disk, [{ companyId: one.companyId, slug: one.slug }]));
  }
  return pass;
}

/**
 * What erasures left on disk, removed: the files and charter folder of every
 * company erased here. For a worker's first tick, which is where an erasure
 * from before files were removed, one whose process stopped between its rows
 * and its files, and a removal that failed are finished. A slug a company
 * here has taken since is that company's folder, and is left alone.
 */
export async function removeWhatErasuresLeft(disk: ErasureDisk): Promise<LeftBehind[]> {
  if (!disk.filesRoot && !disk.charters) return [];
  const erased = await withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ company_id: string; slug: string; taken: boolean }>(
      `SELECT e.company_id, e.slug, EXISTS (SELECT 1 FROM companies c WHERE c.slug = e.slug) AS taken
         FROM company_erasures e ORDER BY e.erased_at`);
    return rows;
  });
  return removeFromDisk(disk, erased.map((row) => ({ companyId: row.company_id, slug: row.taken ? null : row.slug })));
}

async function eraseCompany(companyId: string): Promise<Erasure | null> {
  return withControlPlane(async (tx) => {
    // Locked, and checked again under the lock: two workers that both saw it
    // due erase it once, a closing kept a moment ago is not erased, and one
    // that another worker has just failed to erase waits its turn.
    const { rows } = await tx.query<{ slug: string; name: string; closing_at: Date }>(
      `SELECT slug, name, closing_at FROM companies
        WHERE id = $1 AND erase_after <= now() AND (erase_retry_at IS NULL OR erase_retry_at <= now())
          FOR UPDATE`,
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

/**
 * Keeps a failed erasure on the company (0096) and says when it is tried
 * again: a minute after the first failure, doubling to at most six hours. A
 * lock or a deadlock has cleared within the minute; what has not needs a
 * person, and a try every few seconds until they come is a log nobody can
 * read for the same line.
 */
async function recordFailure(companyId: string, name: string, error: unknown): Promise<ErasureFailure> {
  const reason = said(error);
  try {
    return await withControlPlane(async (tx) => {
      const { rows } = await tx.query<{ erase_attempts: number; erase_retry_at: Date }>(
        `UPDATE companies
            SET erase_attempts = erase_attempts + 1, erase_failure = $2,
                erase_retry_at = now() + least(interval '1 minute' * power(2, least(erase_attempts, 16)), interval '6 hours')
          WHERE id = $1 AND erase_after IS NOT NULL
        RETURNING erase_attempts, erase_retry_at`,
        [companyId, reason]);
      // Kept, or erased by another worker, since: nothing is due to wait.
      return { companyId, name, reason, attempts: rows[0]?.erase_attempts ?? 0, retryAt: rows[0]?.erase_retry_at ?? null };
    });
  } catch (recording) {
    // The database went away, most likely: the failure is said on the tick
    // alone, and the company is tried again on the next.
    return { companyId, name, reason: `${reason}; the failure could not be recorded either: ${said(recording)}`, attempts: 0, retryAt: null };
  }
}

/**
 * Removes what erased companies kept outside their rows: each one's files,
 * and the charter folders of those given a slug. Answers what stayed, and
 * why. The rows are gone whatever this answers.
 */
async function removeFromDisk(disk: ErasureDisk, companies: Array<{ companyId: string; slug: string | null }>): Promise<LeftBehind[]> {
  const left: LeftBehind[] = [];
  if (disk.filesRoot) {
    for (const { companyId } of companies) {
      try {
        await removeCompanyFiles(disk.filesRoot, companyId);
      } catch (error) {
        left.push({ companyId, path: join(disk.filesRoot, companyId), reason: said(error) });
      }
    }
  }
  const charters = disk.charters;
  const bySlug = new Map(companies.flatMap((one) => (one.slug === null ? [] : [[one.slug, one.companyId] as const])));
  if (charters && bySlug.size > 0) {
    try {
      const forgotten = await charters.forget([...bySlug.keys()]);
      for (const one of forgotten.refused) {
        left.push({ companyId: bySlug.get(one.slug)!, path: join(charters.root, one.path), reason: one.reason });
      }
      // Removed from the folder and still in the repository's last commit is
      // not removed; the next worker to start commits it.
      if (forgotten.git.startsWith('failed') || forgotten.git.startsWith('held')) {
        for (const path of forgotten.removed) {
          left.push({
            companyId: bySlug.get(path.split('/')[1]!)!, path: join(charters.root, path),
            reason: `removed from the folder, and its removal is not committed: git ${forgotten.git}`,
          });
        }
      }
    } catch (error) {
      for (const [slug, companyId] of bySlug) {
        left.push({ companyId, path: join(charters.root, 'companies', slug), reason: said(error) });
      }
    }
  }
  return left;
}

/** What an error said, on one line and short enough to keep on a row. */
function said(error: unknown): string {
  return String((error as Error)?.message ?? error).replace(/\s+/g, ' ').trim().slice(0, 500);
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

/** Companies whose day has come and whose erasure has failed (0096), the longest overdue first. */
export async function failingErasures(): Promise<Array<{
  companyId: string; name: string; eraseAfter: Date; attempts: number; failure: string | null; retryAt: Date | null;
}>> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; name: string; erase_after: Date; erase_attempts: number; erase_failure: string | null; erase_retry_at: Date | null;
    }>(
      `SELECT id, name, erase_after, erase_attempts, erase_failure, erase_retry_at
         FROM companies WHERE erase_attempts > 0 ORDER BY erase_after`);
    return rows.map((row) => ({
      companyId: row.id, name: row.name, eraseAfter: row.erase_after, attempts: row.erase_attempts,
      failure: row.erase_failure, retryAt: row.erase_retry_at,
    }));
  });
}
