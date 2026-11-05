/**
 * The CEO: the one role in a company the owner talks to.
 *
 * A company is run by its roles and owned by one person, and between the two
 * there has to be someone. The owner's conversation on a company's pages is
 * with its CEO, work the owner gives without saying whose goes to it, and a
 * division's trouble reaches it before the owner. So every company that has
 * roles has exactly one CEO: the database refuses a second (the unique index
 * `roles_one_ceo`) and refuses a company with none (the trigger
 * `roles_company_has_a_ceo`, checked at commit), and this module is how the
 * title moves without either refusal firing.
 *
 * Being the CEO is an appointment, not a line of a role's charter. A role's
 * title can be changed like its name, except to or from CEO: that is
 * `appointCeo`, which moves it from one role to another in one transaction,
 * and a restored version of a role leaves who the CEO is alone.
 */
import type { TenantClient } from '../db/tenant.ts';
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { assertApproved } from '../eval/role-eval.ts';
import { recordVersion } from './config-versions.ts';
import { accountFor, release, reserve } from '../engine/budget.ts';

export const CEO = 'CEO';

export interface CeoRole {
  id: string;
  slug: string;
  displayName: string | null;
}

/** What the owner calls a role: its name, or its slug when it has none. */
export function calledBy(role: { slug: string; displayName: string | null }): string {
  return role.displayName ?? role.slug;
}

/** The company's CEO, or null in a company that has no roles yet. */
export async function ceoOf(tx: TenantClient, companyId: string): Promise<CeoRole | null> {
  const { rows } = await tx.query<{ id: string; slug: string; display_name: string | null }>(
    'SELECT id, slug, display_name FROM roles WHERE company_id = $1 AND title = $2', [companyId, CEO]);
  const row = rows[0];
  return row ? { id: row.id, slug: row.slug, displayName: row.display_name } : null;
}

/**
 * The title a role is being given, held to the rule: nobody becomes CEO by
 * being retitled while the company has one, and the CEO is not retitled out
 * of it. Returns the title to write.
 *
 * `current` is the role's title now, or null for a role being hired. A
 * company with no CEO -- one with no roles yet -- has its first hire made
 * CEO when no other title is asked for.
 */
export async function titleFor(
  tx: TenantClient,
  companyId: string,
  role: { id: string | null; current: string | null },
  wanted: string | null | undefined,
): Promise<string | null | undefined> {
  const ceo = await ceoOf(tx, companyId);
  if (!ceo) {
    if (wanted === undefined || wanted === null || wanted === CEO) return CEO;
    throw new PalugadaError('contract.violation',
      `this company has no CEO yet, and a company always has one: its first role is its CEO, so hire it with the title CEO or none`,
      { field: 'title' });
  }
  if (wanted === undefined) return undefined;
  if (role.current === CEO && wanted !== CEO) {
    throw new PalugadaError('contract.violation',
      `${calledBy(ceo)} is the CEO, and a company always has one: appoint another role CEO first, and then retitle ${calledBy(ceo)}`,
      { field: 'title' });
  }
  if (wanted === CEO && ceo.id !== role.id) {
    throw new PalugadaError('contract.violation',
      `this company's CEO is ${calledBy(ceo)}: to make this role the CEO instead, appoint it (Make CEO on the role)`,
      { field: 'title' });
  }
  return wanted;
}

/**
 * Appoints the company's first CEO when it has roles and none: the role work
 * is routed through when there is one, otherwise the oldest (roles made in
 * one transaction are as old as each other, and then the first by slug). A company made
 * from a template or a bundle that names none, or restored from an archive
 * made before there were titles, gets one here rather than being refused.
 */
export async function ensureCeo(tx: TenantClient, companyId: string): Promise<void> {
  await tx.query(
    `UPDATE roles SET title = $2
      WHERE id = (SELECT id FROM roles
                   WHERE company_id = $1
                     AND NOT EXISTS (SELECT 1 FROM roles ceo WHERE ceo.company_id = $1 AND ceo.title = $2)
                   ORDER BY (slug = 'coordinator') DESC, ('task.delegate' = ANY(tools)) DESC, created_at, slug
                   LIMIT 1)`,
    [companyId, CEO]);
}

/**
 * Makes a role the company's CEO, and the one that was CEO no longer so.
 *
 * Both roles' states before the change are kept as versions, like any change
 * to who a role is. The one that stood down keeps its name and persona and
 * has no title until the owner gives it one. The meeting and the planning it
 * had not started are the new CEO's (`handCeoWorkWithin`).
 */
export async function appointCeo(
  companyId: string,
  roleId: string,
  options: { ownerApproved: boolean; summary?: string },
): Promise<{ roleId: string; previous: string | null }> {
  // Who the owner talks to changes how the company works, as a charter does.
  assertApproved(options.ownerApproved, 'charter');
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; slug: string; system_prompt: string; tools: string[]; model_primary: string | null; model: string;
      model_fallback: string[]; runtime: string; display_name: string | null; title: string | null; persona: unknown;
    }>(
      `SELECT id, slug, system_prompt, tools, model_primary, model, model_fallback, runtime, display_name, title, persona
         FROM roles WHERE company_id = $1 AND (id = $2 OR title = $3) ORDER BY id FOR UPDATE`,
      [companyId, roleId, CEO]);
    const chosen = rows.find((row) => row.id === roleId);
    if (!chosen) throw new PalugadaError('role.incomplete', `no role ${roleId} in this company`, { roleId });
    const previous = rows.find((row) => row.title === CEO && row.id !== roleId) ?? null;
    if (chosen.title === CEO) return { roleId, previous: null };

    for (const row of previous ? [previous, chosen] : [chosen]) {
      await recordVersion(tx, {
        companyId,
        kind: 'role',
        subjectId: row.id,
        snapshot: {
          slug: row.slug,
          systemPrompt: row.system_prompt,
          tools: row.tools,
          modelPrimary: row.model_primary ?? row.model,
          modelFallback: row.model_fallback,
          runtime: row.runtime,
          displayName: row.display_name,
          title: row.title,
          persona: row.persona,
        },
        summary: options.summary ?? `State of ${row.slug} before ${chosen.display_name ?? chosen.slug} was appointed CEO`,
      });
    }
    // In this order: the index refuses two CEOs even for a moment.
    if (previous) await tx.query('UPDATE roles SET title = NULL WHERE id = $1', [previous.id]);
    await tx.query('UPDATE roles SET title = $2 WHERE id = $1', [roleId, CEO]);
    await appendEvent(tx, {
      companyId,
      type: 'role.appointed_ceo',
      actor: 'owner',
      payload: { roleId, slug: chosen.slug, previous: previous?.id ?? null },
    });
    if (previous) await handCeoWorkWithin(tx, companyId, previous.id, roleId);
    return { roleId, previous: previous?.id ?? null };
  });
}

/**
 * The CEO's own rhythm not yet started -- the weekly operating meeting and
 * the quarterly planning (src/engine/meeting.ts, quarter.ts) -- moved to the
 * role appointed, with its division and the account that funds it.
 *
 * Each is made once for its week or quarter, and its sweep makes no other
 * while one with the key exists: left with the role that stood down, the
 * planning ran as the integrator in a role that no longer is one, or, if the
 * owner then paused that role, waited for good, and the quarter was never
 * planned. Their briefs name no role, so they move as they are. Only what has
 * not taken a step: a run under way is that role's to finish.
 *
 * What a task holds moves to the new CEO's account, if that is another one
 * and has room. Otherwise it stays held where it was, and the task is charged
 * there: one meeting on the old account is a smaller wrong than a quarter
 * never planned.
 */
async function handCeoWorkWithin(tx: TenantClient, companyId: string, from: string, to: string): Promise<void> {
  const { rows: [seat] } = await tx.query<{ division_id: string }>(
    'SELECT division_id FROM roles WHERE company_id = $1 AND id = $2', [companyId, to]);
  const { rows: waiting } = await tx.query<{
    id: string; project_id: string; budget_account_id: string; tokens_reserved: string;
  }>(
    `SELECT t.id, t.project_id, t.budget_account_id, t.tokens_reserved::text AS tokens_reserved FROM tasks t
      WHERE t.company_id = $1 AND t.role_id = $2 AND t.parent_task_id IS NULL
        AND t.status IN ('pending', 'waiting_window')
        AND (t.idempotency_key LIKE 'meeting:%' OR t.idempotency_key LIKE 'quarter:%')
        AND NOT EXISTS (SELECT 1 FROM task_steps s WHERE s.company_id = t.company_id AND s.task_id = t.id)
      ORDER BY t.id
      FOR UPDATE OF t`,
    [companyId, from]);
  for (const task of waiting) {
    let account = task.budget_account_id;
    const reserved = Number(task.tokens_reserved);
    const theirs = await accountFor(tx, { companyId, roleId: to, divisionId: seat!.division_id, projectId: task.project_id });
    if (theirs && theirs !== account && await reserve(tx, theirs, reserved)) {
      await release(tx, account, reserved);
      account = theirs;
    }
    // One parked because the role that stood down was paused (role-freeze.ts)
    // is called back: the new CEO can take it now. Any other wait is still
    // what it waits for.
    await tx.query(
      `UPDATE tasks t SET role_id = $2, division_id = $3, budget_account_id = $4,
              wait_until = CASE
                WHEN t.status = 'waiting_window' AND t.wait_until > now()
                     AND (SELECT e.payload->>'reason' FROM events e
                           WHERE e.task_id = t.id AND e.type = 'task.waiting_window'
                           ORDER BY e.occurred_at DESC LIMIT 1) = 'role_paused'
                  THEN now()
                ELSE t.wait_until END
        WHERE t.id = $1`,
      [task.id, to, seat!.division_id, account]);
    await appendEvent(tx, {
      companyId, projectId: task.project_id, taskId: task.id, type: 'task.reassigned', actor: 'owner',
      payload: { from, to, why: 'ceo_appointed' },
    });
  }
}
