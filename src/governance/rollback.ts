/**
 * One-click rollback (PRD v2 F3.9): a recorded version made live again.
 *
 * `recordVersion` kept every change to a charter, a policy and a role, and
 * `restore` returned a snapshot for "the caller for that kind" to put back --
 * and there was no such caller, nor a route to reach one. So the versions
 * were a history nobody could act on, and "rollback satu klik ke versi mana
 * pun" was half built.
 *
 * Each kind goes back through the write path a change to it takes, rather
 * than through a generic writer: that path knows the table, keeps its checks
 * -- a policy still may not loosen a broader one (F3.5), a role change is
 * still an approved one (F17.3) -- and records its own version, so going back
 * to v3 is a v9 whose content is v3's and both stay visible.
 *
 * What a snapshot holds differs by kind, and this is where that is known: a
 * charter's and a policy's version is the state a change produced; a role's
 * is the state before the change, which is what "undo that change" needs.
 * A grant is not restored in one step here: its versions record a single
 * capability's before and after, and putting one back is a structural change
 * the owner makes directly.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { Condition } from '../policy/condition.ts';
import { history, type ConfigKind } from './config-versions.ts';
import { publishCharter, putPolicy } from './store.ts';
import type { PolicyEffect } from '../policy/engine.ts';
import { applyRoleChange } from './structure.ts';

/** The kinds a version of which can be made live again in one step. */
export const ROLLBACK_KINDS: readonly ConfigKind[] = ['charter', 'policy', 'role'];

export async function rollBack(
  companyId: string,
  kind: ConfigKind,
  subjectId: string | null,
  version: number,
): Promise<{ restoredFrom: number }> {
  if (!ROLLBACK_KINDS.includes(kind)) {
    throw new PalugadaError(
      'contract.violation',
      `a ${kind} is put back by changing it again; there is no one-step restore for it`,
      { kind },
    );
  }
  const target = (await history(companyId, kind, subjectId)).find((one) => one.version === version);
  if (!target) {
    throw new PalugadaError(
      'config.unknown_version',
      `there is no version ${version} of this ${kind} in this company`,
      { kind, subjectId, version },
    );
  }
  const snapshot = target.snapshot;
  const summary = `Restored version ${version}: ${target.summary}`;

  if (kind === 'charter') {
    await publishCharter({ companyId, body: String(snapshot.body ?? '') });
  } else if (kind === 'policy') {
    // The scope is the row's, which the snapshot does not repeat.
    const { rows } = await withControlPlane((tx) => tx.query<{ division_id: string | null }>(
      'SELECT division_id FROM policies WHERE id = $1 AND company_id = $2', [subjectId, companyId]));
    if (!rows[0]) {
      throw new PalugadaError('config.unknown_version', 'that policy is no longer in this company', { subjectId });
    }
    await putPolicy({
      companyId,
      ...(rows[0].division_id ? { divisionId: rows[0].division_id } : {}),
      slug: String(snapshot.slug),
      effect: snapshot.effect as PolicyEffect,
      condition: snapshot.condition as Condition,
      mode: snapshot.mode === 'log_only' ? 'log_only' : 'enforce',
      params: (snapshot.params ?? {}) as Record<string, unknown>,
    });
  } else {
    await applyRoleChange(companyId, subjectId!, {
      systemPrompt: String(snapshot.systemPrompt),
      tools: snapshot.tools as string[],
      modelPrimary: String(snapshot.modelPrimary),
      modelFallback: snapshot.modelFallback as string[],
    }, { ownerApproved: true, summary });
  }

  await withControlPlane((tx) => appendEvent(tx, {
    companyId,
    type: 'config.restored',
    actor: 'owner',
    payload: { kind, subjectId, restoredFrom: version },
  }));
  return { restoredFrom: version };
}
