/**
 * Automatic role freeze on repeated denials (PRD F3.7).
 *
 * F3.7 asks for every denied attempt to be counted per role, and for a role
 * past the daily threshold to be frozen automatically.
 *
 * The unit is the role, and that is the design rather than an implementation
 * detail. A task that keeps being denied is one task going wrong. A role that
 * keeps being denied is a prompt or a grant that is wrong, and it will be just
 * as wrong for the next task that runs it -- so stopping the role stops the
 * repetition, while stopping the company would stop six divisions that are
 * working. It is the smallest cut that actually holds.
 *
 * Every denial counts, not only the ones a policy produced. A role hammering a
 * capability it was never granted is exactly as much a misconfiguration as one
 * tripping a policy, and F3.7's own wording is "attempted actions that were
 * denied" rather than "policy matches".
 *
 * A freeze is never automatic in the other direction. Thawing is the owner's,
 * because the condition that caused it -- a prompt, a missing grant, a policy
 * the role does not understand -- does not fix itself by waiting, and a role
 * that unfroze on a timer would simply spend tomorrow's allowance the same way.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant, type TenantClient } from '../db/tenant.ts';
import { thresholdsFor } from '../reporting/alerts.ts';
import * as inbox from '../inbox/inbox.ts';

export interface DenialContext {
  companyId: string;
  projectId: string;
  taskId: string;
  roleId: string;
}

export interface FreezeOutcome {
  denialsToday: number;
  threshold: number;
  frozen: boolean;
}

/** Whether this role is currently stopped. Read inside the caller's scope. */
export async function isRoleFrozen(tx: TenantClient, roleId: string): Promise<boolean> {
  const { rows } = await tx.query<{ frozen: boolean }>(
    'SELECT frozen_at IS NOT NULL AS frozen FROM roles WHERE id = $1',
    [roleId],
  );
  return rows[0]?.frozen ?? false;
}

export async function frozenRoles(
  companyId: string,
): Promise<Array<{ roleId: string; slug: string; frozenAt: Date; reason: string | null }>> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      slug: string;
      frozen_at: Date;
      frozen_reason: string | null;
    }>(
      'SELECT id, slug, frozen_at, frozen_reason FROM roles WHERE frozen_at IS NOT NULL ORDER BY frozen_at',
    );
    return rows.map((row) => ({
      roleId: row.id,
      slug: row.slug,
      frozenAt: row.frozen_at,
      reason: row.frozen_reason,
    }));
  });
}

/**
 * Lifts a freeze.
 *
 * Through the control plane, like every other owner control: thawing a role is
 * a decision about the company rather than work inside it, and an agent that
 * could unfreeze its own role would make the freeze a suggestion.
 */
export async function unfreezeRole(companyId: string, roleId: string): Promise<void> {
  await withControlPlane(async (tx) => {
    await tx.query(
      'UPDATE roles SET frozen_at = NULL, frozen_reason = NULL WHERE id = $1 AND company_id = $2',
      [roleId, companyId],
    );
    await appendEvent(tx, {
      companyId,
      type: 'role.unfrozen',
      actor: 'owner',
      payload: { roleId },
    });
  });
}

/**
 * Counts today's denials for a role and freezes it past the threshold.
 *
 * Called after the denial has been recorded, so the count includes it: a
 * threshold of ten should freeze on the tenth denial, not on the eleventh.
 *
 * The day boundary is `date_trunc('day', now())`, matching how F11.4's alert
 * counts denials. Two "per day" figures that disagreed about when a day starts
 * would be worse than either alone.
 */
export async function evaluateRoleFreeze(ctx: DenialContext): Promise<FreezeOutcome> {
  // Read through the same accessor the F11.4 alert uses, so the two figures
  // cannot drift apart or disagree about which company row wins.
  const { roleFreezeDenialsPerDay: threshold } = await thresholdsFor(ctx.companyId);

  const outcome = await withTenant(ctx.companyId, async (tx): Promise<FreezeOutcome & {
    alreadyFrozen: boolean;
    slug: string;
    capabilities: string[];
  }> => {
    const { rows } = await tx.query<{
      denials: string;
      slug: string;
      frozen: boolean;
      capabilities: string[];
    }>(
      // The role arrives twice, as text and as a uuid. `payload->>'roleId'` is
      // text and `roles.id` is a uuid, and letting one parameter serve both
      // makes PostgreSQL infer a type from whichever comparison it reads
      // first -- which fails on the other one. Passing it twice also keeps the
      // text comparison matching the expression index on that key.
      `SELECT (SELECT count(*) FROM events
                WHERE type = 'policy.denied'
                  AND payload->>'roleId' = $1
                  AND occurred_at >= date_trunc('day', now()))::text AS denials,
              r.slug,
              r.frozen_at IS NOT NULL AS frozen,
              (SELECT coalesce(array_agg(DISTINCT e.payload->>'capability'), '{}')
                 FROM events e
                WHERE e.type = 'policy.denied'
                  AND e.payload->>'roleId' = $1
                  AND e.occurred_at >= date_trunc('day', now())
                  AND e.payload->>'capability' IS NOT NULL) AS capabilities
         FROM roles r WHERE r.id = $2`,
      [ctx.roleId, ctx.roleId],
    );

    const row = rows[0];
    const denialsToday = Number(row?.denials ?? 0);

    return {
      denialsToday,
      threshold,
      frozen: denialsToday >= threshold,
      alreadyFrozen: row?.frozen ?? false,
      slug: row?.slug ?? '',
      capabilities: row?.capabilities ?? [],
    };
  });

  if (!outcome.frozen || outcome.alreadyFrozen) {
    return { denialsToday: outcome.denialsToday, threshold: outcome.threshold, frozen: outcome.frozen };
  }

  const reason =
    `${outcome.denialsToday} denied attempts today, at or above the limit of ` +
    `${outcome.threshold}` +
    (outcome.capabilities.length > 0 ? `; refused: ${outcome.capabilities.join(', ')}` : '');

  // The write goes through the control plane. A role freezing itself with the
  // application role would mean the same credentials that reach a capability
  // can also lift the freeze, and a stop an agent can undo is not a stop.
  await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE roles SET frozen_at = now(), frozen_reason = $2
        WHERE id = $1 AND frozen_at IS NULL`,
      [ctx.roleId, reason],
    );
    await appendEvent(tx, {
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      taskId: ctx.taskId,
      type: 'role.frozen',
      actor: 'system',
      payload: {
        roleId: ctx.roleId,
        role: outcome.slug,
        denialsToday: outcome.denialsToday,
        threshold: outcome.threshold,
        capabilities: outcome.capabilities,
      },
    });
  });

  // An incident rather than an escalation: something is already wrong and no
  // more work of this kind will happen until somebody looks, so it does not
  // wait for the owner's window (F9.3).
  await inbox.raiseIncident({
    companyId: ctx.companyId,
    taskId: ctx.taskId,
    title: `Role ${outcome.slug} is frozen after repeated denials`,
    detail:
      `${reason}. No task will run as this role until you lift the freeze. ` +
      'The usual causes are a missing capability grant, a policy the role\'s ' +
      'prompt does not account for, or a prompt asking for work the role was ' +
      'never equipped to do.',
  });

  return { denialsToday: outcome.denialsToday, threshold: outcome.threshold, frozen: true };
}
