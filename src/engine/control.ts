/**
 * Emergency controls (PRD F5.8, F10.7, F1.4).
 *
 * Three switches with different blast radii: stop every task on the platform,
 * freeze one company, or kill one capability everywhere. They are read before
 * a step commits rather than only at task start, because a control that only
 * takes effect on the next task is not a stop button.
 */
import { withTenant, withControlPlane } from '../db/tenant.ts';

export async function requestStopAll(): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      'UPDATE platform_control SET stop_all_requested_at = now(), updated_at = now()',
    );
  });
}

export async function clearStopAll(): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      'UPDATE platform_control SET stop_all_requested_at = NULL, updated_at = now()',
    );
  });
}

export async function isStopAllRequested(): Promise<boolean> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ stopped: boolean }>(
      'SELECT stop_all_requested_at IS NOT NULL AS stopped FROM platform_control',
    );
    return rows[0]?.stopped ?? false;
  });
}

export async function freezeCompany(companyId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE companies SET frozen_at = now() WHERE id = $1', [companyId]);
  });
}

export async function unfreezeCompany(companyId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE companies SET frozen_at = NULL WHERE id = $1', [companyId]);
  });
}

export async function isCompanyFrozen(companyId: string): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ frozen: boolean }>(
      'SELECT frozen_at IS NOT NULL AS frozen FROM companies WHERE id = $1',
      [companyId],
    );
    return rows[0]?.frozen ?? false;
  });
}

/** F8.8: disables one capability across every company at once. */
export async function killCapability(name: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      'UPDATE capabilities SET disabled_at = now() WHERE name = $1 AND disabled_at IS NULL',
      [name],
    );
  });
}

export async function reviveCapability(name: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query('UPDATE capabilities SET disabled_at = NULL WHERE name = $1', [name]);
  });
}
