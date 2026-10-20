/**
 * What every role of every company is built from: the shape of the work it is
 * given and the shape of what it returns, and the platform tools every
 * division holds.
 *
 * These were the standard company's, and the standard company is gone from the
 * product: a company starts with its CEO and the CEO builds the team
 * (`founding.ts`). What a role of any team is held to stays here.
 */
/** The shape of a task handed to any role. */
export const WORK_INPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['goal'],
  properties: {
    goal: { type: 'string', minLength: 1 },
    context: { type: 'string' },
  },
} as const;

/**
 * The shape every role returns.
 *
 * `summary` is required because a run that produces no account of itself
 * cannot be reviewed, digested or distilled -- and those three are most of
 * what makes the company improve.
 */
export const WORK_OUTPUT = {
  type: 'object',
  additionalProperties: true,
  required: ['summary'],
  properties: {
    summary: { type: 'string', minLength: 1 },
    // What the work taught that the company should remember (0071); kept
    // for the role's division as unverified lessons.
    learned: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 500 } },
  },
} as const;

/**
 * The two capabilities almost every role holds.
 *
 * They are not a convenience. F4.8 caps the context pack and tells the run to
 * use `memory.search` for whatever did not fit; F15.7 puts a skill's summary in
 * the pack and tells it to use `skill.read` for the document. A company whose
 * roles are not granted them is one where every run is instructed to call
 * something it will be refused for — which is what the first real boot of this
 * platform found, and which no test had caught because no test followed the
 * instruction.
 *
 * Both are tier 0 reads of the company's own store, scoped to the asking
 * division by the same rules the pack uses, so granting them widens nothing.
 *
 * `plan.record` and `metric.record` join them. The first was missing, and
 * with it every tier 2 grant in this template was one its holder could never
 * use: F8.11 refuses a tier 2 action on a task with no plan, and the only way
 * a run records one is this capability. The second is how a run says where a
 * key result stands (0053). Both write only to the company's own records,
 * which is why they are tier 0. The third, `owner.ask`, is how a run that
 * needs the owner asks rather than guesses; it opens an item and parks the
 * task, and nothing leaves the company.
 */
export const PLATFORM_TOOLS = ['memory.search', 'skill.read', 'plan.record', 'metric.record', 'owner.ask'] as const;
