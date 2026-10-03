/**
 * Machine-readable failure codes.
 *
 * The PRD names specific codes in its acceptance criteria (F2.4
 * `capability.not_granted`, F6.6 `cycle_detected`, F1.3 `security.rls_denied`).
 * They are values rather than prose because policy evaluation, event payloads
 * and the owner inbox all branch on them.
 */
export type ErrorCode =
  | 'capability.not_granted'
  | 'capability.unknown'
  | 'capability.disabled'
  | 'capability.verify_missing'
  | 'capability.miscalibrated'
  | 'capability.verify_failed'
  | 'capability.rate_limited'
  /** F5.7: every call the grant allows at once is in flight, and a place did not free in time. */
  | 'capability.busy'
  /** F12.9: the capability was asked to reach somewhere it may not. */
  | 'capability.unreachable'
  /** The broker was built with no secret manager, so no credential can be resolved. */
  | 'credential.unavailable'
  /** F12.6: the credential does not declare a scope the capability needs. */
  | 'credential.scope_insufficient'
  | 'contract.violation'
  | 'goal.required'
  /** Work is not started under a goal the owner has closed, or under one beneath it. */
  | 'goal.closed'
  | 'role.incomplete'
  | 'plan.required'
  | 'plan.batch_mismatch'
  | 'plan.already_recorded'
  | 'plan.invalid'
  | 'policy.denied'
  | 'hook.denied'
  | 'model.unavailable'
  | 'skill.invalid'
  | 'skill.unknown'
  | 'skill.scope_change'
  | 'skill.quarantined'
  | 'skill.bad_signature'
  | 'config.unknown_version'
  /**
   * A deployment's own configuration file cannot be built from.
   *
   * Separate from `contract.violation`, which is an agent breaking a rule this
   * platform stated. This one is the operator's file, read at boot, and it is
   * refused there rather than becoming a capability that fails at an agent's
   * first call -- the silent misconfiguration v2 section 2.3 records.
   */
  | 'config.invalid'
  /** F12.5: that secret is already enrolled, so a second row would fight it. */
  | 'mfa.already_enrolled'
  /**
   * An inbox item that is no longer the owner's to decide: decided on another
   * surface, expired, or withdrawn because its task ended. Carries which.
   */
  | 'inbox.not_open'
  | 'gateway.unpaired'
  | 'gateway.bad_signature'
  | 'gateway.quarantined'
  | 'gateway.replayed'
  /** F12.7: pairing names a key, and this device's is not the one named. */
  | 'gateway.key_mismatch'
  /** F12.7: no such device, or one revoked, which a pairing does not undo. */
  | 'gateway.not_pairable'
  | 'bundle.invalid'
  | 'bundle.unknown'
  | 'bundle.bad_signature'
  | 'publisher.invalid_key'
  | 'archive.invalid'
  /** F13.5: a remote sandbox outlived its run and may still be billing. */
  | 'sandbox.not_destroyed'
  | 'approval.channel_forbidden'
  /**
   * F12.5. The owner's second factor, and the eleven ways it fails.
   *
   * Enumerated rather than collapsed into one `mfa.failed` because these are
   * what an auditor reads off `owner_authentications`: "wrong code" and "that
   * code has been used before" and "the signature counter went backwards" are
   * three completely different stories about the same refusal, and only the
   * last two are somebody trying.
   */
  | 'mfa.not_enrolled'
  | 'mfa.code_invalid'
  | 'mfa.replayed'
  | 'mfa.secret_malformed'
  | 'mfa.unknown_credential'
  | 'mfa.assertion_malformed'
  | 'mfa.wrong_ceremony'
  | 'mfa.challenge_unknown'
  | 'mfa.wrong_origin'
  | 'mfa.wrong_relying_party'
  | 'mfa.not_user_verified'
  | 'mfa.signature_invalid'
  | 'mfa.counter_did_not_advance'
  /** F12.5: a new passkey's attestation is not one an authenticator wrote. */
  | 'mfa.attestation_malformed'
  /** F12.5: a new passkey signs with an algorithm the console did not offer. */
  | 'mfa.algorithm_unsupported'
  | 'mfa.locked_out'
  /** F12.5: no enrolled factor's secret can be read, so nothing can be checked. */
  | 'mfa.factor_unavailable'
  /** F12.5: the owner's console was reached without a session. */
  | 'owner.unauthenticated'
  | 'owner.throttled'
  /** F12.5: a claim link that is not one, has expired, or was used (0094). Counted as a guess. */
  | 'mfa.claim_invalid'
  /** F12.5: a claim of a deployment that already has an owner (0094). */
  | 'owner.claimed'
  | 'review.required'
  | 'window.closed'
  | 'approval.required'
  /** A run asked the owner something with `owner.ask`; the task waits for the answer. */
  | 'owner.asked'
  /** A task is waiting for work it delegated with `task.delegate` (it parks, then looks again). */
  | 'task.waiting_child'
  /** An inbound trigger's URL names nothing open (0054). */
  | 'hook.unknown'
  /** An inbound trigger was called without its token or its sender's signature (0054, 0056). */
  | 'hook.refused'
  /** An inbound trigger has had its events for the hour (0054). */
  | 'hook.rate_limited'
  /** An inbound trigger was sent a body that is not JSON, a form or text (0056). */
  | 'hook.unsupported'
  /** A signed trigger's secret cannot be read, so no delivery can be checked (0056). */
  | 'hook.unavailable'
  | 'approval.denied'
  | 'budget.exceeded'
  | 'budget.reservation_refused'
  | 'spend.paused'
  | 'batch.not_eligible'
  | 'hop.exceeded'
  | 'cycle.detected'
  /** F6.5: a task asked for more sub-tasks than it may have. Not a cycle: the owner is told which. */
  | 'fanout.exceeded'
  /** A run went past its role's own ceiling on tokens. */
  | 'run.limit'
  /** A run a model wrote did not say, criterion by criterion, how it met its role's done criteria (F2.8). */
  | 'done.unreported'
  /** A run said a done criterion is not met, or claimed one without showing how. */
  | 'done.unmet'
  | 'deadline.exceeded'
  /**
   * F9.1: the owner asked a schedule to run now while a task it made has not
   * ended. Carries that task, so the owner can open it instead.
   */
  | 'schedule.still_running'
  /** "New schedule" under a short name another schedule of the company has (N11). */
  | 'schedule.slug_taken'
  /**
   * A company is being made, or restored, under a short name another company
   * already has. The name is the company's handle in links and exports, so
   * the owner chooses another rather than being told the database refused.
   */
  | 'company.slug_taken'
  | 'company.frozen'
  /**
   * Section 6.3: the owner asked to go on with a task that its budget did not
   * stop, or that is no longer halted. Only a budget halt is continued where
   * it stopped; anything else is done again.
   */
  | 'task.not_continuable'
  | 'role.frozen'
  | 'platform.stopped'
  | 'task.invalid_transition'
  /**
   * F5.12: the worker running a task no longer holds its lease -- it lapsed
   * and another worker took the task. Nothing more is done or committed.
   */
  | 'task.lease_lost'
  /**
   * F5.1: a replayed step is not the step the journal recorded at its
   * position -- the handler is not deterministic, or the journal was written
   * by a different sequence of calls. Handing back the recorded output would
   * give one call another call's answer.
   */
  | 'journal.divergence'
  | 'tenant.context_missing'
  /** Section 12: the metrics endpoint was asked for and none is configured. */
  | 'metrics.off'
  /** Section 12: the metrics endpoint was asked without its token, or with another. */
  | 'metrics.refused';

export class PalugadaError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'PalugadaError';
    this.code = code;
    this.details = details;
  }
}

export function isPalugadaError(error: unknown, code?: ErrorCode): error is PalugadaError {
  return error instanceof PalugadaError && (code === undefined || error.code === code);
}

/** PostgreSQL raises 42501 when a query runs without tenant context. */
export function isTenantContextMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  const message = (error as Error | null)?.message ?? '';
  return code === '42501' && message.includes('app.company_id');
}
