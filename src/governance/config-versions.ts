/**
 * Versioned configuration and one-click rollback (PRD v2 F3.9).
 *
 * Every configuration change is a version, and any version can be restored.
 * The requirement is one sentence and the design follows from it: rollback is
 * a *single* operation, and an operation that has to know six table shapes is
 * six operations sharing a name.
 *
 * So a version is a whole snapshot rather than a diff. Restoring from diffs
 * means replaying a chain, and a chain with one bad link cannot be replayed at
 * all -- which is precisely the situation somebody is in when they reach for
 * rollback. The cost is storage, which is the cheapest thing in the system.
 *
 * What this module does *not* do is apply the snapshot. Each kind knows how to
 * write itself back, and a generic writer that guessed at columns would fail
 * silently the day a table gained one. `restore` returns the snapshot and
 * records the intent; the caller for that kind puts it back.
 */
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';

export type ConfigKind = 'charter' | 'policy' | 'role' | 'grant' | 'bundle' | 'skill';

export interface ConfigVersion {
  id: string;
  kind: ConfigKind;
  subjectId: string | null;
  version: number;
  snapshot: Record<string, unknown>;
  summary: string;
  changedBy: string;
  createdAt: Date;
}

/**
 * Records a new version.
 *
 * Takes a transaction rather than opening one, so that the version and the
 * change it describes commit together. A version written in a separate
 * transaction is a version that can exist for a change that was rolled back --
 * and a history containing changes that never happened is worse than no
 * history, because it is believed.
 */
export async function recordVersion(
  tx: Pick<TenantClient, 'query'>,
  input: {
    /** Null for platform-scoped configuration, which outranks every company. */
    companyId?: string | null;
    kind: ConfigKind;
    subjectId?: string | null;
    snapshot: Record<string, unknown>;
    summary: string;
    changedBy?: string;
  },
): Promise<number> {
  const { rows } = await tx.query<{ version: number }>(
    `INSERT INTO config_versions
       (company_id, kind, subject_id, version, snapshot, summary, changed_by)
     SELECT $1, $2, $3,
            coalesce(max(version), 0) + 1,
            $4, $5, $6
       FROM config_versions
      WHERE company_id IS NOT DISTINCT FROM $1 AND kind = $2
        AND subject_id IS NOT DISTINCT FROM $3
     RETURNING version`,
    [
      input.companyId ?? null,
      input.kind,
      input.subjectId ?? null,
      JSON.stringify(input.snapshot),
      input.summary,
      input.changedBy ?? 'owner',
    ],
  );
  return rows[0]!.version;
}

export async function history(
  companyId: string | null,
  kind: ConfigKind,
  subjectId: string | null,
): Promise<ConfigVersion[]> {
  // Platform-scoped history is read through the control plane: the tenant
  // scope has no company to be in, and the rows belong to nobody's tenant.
  const read = async (tx: Pick<TenantClient, 'query'>) => {
    const { rows } = await tx.query<{
      id: string;
      kind: ConfigKind;
      subject_id: string | null;
      version: number;
      snapshot: Record<string, unknown>;
      summary: string;
      changed_by: string;
      created_at: Date;
    }>(
      `SELECT id, kind, subject_id, version, snapshot, summary, changed_by, created_at
         FROM config_versions
        WHERE company_id IS NOT DISTINCT FROM $1 AND kind = $2
          AND subject_id IS NOT DISTINCT FROM $3
        ORDER BY version DESC`,
      [companyId, kind, subjectId],
    );
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      subjectId: row.subject_id,
      version: row.version,
      snapshot: row.snapshot,
      summary: row.summary,
      changedBy: row.changed_by,
      createdAt: row.created_at,
    }));
  };

  return companyId === null ? withControlPlane(read) : withTenant(companyId, read);
}

/**
 * Fetches a version to restore, and records that somebody is restoring it.
 *
 * The restore itself becomes a *new* version rather than rewinding the
 * numbering. History that can be rewound is history that can be edited, and an
 * audit trail somebody can edit is a document rather than a record. So going
 * back to v3 produces a v9 whose snapshot is v3's, and both facts stay
 * visible.
 */
export async function restore(
  companyId: string | null,
  kind: ConfigKind,
  subjectId: string | null,
  version: number,
  options: { changedBy?: string } = {},
): Promise<{ snapshot: Record<string, unknown>; newVersion: number }> {
  // Always the control plane, even for a company's own configuration: a
  // version is a record of what an owner decided, and the application role has
  // no write grant on the table -- deliberately, since an agent that could
  // write one could manufacture a version to roll back to.
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{ snapshot: Record<string, unknown>; summary: string }>(
      `SELECT snapshot, summary FROM config_versions
        WHERE company_id IS NOT DISTINCT FROM $1 AND kind = $2
          AND subject_id IS NOT DISTINCT FROM $3
          AND version = $4`,
      [companyId, kind, subjectId, version],
    );
    const found = rows[0];
    if (!found) {
      throw new PalugadaError(
        'config.unknown_version',
        `there is no version ${version} of ${kind}${subjectId ? ` ${subjectId}` : ''}`,
        { kind, subjectId, version },
      );
    }

    const newVersion = await recordVersion(tx, {
      companyId,
      kind,
      subjectId,
      snapshot: found.snapshot,
      summary: `Restored version ${version}: ${found.summary}`,
      ...(options.changedBy === undefined ? {} : { changedBy: options.changedBy }),
    });

    // The event log is tenant-scoped, so a platform restore has no company to
    // record it against. It is recorded in the version's own summary instead,
    // which is where somebody looking at platform history would look.
    if (companyId !== null) {
      await appendEvent(tx, {
        companyId,
        type: 'config.restored',
        actor: 'owner',
        payload: { kind, subjectId, restoredFrom: version, newVersion },
      });
    }

    return { snapshot: found.snapshot, newVersion };
  });
}
