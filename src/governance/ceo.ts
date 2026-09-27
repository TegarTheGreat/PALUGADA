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
 * has no title until the owner gives it one.
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
    return { roleId, previous: previous?.id ?? null };
  });
}
