/**
 * Role eval sets (PRD v2 F17.2, F17.3, F17.4).
 *
 * A role's charter, its skills and its model routing are the three things that
 * change what it will do. F17.2 says a change to any of them runs the role's
 * eval set, and F17.3 says the owner sees the score before deciding. The point
 * is not a number: it is that "this rewrite is an improvement" stops being an
 * assertion and becomes a claim somebody can check.
 *
 * What an eval case is here, and what it is not. It is a snapshot of a real
 * run, kept deliberately, together with what a later run has to do to count as
 * matching it. It is *not* a re-execution: scoring a change by re-running five
 * trajectories against a live provider would cost real money and produce a
 * different answer each time, and F17.3 needs a number before the owner
 * decides rather than an hour afterwards. So the score is structural -- did the
 * capabilities the reference used survive the change, does the role still hold
 * the grants the reference depended on, does the negative case's failure mode
 * remain closed. That is a weaker check than replaying the work, and it is the
 * one that can run in the second before somebody clicks approve.
 *
 * The five-case floor (F17.2) is a floor, not a gate. A role with fewer is
 * reported as *unscored* rather than as passing: an empty eval set that
 * reported success would be the most dangerous number in the system.
 */
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { PalugadaError } from '../errors.ts';
import { exportTrajectory, type Trajectory } from './trajectory.ts';

/** F17.2's floor: fewer than this and a score means nothing. */
export const MINIMUM_EVAL_CASES = 5;

export type RoleChange = 'charter' | 'skills' | 'model_routing';
export type Polarity = 'positive' | 'negative';

export interface EvalCase {
  id: string;
  name: string;
  polarity: Polarity;
  accepted: boolean;
  /** Capabilities the reference run used, and which the change must not remove. */
  capabilities: string[];
  /** For a negative case: the halt reason or denial that must stay prevented. */
  failureMode: string | null;
}

export interface EvalResult {
  /** False when the role has fewer than the floor: unscored, not passing. */
  scored: boolean;
  passed: number;
  failed: number;
  cases: Array<{ name: string; polarity: Polarity; passed: boolean; detail: string }>;
}

/**
 * What a trajectory expects of a later run.
 *
 * Derived from the run rather than written by hand: a reference case somebody
 * has to describe in prose is a reference case nobody creates.
 */
export function expectationFrom(trajectory: Trajectory): {
  capabilities: string[];
  failureMode: string | null;
} {
  const capabilities = [
    ...new Set(
      trajectory.steps
        .filter((step) => step.kind === 'tool_call')
        .map((step) => String(step.detail.capability ?? ''))
        .filter(Boolean),
    ),
  ].sort();

  return {
    capabilities,
    failureMode:
      trajectory.haltReason
      ?? (trajectory.status === 'failed' ? 'attempts_exhausted' : null),
  };
}

/**
 * Keeps a run as a reference (F17.2).
 *
 * `accepted` defaults to false for a case the system proposed and true for one
 * the owner chose. A case nobody has agreed to should not start judging role
 * changes on its own.
 */
export async function captureEvalCase(input: {
  companyId: string;
  agentRunId: string;
  name: string;
  polarity?: Polarity;
  accepted?: boolean;
}): Promise<{ id: string; polarity: Polarity } | null> {
  const trajectory = await exportTrajectory(input.companyId, input.agentRunId);
  if (!trajectory) return null;

  const polarity: Polarity =
    input.polarity
    ?? (trajectory.status === 'succeeded' && trajectory.haltReason === null
      ? 'positive'
      : 'negative');

  return withTenant(input.companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO role_eval_cases
         (company_id, role_id, name, polarity, source_agent_run_id, task_input,
          trajectory, expectation, accepted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $9 THEN now() END)
       ON CONFLICT (role_id, name) DO UPDATE
         SET trajectory = EXCLUDED.trajectory,
             expectation = EXCLUDED.expectation,
             polarity = EXCLUDED.polarity
       RETURNING id`,
      [
        input.companyId,
        trajectory.roleId,
        input.name,
        polarity,
        input.agentRunId,
        JSON.stringify(trajectory.input),
        JSON.stringify(trajectory),
        JSON.stringify(expectationFrom(trajectory)),
        input.accepted ?? false,
      ],
    );
    return { id: rows[0]!.id, polarity };
  });
}

/**
 * F17.4: a run that halted, or whose proposal a reviewer rejected, becomes a
 * negative candidate.
 *
 * Automatic and unaccepted. The failures worth remembering are exactly the ones
 * nobody feels like writing down afterwards, so the system writes them down;
 * whether they become part of the judgement is still somebody's decision.
 */
export async function proposeNegativeCase(
  companyId: string,
  agentRunId: string,
  reason: string,
): Promise<string | null> {
  const captured = await captureEvalCase({
    companyId,
    agentRunId,
    name: `regression: ${reason} (${agentRunId.slice(0, 8)})`,
    polarity: 'negative',
    accepted: false,
  });
  if (!captured) return null;

  await withTenant(companyId, async (tx) => {
    await appendEvent(tx, {
      companyId,
      type: 'eval.negative_candidate',
      actor: 'system',
      payload: { agentRunId, reason, caseId: captured.id },
    });
  });
  return captured.id;
}

export async function acceptEvalCase(companyId: string, caseId: string): Promise<void> {
  await withTenant(companyId, async (tx) => {
    await tx.query(
      'UPDATE role_eval_cases SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL',
      [caseId],
    );
  });
}

export async function evalCasesFor(companyId: string, roleId: string): Promise<EvalCase[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      name: string;
      polarity: Polarity;
      accepted_at: Date | null;
      expectation: { capabilities?: string[]; failureMode?: string | null };
    }>(
      `SELECT id, name, polarity, accepted_at, expectation
         FROM role_eval_cases WHERE role_id = $1 ORDER BY name`,
      [roleId],
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      polarity: row.polarity,
      accepted: row.accepted_at !== null,
      capabilities: row.expectation.capabilities ?? [],
      failureMode: row.expectation.failureMode ?? null,
    }));
  });
}

/**
 * Scores a proposed change against the role's accepted cases (F17.2, F17.3).
 *
 * The change is described rather than applied: F17.3 needs the number *before*
 * the owner decides, so nothing here writes to the role.
 */
export async function scoreRoleChange(input: {
  companyId: string;
  roleId: string;
  change: RoleChange;
  /** The tools the role would hold after the change. */
  tools: string[];
}): Promise<EvalResult> {
  const cases = (await evalCasesFor(input.companyId, input.roleId)).filter(
    (evalCase) => evalCase.accepted,
  );

  if (cases.length < MINIMUM_EVAL_CASES) {
    return {
      // Unscored, not passing. An empty eval set reporting success would be the
      // most dangerous number in the system.
      scored: false,
      passed: 0,
      failed: 0,
      cases: [],
    };
  }

  const held = new Set(input.tools);
  const outcomes = cases.map((evalCase) => {
    if (evalCase.polarity === 'positive') {
      const lost = evalCase.capabilities.filter((name) => !held.has(name));
      return {
        name: evalCase.name,
        polarity: evalCase.polarity,
        passed: lost.length === 0,
        detail:
          lost.length === 0
            ? `the role still holds every capability this run used (${
              evalCase.capabilities.join(', ') || 'none'
            })`
            : `the change removes ${lost.join(', ')}, which this run needed`,
      };
    }

    // A negative case passes when the failure stays impossible: the capability
    // the bad run reached for is no longer held, or the run failed for a reason
    // no capability could reintroduce.
    const stillReachable = evalCase.capabilities.filter((name) => held.has(name));
    return {
      name: evalCase.name,
      polarity: evalCase.polarity,
      passed: stillReachable.length === 0,
      detail:
        stillReachable.length === 0
          ? `the path this run took (${evalCase.failureMode ?? 'unknown'}) is closed`
          : `${stillReachable.join(', ')} is still held, so ${
            evalCase.failureMode ?? 'the same failure'
          } remains reachable`,
    };
  });

  const passed = outcomes.filter((outcome) => outcome.passed).length;
  const result: EvalResult = {
    scored: true,
    passed,
    failed: outcomes.length - passed,
    cases: outcomes,
  };

  await withTenant(input.companyId, async (tx) => {
    await tx.query(
      `INSERT INTO role_eval_runs (company_id, role_id, triggered_by, passed, failed, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.companyId,
        input.roleId,
        input.change,
        result.passed,
        result.failed,
        JSON.stringify(result.cases),
      ],
    );
  });

  return result;
}

/**
 * The last score, for the item the owner is about to decide (F17.3).
 *
 * Read from the stored run rather than recomputed, so that "what did it score
 * when I approved it" stays answerable after the role has changed again.
 */
export async function latestScore(
  companyId: string,
  roleId: string,
): Promise<{ passed: number; failed: number; ranAt: Date; triggeredBy: string } | null> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      passed: number;
      failed: number;
      ran_at: Date;
      triggered_by: string;
    }>(
      `SELECT passed, failed, ran_at, triggered_by FROM role_eval_runs
        WHERE role_id = $1 ORDER BY ran_at DESC LIMIT 1`,
      [roleId],
    );
    const row = rows[0];
    return row
      ? { passed: row.passed, failed: row.failed, ranAt: row.ran_at, triggeredBy: row.triggered_by }
      : null;
  });
}

/**
 * F17.2 and F17.3 together: propose a role change, and put the score in front
 * of the owner.
 *
 * Refuses to apply anything itself. The three things this guards -- charter,
 * skills, model routing -- are the three that change what a role will do, and
 * F10.2's rule that an approval item says *why* is met by the score travelling
 * with the request rather than being a click away.
 */
export async function requestRoleChange(input: {
  companyId: string;
  roleId: string;
  change: RoleChange;
  tools: string[];
  summary: string;
}): Promise<{ score: EvalResult; inboxItemId: string }> {
  const score = await scoreRoleChange(input);

  const inbox = await import('../inbox/inbox.ts');
  const rendered = score.scored
    ? `Eval: ${score.passed} passed, ${score.failed} failed of ${
      score.passed + score.failed
    } reference trajectories.\n` +
      score.cases
        .filter((outcome) => !outcome.passed)
        .map((outcome) => `  - ${outcome.name}: ${outcome.detail}`)
        .join('\n')
    : `This role has fewer than ${MINIMUM_EVAL_CASES} accepted reference trajectories, so ` +
      'the change is unscored. That is not the same as passing.';

  const inboxItemId = await inbox.requestApproval({
    companyId: input.companyId,
    capabilityName: `role.${input.change}`,
    // F2.9: changing what a role is, is a structural change.
    tier: 3,
    actionSummary: input.summary,
    rationale: `${input.summary}\n\n${rendered}`,
    consequenceIfDenied: 'The role keeps working exactly as it does now.',
    estimatedCostCents: 0,
    payload: { change: input.change, score },
  });

  return { score, inboxItemId };
}

/** Refuses a change the owner has not approved. Used by callers that apply one. */
export function assertApproved(approved: boolean, change: RoleChange): void {
  if (!approved) {
    throw new PalugadaError(
      'approval.required',
      `changing a role's ${change} is a structural change and needs the owner (F2.9, F17.3)`,
      { change },
    );
  }
}
