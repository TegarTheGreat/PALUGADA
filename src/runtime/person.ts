/**
 * The `person` runtime (the audit of 6 October, §8.2, P1.1d; STATUS 2.173).
 *
 * Some of a company's work is a person's: a count of what is on a shelf, a
 * signature, a call, a photo of a delivery. A role can be that person -- a
 * contractor the company employs through a staff seat -- and this is the
 * runtime it runs on. Nothing is run. The work the role is given is put to the
 * person as a question, the task waits for the answer as it waits for any
 * (`waiting_approval`, nothing held, nothing counted against its deadline while
 * it waits), and what the person answers, files included, is what the role
 * produced.
 *
 * It is built from what the platform already does for a question to a person
 * (`askOwner` with an addressee): the person sees it in their own inbox and
 * no one else's, the owner is told if it goes a day unanswered, an answer may
 * carry files, and asking again -- a task resumed after the answer, an attempt
 * run twice -- is the same question and not a second one.
 *
 * What it will not do is fall back. A person who is no longer seated is not
 * replaced by a model: the work is refused, and the owner told, because work
 * that was given to a person and was quietly done by something else is not the
 * work that was asked for.
 */
import { withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { QUESTION_ESCALATES_AFTER_HOURS, askOwner, askableSeats } from '../inbox/inbox.ts';
import type { Adapter, AdapterHealth, AdapterResult, ExecutionBackend, RunRequest } from './protocol.ts';

/** The longest brief put to a person as the question: as long as a run may ask one. */
const BRIEF_MAX = 1_000;
/** What the person is told depends on it, in the card's detail. */
const CONTEXT_MAX = 4_000;

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export class PersonAdapter implements Adapter {
  readonly name = 'person';
  readonly backends: readonly ExecutionBackend[] = ['local'];

  async health(): Promise<AdapterHealth> {
    // There is nothing to reach: a person is asked, not called. Whether this
    // one is still seated is found when the work is given, and said then.
    return { ok: true, detail: 'a person answers; this deployment runs nothing for the role' };
  }

  async run(request: RunRequest): Promise<AdapterResult> {
    const { task } = request;
    const { rows } = await withTenant(task.companyId, (tx) => tx.query<{ person_seat: string | null; person_name: string | null }>(
      'SELECT person_seat, person_name FROM roles WHERE id = $1', [task.roleId]));
    const bound = rows[0];
    if (!bound?.person_name) {
      throw new PalugadaError('contract.violation', `role ${request.roleSlug} runs on a person and names none`, { roleId: task.roleId });
    }
    const seated = (await askableSeats(task.companyId)).find((one) => one.seatId === bound.person_seat);
    if (!seated) {
      // Terminal, and the owner is told by the halt: the same refusal would
      // follow a retry, and a model must not do a person's work unasked.
      throw new PalugadaError('policy.denied',
        `${bound.person_name} is no longer seated, so there is no one to do this: seat them again, or give the work to another role`,
        { roleId: task.roleId });
    }

    // The brief as it was given, in the words it was given in: the goal is the
    // question, and what depends on it is the context. Nothing is added in a
    // language the platform chose.
    const goal = text(task.input.goal) || text(task.input.brief) || text(task.input.instruction);
    if (!goal) {
      throw new PalugadaError('contract.violation', 'work for a person needs a goal to put to them', { taskId: task.id });
    }
    const context = text(task.input.context);
    const asked = await askOwner({
      companyId: task.companyId,
      taskId: task.id,
      question: goal.length > BRIEF_MAX ? `${goal.slice(0, BRIEF_MAX - 1)}…` : goal,
      why: context ? context.slice(0, CONTEXT_MAX) : null,
      options: null,
      addressee: { seatId: seated.seatId, name: seated.name, escalateAfterHours: QUESTION_ESCALATES_AFTER_HOURS },
    });

    if (asked.state === 'answered') {
      return {
        output: {
          summary: asked.answer || `${seated.name} did it`,
          answeredBy: seated.name,
          ...(asked.files.length > 0 ? { files: asked.files.map((one) => ({ kind: one.kind, name: one.name, path: one.path })) } : {}),
        },
        // A person's answer is not a model's report on criteria it met: it is
        // what was done, and the owner or the coordinator reads it.
        writtenBy: 'code',
      };
    }
    if (asked.state === 'unanswered') {
      throw new PalugadaError('policy.denied', `${seated.name} did not take this on: it was closed without an answer`, { roleId: task.roleId });
    }
    // The task is parked on the question already; this says so to the engine.
    throw new PalugadaError('owner.asked', `${seated.name} has been asked; this task waits for the answer and resumes with it`, {
      inboxItemId: asked.inboxItemId,
    });
  }
}
