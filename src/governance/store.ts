/**
 * Charter and policy administration (PRD F3.1, F3.6).
 *
 * Every function here runs on the control plane, because F3.6 makes charter
 * and policy edits the owner's alone. Nothing in this module is reachable from
 * an agent run: agents read the charter through the context builder and are
 * subject to policy through the broker, but they cannot author either.
 *
 * Each change is written to `governance_log` with a before/after diff in the
 * same transaction as the change itself, so an edit cannot land without its
 * audit record. Company-scoped edits are mirrored into that company's event
 * stream as well, so they show up on its timeline rather than only in a
 * separate audit table.
 */
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { canonicalJson } from '../canonical-json.ts';
import { assertValidCondition, type Condition } from '../policy/condition.ts';
import type { PolicyEffect } from '../policy/engine.ts';

export interface CharterInput {
  /** Omit for the platform charter, which a company cannot override (F3.1). */
  companyId?: string | undefined;
  body: string;
}

export interface PolicyInput {
  slug: string;
  effect: PolicyEffect;
  condition: Condition;
  /** Omit both scopes for a platform policy. */
  companyId?: string | undefined;
  divisionId?: string | undefined;
  mode?: 'enforce' | 'log_only';
}

/** Field-level diff, so an audit entry says what changed rather than restating the row. */
function diff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  if (!before) return { before: {}, after };

  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    // Compared canonically: a jsonb round-trip reorders object keys, and a
    // plain stringify would report that as a change nobody made.
    if (canonicalJson(before[key]) !== canonicalJson(after[key])) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
    }
  }
  return { before: changedBefore, after: changedAfter };
}

async function record(
  tx: TenantClient,
  entry: {
    subject: 'charter' | 'policy';
    subjectId: string;
    companyId?: string | undefined;
    divisionId?: string | undefined;
    action: 'created' | 'updated' | 'deleted';
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  },
): Promise<void> {
  const changes = diff(entry.before, entry.after);

  await tx.query(
    `INSERT INTO governance_log
       (subject, subject_id, company_id, division_id, action, before, after, actor)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'owner')`,
    [
      entry.subject,
      entry.subjectId,
      entry.companyId ?? null,
      entry.divisionId ?? null,
      entry.action,
      JSON.stringify(changes.before),
      JSON.stringify(changes.after),
    ],
  );

  // A platform-scope edit belongs to no company, and events.company_id is
  // NOT NULL by design, so only company-scoped edits are mirrored.
  if (entry.companyId) {
    await tx.query(
      `INSERT INTO events (company_id, type, actor, payload)
       VALUES ($1, $2, 'owner', $3)`,
      [
        entry.companyId,
        `${entry.subject}.${entry.action}`,
        JSON.stringify({ subjectId: entry.subjectId, diff: changes }),
      ],
    );
  }
}

/**
 * Publishes a new charter version.
 *
 * Charters are append-only: a change is a new version, never an edit, so
 * "which charter was this agent run subject to" stays answerable after the
 * fact.
 */
export async function publishCharter(input: CharterInput): Promise<{ id: string; version: number }> {
  return withControlPlane(async (tx) => {
    const { rows: previousRows } = await tx.query<{ version: number; body: string }>(
      `SELECT version, body FROM charters
        WHERE company_id IS NOT DISTINCT FROM $1
        ORDER BY version DESC LIMIT 1`,
      [input.companyId ?? null],
    );
    const previous = previousRows[0];
    const version = (previous?.version ?? 0) + 1;

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO charters (company_id, version, body) VALUES ($1, $2, $3) RETURNING id`,
      [input.companyId ?? null, version, input.body],
    );
    const id = rows[0]!.id;

    await record(tx, {
      subject: 'charter',
      subjectId: id,
      companyId: input.companyId,
      action: previous ? 'updated' : 'created',
      before: previous ? { version: previous.version, body: previous.body } : null,
      after: { version, body: input.body },
    });

    return { id, version };
  });
}

/**
 * Creates or replaces a policy.
 *
 * The condition is validated here and the tighten-only rule is enforced by a
 * database trigger, so an attempt to loosen a broader-scope rule fails when it
 * is saved rather than the first time it matters (F3.5).
 */
export async function putPolicy(input: PolicyInput): Promise<string> {
  assertValidCondition(input.condition);

  if (input.divisionId && !input.companyId) {
    throw new Error('a division-scoped policy must also name its company');
  }

  return withControlPlane(async (tx) => {
    const { rows: existingRows } = await tx.query<{
      id: string;
      effect: PolicyEffect;
      condition: Condition;
      mode: string;
    }>(
      `SELECT id, effect, condition, mode FROM policies
        WHERE slug = $1
          AND company_id IS NOT DISTINCT FROM $2
          AND division_id IS NOT DISTINCT FROM $3`,
      [input.slug, input.companyId ?? null, input.divisionId ?? null],
    );
    const existing = existingRows[0];

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO policies (company_id, division_id, slug, effect, condition, mode)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (company_id, division_id, slug) DO UPDATE
         SET effect = EXCLUDED.effect,
             condition = EXCLUDED.condition,
             mode = EXCLUDED.mode
       RETURNING id`,
      [
        input.companyId ?? null,
        input.divisionId ?? null,
        input.slug,
        input.effect,
        JSON.stringify(input.condition),
        input.mode ?? 'enforce',
      ],
    );
    const id = rows[0]!.id;

    await record(tx, {
      subject: 'policy',
      subjectId: id,
      companyId: input.companyId,
      divisionId: input.divisionId,
      action: existing ? 'updated' : 'created',
      before: existing
        ? { effect: existing.effect, condition: existing.condition, mode: existing.mode }
        : null,
      after: { effect: input.effect, condition: input.condition, mode: input.mode ?? 'enforce' },
    });

    return id;
  });
}

export interface GovernanceEntry {
  subject: string;
  action: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  actor: string;
}

export async function readGovernanceLog(
  companyId?: string,
): Promise<GovernanceEntry[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<GovernanceEntry>(
      `SELECT subject, action, before, after, actor
         FROM governance_log
        WHERE company_id IS NOT DISTINCT FROM $1
        ORDER BY occurred_at, id`,
      [companyId ?? null],
    );
    return rows;
  });
}
