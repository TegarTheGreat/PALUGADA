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
  | 'capability.verify_failed'
  | 'capability.rate_limited'
  | 'contract.violation'
  | 'policy.denied'
  | 'review.required'
  | 'window.closed'
  | 'approval.required'
  | 'approval.denied'
  | 'budget.exceeded'
  | 'budget.reservation_refused'
  | 'hop.exceeded'
  | 'cycle.detected'
  | 'deadline.exceeded'
  | 'company.frozen'
  | 'platform.stopped'
  | 'task.invalid_transition'
  | 'tenant.context_missing';

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
