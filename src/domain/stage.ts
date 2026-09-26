/**
 * Where a company is in its life, and what that allows (0057).
 *
 * auto-company runs every idea through the same gates: explore, validate --
 * a GO or NO-GO on evidence -- build, launch, grow, and wind down when it is
 * not working. PALUGADA had nothing to say which of those a company was in,
 * so nothing could hold a company that had proved nothing back from buying
 * ads, and nothing told a run that the job this month is to find out whether
 * anyone will pay rather than to ship features.
 *
 * The stage is the owner's. The application role cannot write `companies`
 * (0047), so no run changes it; a run may propose a move with `stage.propose`,
 * which is an escalation the owner answers, and moving to a later stage --
 * which loosens whatever policies read the stage -- takes their device, as
 * every loosening does.
 *
 * It does two things and no more. Policies read it as the `stage` fact, so a
 * rule such as "no paid reach before launch" is data rather than code. And a
 * run is told it, right after the language, with what the stage is for.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';

export const STAGES = ['explore', 'validate', 'build', 'launch', 'grow', 'wind_down'] as const;
export type Stage = (typeof STAGES)[number];

/** What each stage is for, as a run is told it. */
export const STAGE_PURPOSE: Record<Stage, string> = {
  explore:
    'Find a problem worth solving. Talk to the people who have it and write down what it costs them. ' +
    'Spend on learning, not on building or reach.',
  validate:
    'Find out whether people will pay before anything is built: money or a signed commitment, not ' +
    'interest. The stage ends with a GO or NO-GO the owner decides on the evidence.',
  build:
    'Build the smallest version that the validated customers asked for, and ship it to them. ' +
    'Reach beyond them waits for launch.',
  launch:
    'Put it in front of customers: payment, sign-up, support and a way back if a release goes wrong ' +
    'must all work before anything is announced.',
  grow:
    'Grow what is working, measured by the numbers the goals name. Stop what is not.',
  wind_down:
    'The company is closing. Finish what is owed to customers, stop everything else, and start ' +
    'nothing new.',
};

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

export function assertStage(value: unknown): Stage {
  if (!isStage(value)) {
    throw new PalugadaError('contract.violation', `a stage is one of ${STAGES.join(', ')}`, { stage: value });
  }
  return value;
}

/**
 * Whether moving from one stage to another loosens.
 *
 * Forward loosens, except into winding down, which only closes things; and a
 * company with no stage yet has had nothing a stage policy allows, so giving
 * it one is forward.
 */
export function loosens(from: Stage | null, to: Stage): boolean {
  if (to === 'wind_down') return false;
  if (from === null || from === 'wind_down') return true;
  return STAGES.indexOf(to) > STAGES.indexOf(from);
}

export async function stageOf(tx: TenantClient, companyId: string): Promise<Stage | null> {
  const { rows } = await tx.query<{ stage: Stage | null }>('SELECT stage FROM companies WHERE id = $1', [companyId]);
  return rows[0]?.stage ?? null;
}

/**
 * Moves the company to a stage, inside a transaction on the control plane.
 *
 * The caller has already decided the owner wanted it -- the route with their
 * device when it loosens, or the decision on a proposal.
 */
export async function setStageWithin(
  tx: TenantClient,
  companyId: string,
  to: Stage,
  why: { note?: string; inboxItemId?: string } = {},
): Promise<{ from: Stage | null; to: Stage }> {
  const { rows } = await tx.query<{ stage: Stage | null }>(
    'SELECT stage FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
  if (!rows[0]) throw new PalugadaError('contract.violation', 'no such company', { companyId });
  const from = rows[0].stage;
  if (from === to) return { from, to };
  await tx.query('UPDATE companies SET stage = $2 WHERE id = $1', [companyId, to]);
  // A proposal to move from where the company no longer is cannot be
  // approved any more; it is closed now rather than left for the owner to
  // press and be refused.
  await tx.query(
    `UPDATE inbox_items SET status = 'withdrawn', closed_reason = 'stage_changed'
      WHERE company_id = $1 AND status = 'open' AND kind = 'escalation' AND payload ? 'stageChange'
        AND id IS DISTINCT FROM $2::uuid`,
    [companyId, why.inboxItemId ?? null],
  );
  await appendEvent(tx, {
    companyId,
    type: 'company.stage_changed',
    actor: 'owner',
    payload: { from, to, ...(why.note ? { note: why.note } : {}), ...(why.inboxItemId ? { inboxItemId: why.inboxItemId } : {}) },
  });
  return { from, to };
}

export async function setStage(companyId: string, to: Stage, note?: string): Promise<{ from: Stage | null; to: Stage }> {
  return withControlPlane((tx) => setStageWithin(tx, companyId, to, note ? { note } : {}));
}
