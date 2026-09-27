/**
 * How a run answers its done criteria (src/engine/done.ts), for the tests
 * whose subject is something else: read from the contract the run was given,
 * every criterion met, with evidence -- the answer a model following its
 * contract gives.
 */

/** The criteria a contract lists under "The criteria:". */
export function criteriaIn(prompt: string): string[] {
  const at = prompt.indexOf('The criteria:\n');
  if (at === -1) return [];
  const criteria: string[] = [];
  for (const line of prompt.slice(at + 'The criteria:\n'.length).split('\n')) {
    if (!line.startsWith('- ')) break;
    criteria.push(line.slice(2).trim());
  }
  return criteria;
}

/** A report meeting every one of `criteria`. */
export function reportOn(criteria: readonly string[]): Array<{ criterion: string; met: boolean; evidence: string }> {
  return criteria.map((criterion) => ({ criterion, met: true, evidence: 'the work shows it' }));
}

/** `output` with the report its contract asks for, as JSON. */
export function answering(prompt: string, output: Record<string, unknown>): string {
  const criteria = criteriaIn(prompt);
  return JSON.stringify(criteria.length > 0 ? { ...output, done: reportOn(criteria) } : output);
}
