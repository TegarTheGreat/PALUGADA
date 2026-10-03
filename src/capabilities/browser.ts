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
import { PalugadaError } from '../errors.ts';
import { askOwner } from '../inbox/inbox.ts';
import { assertNotHeld } from '../browser/holds.ts';
import { checkSteps, MAX_STEPS, STEP_KINDS, type ActInput, type ActResult, type ActStep, type Browsers, type PageReading } from '../browser/browsers.ts';
import { KEYS } from '../browser/page.ts';
import { EXTRACT_SCHEMA, extractDescribed, MAX_PAGE_CHARS, type ExtractInput, type ExtractOutput } from './search.ts';

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
    async execute(input, ctx) {
      await assertNotHeld(ctx.companyId, 'browser.read');
      return browsers.read({ companyId: ctx.companyId, taskId: ctx.taskId }, input, ctx.signal);
    },
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
      await assertNotHeld(ctx.companyId, 'browser.act');
      return browsers.act({ companyId: ctx.companyId, taskId: ctx.taskId }, input, ctx.signal);
    },
    // Read back: every step done, and the page after the last read again.
    async verify(input, result) {
      return result.done === input.steps.length && result.stopped === undefined && typeof result.url === 'string';
    },
  };
}

/** The longest reason a role gives for handing the browser over. */
const REASON_MAX = 300;

/**
 * `browser.handover`: what a role cannot do on a page -- sign in, type the
 * code a site sent to the owner's phone, answer a puzzle -- it asks the
 * owner to do, as a question whose card opens the company's browser. The
 * work waits; when the owner gives the browser back, the question is
 * answered and the work resumes on the page they left.
 */
export function browserHandover(): Capability<{ reason: string }, { answered: boolean; answer?: string; note?: string }> {
  return {
    name: 'browser.handover',
    adapter: 'platform:browser',
    defaultTier: 0,
    inputSchema: {
      type: 'object',
      required: ['reason'],
      properties: {
        reason: { type: 'string', minLength: 1, maxLength: REASON_MAX, description: 'What the owner is to do on the page, in their language: "Sign in to the seller centre; the code goes to your phone."' },
      },
      additionalProperties: false,
      description: 'Asks the owner to take the company\'s browser over on this work\'s page, for what a role never does: '
        + 'sign in, type a code sent to their phone, answer a puzzle. Waits until they give it back; then read the page again.',
    },
    describe: () => ({ moneyCents: 0 }),
    async execute(input, ctx) {
      const reason = String(input.reason ?? '').trim();
      if (!reason || reason.length > REASON_MAX) {
        throw new PalugadaError('contract.violation', `a reason is 1 to ${REASON_MAX} characters: what the owner is to do on the page`, { field: 'reason' });
      }
      const asked = await askOwner({ companyId: ctx.companyId, taskId: ctx.taskId, question: reason, browser: true });
      if (asked.state === 'answered') return { answered: true, answer: asked.answer };
      if (asked.state === 'unanswered') {
        return { answered: false, note: 'The owner closed this without taking the browser over. Carry on without the page, and say what is left.' };
      }
      throw new PalugadaError('owner.asked', 'the owner has been asked to take the browser over; this task waits until they give it back', {
        inboxItemId: asked.inboxItemId,
      });
    },
  };
}

/** Who read the page, as `web.extract` says it. */
const BROWSER_READER = 'This deployment\'s browser';

/**
 * `web.extract` with no reading provider chosen: the page read in this
 * deployment's own browser, in a context made for that one reading
 * (`Browsers.extract`), so the address is not sent to anybody else and no
 * company's sign-ins go with it. What the page's own scripts draw is read,
 * as with a provider; unlike one, the page is reached from this server, so
 * its address is held to the rules `web.fetch` is.
 */
export function webExtractByBrowser(browsers: Browsers): Capability<ExtractInput, ExtractOutput> {
  return {
    name: 'web.extract',
    inputSchema: EXTRACT_SCHEMA,
    adapter: 'extract:browser',
    defaultTier: 0,
    readsOutside: true,
    describe: extractDescribed,
    async execute(input, ctx) {
      const url = String(input.url ?? '');
      if (!/^https?:\/\//.test(url)) throw new PalugadaError('contract.violation', 'web.extract reads an http or https page', { field: 'url' });
      const page = await browsers.extract({ companyId: ctx.companyId }, url, MAX_PAGE_CHARS, ctx.signal);
      if (page.text === '') {
        throw new PalugadaError('capability.unreachable', `${hostOf(page.url) ?? page.url} showed nothing readable`, { url: page.url });
      }
      return { provider: BROWSER_READER, url: page.url, title: page.title || null, text: page.text, truncated: page.more > 0 };
    },
  };
}

export function browserCapabilities(browsers: Browsers): Array<Capability<never, never>> {
  return [
    browserRead(browsers) as unknown as Capability<never, never>,
    browserAct(browsers) as unknown as Capability<never, never>,
    browserHandover() as unknown as Capability<never, never>,
  ];
}
