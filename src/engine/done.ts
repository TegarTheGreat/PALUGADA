/**
 * Done criteria, checked (PRD F2.8, F14 `post_run`).
 *
 * A role may not work without criteria "that can be tested", and every run is
 * shown them -- and a run that ended with any JSON at all used to count as
 * done. A run a model wrote now answers each criterion in its output, under
 * `done`: whether it met it, and what in its work shows that. The engine
 * holds it to that report: one that leaves a criterion out, says one is not
 * met, or claims one without showing how, is not done, and the retry is told
 * which.
 *
 * What this checks is mostly the run's own account, not the world. It makes a
 * run face every criterion and put its evidence where the owner reads the
 * work; judging the evidence is a reviewer's, and nothing here pretends to be
 * one. Code a deployment registered as a role's handler is exempt: it is
 * checked by its tests, and asking it to vouch for itself would add nothing.
 *
 * The one part the platform can check is a citation (after Auto-Company,
 * whose check runner records a test's exit status itself so that a report
 * cannot invent one). Every tool call is a step in the task's journal, and
 * its result tells the run which (`citeStep`). Evidence that cites one as
 * `step:<n>` is held to the journal: a call this task made that succeeded
 * makes the criterion **verified**; anything else stays **claimed**, the
 * run's word. The owner reads which is which beside the work (owner/views.ts).
 */
import { PalugadaError } from '../errors.ts';
import type { JournalEntry } from './journal.ts';

export interface DoneEntry {
  criterion: string;
  met: boolean;
  evidence: string;
}

/**
 * Whether a role's output schema has room for the report: it does unless it
 * forbids properties it does not name and names no `done`. A schema that
 * leaves no room is neither asked for a report nor held to one.
 */
export function roomForDone(schema: Record<string, unknown>): boolean {
  const named = (schema.properties as Record<string, unknown> | undefined) ?? {};
  return schema.additionalProperties !== false || 'done' in named;
}

/** What a run is told to add, after its schema. */
export function doneInstruction(criteria: readonly string[]): string {
  return [
    'Add "done": one entry for each line under "Done means", in order, as',
    '{"criterion": the line, "met": true or false, "evidence": what in your work shows it}.',
    'Say "met": false, with why, for any you did not meet: the task is then not done, and is tried again with your reason.',
    'An entry without evidence counts as not met.',
    'Evidence may cite a tool call as step:<n>, the step its result named: the platform checks that this task made ' +
      'that call and it succeeded, shows the owner the criterion as verified rather than claimed, and counts a ' +
      'citation of a step that failed or is not this task\'s as not met.',
    '',
    'The criteria:',
    ...criteria.map((criterion) => `- ${criterion}`),
  ].join('\n');
}

/**
 * What a run is told after a tool call's result: the step its journal keeps
 * the call as, which is what evidence cites. Put after the fence around the
 * result, because it is the platform's word and not the tool's, and after any
 * cut, so a long result does not lose it.
 */
export function citeStep(step: number): string {
  return `This call is step:${step} of your task; evidence may cite it as step:${step}.`;
}

/**
 * A citation: `step:` and the journal's own index for the step, in any case,
 * with or without a space. At most six digits, so a long number in the
 * evidence -- an order, a phone -- is not read as one.
 */
const CITATION = /\bstep:\s?(\d{1,6})\b/gi;

/** What the journal makes of one criterion's evidence. */
export interface Weighed {
  /**
   * `verified` when the evidence cites at least one tool call this task made
   * that succeeded, and nothing the journal contradicts; `claimed` otherwise.
   * A model's own turn is committed too, but citing it cites the run's word
   * about itself, so only a call through the broker counts.
   */
  check: 'verified' | 'claimed';
  /** The succeeded tool calls it cites, in the order it cites them. */
  steps: Array<{ step: number; capability: string }>;
  /** The first citation the journal contradicts, as the retry reads it; null when none is. */
  refuted: string | null;
}

/**
 * Holds evidence to the task's journal. The journal given is this task's
 * alone (`journalOf`), which is what makes a step belong to this task: a
 * number another task's journal holds is, here, a step that does not exist.
 */
export function weighEvidence(evidence: string, journal: readonly JournalEntry[]): Weighed {
  const byIndex = new Map(journal.map((step) => [step.index, step]));
  const steps: Weighed['steps'] = [];
  const cited = new Set<number>();
  let refuted: string | null = null;
  for (const match of evidence.matchAll(CITATION)) {
    const index = Number(match[1]);
    if (cited.has(index)) continue;
    cited.add(index);
    const step = byIndex.get(index);
    if (!step) {
      refuted ??= `cites step:${index}, which this task's journal does not have`;
    } else if (step.status === 'failed') {
      refuted ??= `cites step:${index}, which failed: ${(step.error ?? 'no reason was recorded').slice(0, 300)}`;
    } else if (step.status !== 'committed') {
      refuted ??= `cites step:${index}, which never finished`;
    } else if (step.kind === 'tool') {
      steps.push({ step: index, capability: step.name.replace(/^capability:/, '') });
    }
  }
  return { check: steps.length > 0 && refuted === null ? 'verified' : 'claimed', steps, refuted };
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Holds an output to its report and to the task's journal. Each criterion is
 * found by its words, or by its place when the run put it in its own words;
 * the first that is missing, not met, not shown, or shown by a step the
 * journal contradicts is the reason. Returns which criteria the journal
 * verified and which the run only claimed.
 *
 * A contradicted citation fails the criterion rather than leaving it claimed.
 * Evidence with no citation is the run's word and passes as it always did;
 * evidence that names a step is a statement the platform can test, and one
 * that tests false is the thing this report exists to catch -- a run citing
 * the CRM write that failed as proof the note was written (the chaos run of
 * 2026-09-29). Passed as claimed, it would reach the owner looking like any
 * honest claim. Refused, the retry is told which step and why, and can cite
 * the call that succeeded or say the criterion is not met.
 */
export function checkDone(
  criteria: readonly string[],
  output: Record<string, unknown>,
  journal: readonly JournalEntry[],
): Array<{ criterion: string; check: Weighed['check'] }> {
  const report = output.done;
  if (!Array.isArray(report)) {
    throw new PalugadaError('done.unreported',
      `the output did not say how it met its done criteria: add "done", one entry each for ${criteria.map((one) => `"${one}"`).join(', ')}`,
      { criteria: [...criteria] });
  }
  const entries = report.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  const marks: Array<{ criterion: string; check: Weighed['check'] }> = [];
  for (const [index, criterion] of criteria.entries()) {
    const entry = entries.find((one) => typeof one.criterion === 'string' && same(one.criterion, criterion)) ?? entries[index];
    if (!entry) {
      throw new PalugadaError('done.unreported',
        `the output did not say how it met its done criteria: nothing in "done" answers "${criterion}"`, { criterion });
    }
    const evidence = typeof entry.evidence === 'string' ? entry.evidence.trim() : '';
    if (entry.met !== true) {
      throw new PalugadaError('done.unmet',
        `not done: "${criterion}" is not met${evidence ? ` -- ${evidence.slice(0, 500)}` : ''}`, { criterion });
    }
    if (!evidence) {
      throw new PalugadaError('done.unmet', `the output says "${criterion}" is met without showing how: its evidence is empty`, { criterion });
    }
    const weighed = weighEvidence(evidence, journal);
    if (weighed.refuted) {
      throw new PalugadaError('done.unmet',
        `not shown: the evidence for "${criterion}" ${weighed.refuted}. Cite a tool call of this task that ` +
          'succeeded, or say the criterion is not met',
        { criterion });
    }
    marks.push({ criterion, check: weighed.check });
  }
  return marks;
}

/**
 * What a run is told about writes that failed (a chaos run on 2026-09-29).
 *
 * A CRM refused the note, the model answered every criterion "met", and the
 * task completed with a summary saying the note was written. The engine
 * knew the call had failed; nothing held the report to it.
 */
export const FAILED_INSTRUCTION =
  'If a tool call that changes something failed and no later call of it succeeded, add ' +
  '"failed": [{"capability": its name, "why": why the work is done anyway}]. Work that leaves one ' +
  'out does not count as done.';

/**
 * Holds an output to the writes that failed in its run: each one never put
 * right by a later call is named under `failed`, with why, or the work is
 * not done. Named, it is done -- the run may have had a way round the
 * failure -- and the owner reads which call failed with the work.
 */
export function checkFailedWrites(
  unrecovered: ReadonlyArray<{ capability: string; error: string }>,
  output: Record<string, unknown>,
): void {
  if (unrecovered.length === 0) return;
  const named = new Set((Array.isArray(output.failed) ? output.failed : [])
    .filter((entry): entry is { capability: string; why: string } =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as Record<string, unknown>).capability === 'string'
      && typeof (entry as Record<string, unknown>).why === 'string'
      && ((entry as Record<string, unknown>).why as string).trim() !== '')
    .map((entry) => entry.capability));
  const missing = unrecovered.find((write) => !named.has(write.capability));
  if (missing) {
    throw new PalugadaError('done.unmet',
      `the output says the work is done, but ${missing.capability} failed and no later call of it succeeded ` +
      `(${missing.error.slice(0, 300)}): do it again, or name it under "failed" with why the work is done anyway`,
      { capability: missing.capability });
  }
}

