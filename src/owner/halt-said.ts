/**
 * Why work stopped, as the owner reads it outside the console (the analysis
 * of 3 October, §2.3 item 7).
 *
 * A chat said "Why: budget exhausted": the halt's code with its underscores
 * taken out, in English, inside an Indonesian notice. The sentences are the
 * console's own (`HALT_REASONS`, `console/src/format.ts`), so the owner reads
 * the same words on the phone as on the task.
 */
import type { HaltReason } from '../domain/task.ts';
import { say } from './say.ts';

export function haltSaid(language: string | null | undefined, reason: string | null): string {
  // A record of every reason, so a new one cannot reach the owner as a code.
  const said: Record<HaltReason, () => string> = {
    contract_violation: () => say(language, 'Broke its contract'),
    policy_denied: () => say(language, 'Refused by a policy'),
    budget_exhausted: () => say(language, 'Out of budget'),
    hop_limit: () => say(language, 'Handed on too many times'),
    deadline_passed: () => say(language, 'Missed its deadline'),
    verification_failed: () => say(language, 'Its result did not check out'),
    capability_unhealthy: () => say(language, 'A capability it needs is down'),
    runtime_unavailable: () => say(language, 'No runtime could take it'),
    cycle_detected: () => say(language, 'Went in a circle'),
    fan_out_limit: () => say(language, 'Split into too many sub-tasks'),
    run_limit: () => say(language, 'Wrote more than its role allows one run'),
    approval_expired: () => say(language, 'Your approval was not given in time'),
    owner_stop: () => say(language, 'Stopped by you'),
    owner_cancel: () => say(language, 'Cancelled by you'),
    company_frozen: () => say(language, 'The company is frozen'),
    journal_divergence: () => say(language, 'Its record did not match on replay'),
    crash_loop: () => say(language, 'It kept stopping the worker running it'),
    not_done: () => say(language, 'Not done'),
  };
  if (reason === null) return say(language, 'Task failed');
  return (said as Record<string, (() => string) | undefined>)[reason]?.() ?? reason.replace(/_/g, ' ');
}
