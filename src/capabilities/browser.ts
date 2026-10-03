/**
 * `browser.read` and `browser.act`: a role uses the company's browser
 * (`src/browser/`), for the sites that have no API a small company can get
 * -- a marketplace's seller centre, a tax or licensing portal.
 *
 * Reading is tier 0, and what it returns is a stranger's page (F8.9): the
 * work that read one asks the owner before anything at tier 2. Acting is
 * tier 2, like sending an email: a form submitted is not taken back. So in
 * practice each act is a card the owner says yes to, which is why one act
 * carries all the steps of a form -- the fields, the choices, the button --
 * and the card shows each of them, the same way in every language: `Nama:
 * "Sari"; Kota → Bandung; ☑ Setuju; ▸ Kirim`.
 */
import type { Capability } from '../broker/registry.ts';
import { checkSteps, MAX_STEPS, STEP_KINDS, type ActInput, type ActResult, type ActStep, type Browsers, type PageReading } from '../browser/browsers.ts';
import { KEYS } from '../browser/page.ts';

function hostOf(url: unknown): string | null {
  try {
    return typeof url === 'string' ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

function cut(text: string, length: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > length ? `${flat.slice(0, length - 1).trimEnd()}…` : flat;
}

/** One step as the owner reads it on a card. */
function stepSaid(step: ActStep): string {
  const name = cut(String(step.name ?? ''), 40);
  switch (step.do) {
    case 'type': return `${name}: "${cut(String(step.text ?? ''), 40)}"`;
    case 'choose': return `${name} → ${cut(String(step.option ?? ''), 40)}`;
    case 'tick': return `☑ ${name}`;
    case 'untick': return `☐ ${name}`;
    case 'press': return step.ref ? `${name}: ⌨ ${step.key}` : `⌨ ${step.key}`;
    default: return `▸ ${name}`;
  }
}

/** The act in a line: where, then each step; and that the page's questions will be answered yes. */
export function actSaid(input: ActInput): string {
  let where = String(input.url ?? '');
  try {
    const url = new URL(where);
    where = `${url.host}${url.pathname === '/' ? '' : cut(url.pathname, 60)}`;
  } catch {
    // Said as it was given.
  }
  const steps = Array.isArray(input.steps) ? input.steps.map(stepSaid) : [];
  if (input.acceptDialogs) steps.push('✓ OK');
  return `${where} — ${steps.join('; ')}`;
}

export function browserRead(browsers: Browsers): Capability<{ url?: string; link?: string }, PageReading> {
  return {
    name: 'browser.read',
    adapter: 'platform:browser',
    defaultTier: 0,
    readsOutside: true,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 2048, description: 'The page to open, http or https.' },
        link: { type: 'string', pattern: '^e[0-9]{1,4}$', description: 'A link from the last reading, by its ref, to follow.' },
      },
      additionalProperties: false,
      description: 'Opens a page in the company\'s browser, or follows a link, and reads it: its text, and each link, '
        + 'button, field, list and box on it with a ref. With neither, reads the page this work has open again.',
    },
    describe: (input) => ({ moneyCents: 0, urlHost: hostOf(input.url) }),
    execute: (input, ctx) => browsers.read({ companyId: ctx.companyId, taskId: ctx.taskId }, input, ctx.signal),
  };
}

const STEP_SCHEMA = {
  type: 'object',
  required: ['do'],
  properties: {
    do: { type: 'string', enum: [...STEP_KINDS] },
    ref: { type: 'string', pattern: '^e[0-9]{1,4}$', description: 'The element, by its ref in the last reading.' },
    name: { type: 'string', maxLength: 200, description: 'The element\'s name exactly as the reading gave it.' },
    text: { type: 'string', maxLength: 5000, description: 'For type: what to type; it replaces what is in the field.' },
    option: { type: 'string', maxLength: 200, description: 'For choose: the option, as the reading listed it.' },
    key: { type: 'string', enum: Object.keys(KEYS), description: 'For press.' },
  },
  additionalProperties: false,
};

export function browserAct(browsers: Browsers): Capability<ActInput, ActResult> {
  return {
    name: 'browser.act',
    adapter: 'platform:browser',
    defaultTier: 2,
    readsOutside: true,
    inputSchema: {
      type: 'object',
      required: ['url', 'steps'],
      properties: {
        url: { type: 'string', maxLength: 2048, description: 'The page the steps are for, as the last reading gave it.' },
        steps: { type: 'array', minItems: 1, maxItems: MAX_STEPS, items: STEP_SCHEMA },
        acceptDialogs: { type: 'boolean', description: 'Answer yes when the page asks "Are you sure?"; it is answered no unless this is set.' },
      },
      additionalProperties: false,
      description: 'Does steps on the page this work read, in order: type into a field, choose from a list, tick or untick '
        + 'a box, click, press a key. Put every step of a form in one call, the button last: the owner is asked once '
        + 'for the whole. Then reads the page again.',
    },
    describe: (input) => ({ moneyCents: 0, urlHost: hostOf(input.url) }),
    summarize: (input) => actSaid(input),
    async execute(input, ctx) {
      checkSteps(input);
      return browsers.act({ companyId: ctx.companyId, taskId: ctx.taskId }, input, ctx.signal);
    },
    // Read back: every step done, and the page after the last read again.
    async verify(input, result) {
      return result.done === input.steps.length && result.stopped === undefined && typeof result.url === 'string';
    },
  };
}

export function browserCapabilities(browsers: Browsers): Array<Capability<never, never>> {
  return [browserRead(browsers) as unknown as Capability<never, never>, browserAct(browsers) as unknown as Capability<never, never>];
}
