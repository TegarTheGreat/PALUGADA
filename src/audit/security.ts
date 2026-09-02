/**
 * Security events (PRD F1.3).
 *
 * A denial that leaves no trace is indistinguishable from an attack that never
 * happened. These helpers record the attempt so repeated probing is visible in
 * the event log and can drive the automatic role freeze in F3.7.
 */
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';

export function isRlsViolation(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  // 42501 insufficient_privilege covers both the missing tenant context raised
  // by app.current_company_id() and a policy WITH CHECK rejection.
  return code === '42501';
}

export async function reportRlsDenial(
  companyId: string,
  details: { taskId?: string | undefined; attemptedCompanyId?: string; statement: string; message: string },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    await appendEvent(tx, {
      companyId,
      taskId: details.taskId,
      type: 'security.rls_denied',
      actor: 'system',
      payload: {
        attemptedCompanyId: details.attemptedCompanyId ?? null,
        statement: details.statement,
        message: details.message,
      },
    });
  });
}
