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
 * What this checks is the run's own account, not the world. It makes a run
 * face every criterion and put its evidence where the owner reads the work;
 * judging the evidence is a reviewer's, and nothing here pretends to be one.
 * Code a deployment registered as a role's handler is exempt: it is checked by
 * its tests, and asking it to vouch for itself would add nothing.
 */
import { PalugadaError } from '../errors.ts';

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
    '',
    'The criteria:',
    ...criteria.map((criterion) => `- ${criterion}`),
  ].join('\n');
}

const same = (a: string, b: string) => a.trim().toLowerCase().replace(/\s+/g, ' ') === b.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Holds an output to its report. Each criterion is found by its words, or by
 * its place when the run put it in its own words; the first that is missing,
 * not met or not shown is the reason.
 */
export function checkDone(criteria: readonly string[], output: Record<string, unknown>): void {
  const report = output.done;
  if (!Array.isArray(report)) {
    throw new PalugadaError('done.unreported',
      `the output did not say how it met its done criteria: add "done", one entry each for ${criteria.map((one) => `"${one}"`).join(', ')}`,
      { criteria: [...criteria] });
  }
  const entries = report.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
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
  }
}
