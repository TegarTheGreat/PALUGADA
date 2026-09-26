/**
 * How a role's tools are shown to a model, whichever runtime shows them
 * (F13.4, section 7.5).
 *
 * A capability is named `email.send`. The model providers accept letters,
 * digits, `_` and `-` in a tool's name, and nothing else: offered under its
 * own name, every tool the platform has would be refused by the API before
 * the model saw it -- through Claude Code's `--allowedTools`, through any
 * other CLI's MCP client, through the platform's own agent loop. So each
 * runtime shows the same name, `email__send`, and maps it back.
 *
 * The description is the catalogue's summary and what the tier means for
 * the call, because a model deciding whether to try something should know
 * that tier 3 means the owner will be asked. It is advice, not enforcement:
 * the broker decides regardless of what the model believed.
 */
import { declarationFor } from '../broker/catalogue.ts';
import type { ToolDeclaration } from './protocol.ts';

export interface ToolForModel {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TIER_MEANING: Record<number, string> = {
  0: 'it only reads, and runs at once.',
  1: 'it writes something that can be undone, and is read back to check it happened.',
  2: 'it spends money or reaches people: record a plan with plan.record first, and it is checked against that plan.',
  3: 'it cannot be undone: calling it asks the owner, and the task waits for their answer.',
};

/**
 * The name a provider accepts. The dot becomes `__`, which no catalogued
 * name contains; anything else outside the accepted set becomes `_`.
 */
function acceptedName(name: string): string {
  return name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
}

/** A provider takes an object schema for every tool; a capability that declared none takes any object. */
function objectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === 'object') return schema;
  if (Object.keys(schema).length === 0) return { type: 'object', additionalProperties: true };
  return { type: 'object', ...schema };
}

/**
 * The tools as a model is shown them, and the way from a name it uses back
 * to the capability. Deterministic, so two runtimes -- the bridge and the
 * CLI told which of its tools it may use -- arrive at the same names.
 */
export function toolsForModel(tools: readonly ToolDeclaration[]): {
  tools: ToolForModel[];
  platformName: Map<string, string>;
} {
  const platformName = new Map<string, string>();
  const described: ToolForModel[] = [];
  for (const tool of tools) {
    const base = acceptedName(tool.name);
    let name = base;
    // A name that would still collide is numbered rather than silently
    // shadowing the one before it.
    for (let n = 2; platformName.has(name); n += 1) name = `${base}_${n}`;
    platformName.set(name, tool.name);
    const declaration = declarationFor(tool.name);
    described.push({
      name,
      description:
        `${declaration?.summary ?? `The capability ${tool.name}.`} ` +
        `PALUGADA capability ${tool.name}, tier ${tool.tier}: ${TIER_MEANING[tool.tier] ?? TIER_MEANING[3]}`,
      inputSchema: objectSchema(tool.inputSchema),
    });
  }
  return { tools: described, platformName };
}
