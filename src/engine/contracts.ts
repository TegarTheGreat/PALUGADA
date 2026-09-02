/**
 * Typed task contracts (PRD F6.1, F6.2).
 *
 * Principle 4 says agents do not talk to agents. The only way one role reaches
 * another is by creating a task, and a task is only meaningful if both ends
 * agree on its shape -- otherwise "no free-form chat" just moves the ambiguity
 * from a message into a JSON blob nobody validates.
 *
 * So both directions are checked. Input is validated before a run starts,
 * because a run that begins on malformed input burns tokens to discover what a
 * schema could have said immediately. Output is validated before the task is
 * marked complete, because a downstream task triggered by `task.completed`
 * (F6.3) has no other guarantee about what it is reading.
 *
 * Schemas are compiled once and cached: compilation is the expensive part, and
 * a role's schema does not change between runs.
 */
// ajv is CommonJS and sets both `module.exports = Ajv` and
// `module.exports.Ajv = Ajv`. The named import is the form that resolves
// correctly under Node's ESM interop and under NodeNext type resolution; a
// default import type-checks as a namespace and is not constructable.
import { Ajv, type ValidateFunction } from 'ajv';
import { PalugadaError } from '../errors.ts';

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = new Map<string, ValidateFunction>();

function validatorFor(cacheKey: string, schema: Record<string, unknown>): ValidateFunction {
  let validate = compiled.get(cacheKey);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(cacheKey, validate);
  }
  return validate;
}

export class ContractViolation extends PalugadaError {
  readonly direction: 'input' | 'output';
  readonly problems: string[];

  constructor(direction: 'input' | 'output', roleSlug: string, problems: string[]) {
    super(
      'contract.violation',
      `${direction} for role ${roleSlug} does not satisfy its contract: ${problems.join('; ')}`,
      { direction, roleSlug, problems },
    );
    this.name = 'ContractViolation';
    this.direction = direction;
    this.problems = problems;
  }
}

/**
 * An empty schema means "no contract declared" and accepts anything.
 *
 * That is a deliberate escape hatch for a role still being designed, not a
 * default to leave in place: a role reachable by another role should declare
 * both directions.
 */
function isUnconstrained(schema: Record<string, unknown>): boolean {
  return Object.keys(schema).length === 0;
}

export function validateContract(
  direction: 'input' | 'output',
  roleId: string,
  roleSlug: string,
  schema: Record<string, unknown>,
  value: unknown,
): void {
  if (isUnconstrained(schema)) return;

  const validate = validatorFor(`${roleId}:${direction}`, schema);
  if (validate(value)) return;

  const problems = (validate.errors ?? []).map(
    (error) => `${error.instancePath || '$'} ${error.message ?? 'is invalid'}`,
  );
  throw new ContractViolation(direction, roleSlug, problems);
}

/** Clears the compiled-schema cache. Used when a role's schema is edited. */
export function forgetCompiledSchemas(roleId?: string): void {
  if (!roleId) {
    compiled.clear();
    return;
  }
  compiled.delete(`${roleId}:input`);
  compiled.delete(`${roleId}:output`);
}
