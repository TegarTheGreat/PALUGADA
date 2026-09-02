/**
 * Task state machine (PRD section 8.5).
 *
 * The transition table is data rather than scattered `if` statements so that
 * an illegal transition fails in one place and the diagram in the PRD can be
 * compared against the code by reading a single constant.
 */
import { PalugadaError } from '../errors.ts';

export const TASK_STATUSES = [
  'pending',
  'running',
  'completed',
  'waiting_approval',
  'waiting_review',
  'failed',
  'halted',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * `halted` is deliberately terminal. The PRD is explicit that a task stopped
 * by budget, hop, deadline or a failed read-back is never resumed
 * automatically (section 6.3): it becomes an owner inbox item instead.
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  // `pending -> halted` is not drawn in the PRD's diagram, which offers a
  // pending task only `running` and `cancelled`. It is needed anyway: a task
  // can be admitted and then miss its deadline before a worker ever picks it
  // up, and F5.6 requires an expired deadline to halt rather than proceed.
  // Routing that through `cancelled` instead would be wrong -- cancellation
  // means the owner stopped the work, while a halt is a task that stopped
  // itself and owes the owner an inbox item. Worth reconciling in the PRD.
  pending: ['running', 'halted', 'cancelled'],
  running: ['completed', 'waiting_approval', 'waiting_review', 'failed', 'halted', 'cancelled'],
  waiting_approval: ['running', 'cancelled'],
  waiting_review: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  halted: [],
  cancelled: [],
};

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'halted', 'cancelled'];

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new PalugadaError(
      'task.invalid_transition',
      `illegal task transition ${from} -> ${to}`,
      { from, to },
    );
  }
}

/** Why a task stopped. Surfaced to the owner inbox verbatim. */
export type HaltReason =
  | 'budget_exhausted'
  | 'hop_limit'
  | 'deadline_passed'
  | 'verification_failed'
  | 'cycle_detected'
  | 'approval_expired'
  | 'owner_stop'
  | 'company_frozen';
