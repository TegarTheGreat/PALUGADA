/**
 * The companies' browsers (the analysis of 3 October, §9 P2 item 20).
 *
 * One Chromium for the process, started when a role first needs it and
 * stopped when nobody has for a while; a context of its own for each company
 * -- its own cookies, storage and cache, the isolation Chromium gives a
 * private window -- with its proxy (`egress.ts`) and its cookies brought
 * back from where they are sealed (`cookies.ts`); a tab of its own for each
 * piece of work. A role sees its page and only its page.
 *
 * Reading opens a page by its address, or follows a link from the last
 * reading, and returns the page as `page.ts` reads it. Acting checks that the
 * tab is still on the page the steps were written for, and that each element
 * a step names is the one it says it is, before it does anything; then it
 * types, chooses, ticks, clicks and presses as a person would -- the mouse at
 * the element's middle, the text inserted as typing inserts it -- and reads
 * the page again. A step refused before anything was done refuses the whole;
 * one refused after others were done stops there and says how far it got,
 * which the read-back counts as not done (F8.4).
 *
 * A dialog the page opens is answered no, unless the steps said yes; a
 * window it opens is closed; a file it offers is not downloaded, and a file
 * it asks for is not given. A password is never typed by a role.
 */
import { assertReachable, type ReachableOptions } from '../capabilities/reachable.ts';
import { withControlPlane } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { Cdp } from './cdp.ts';
import { keepable, type CookieStore, type StoredCookie } from './cookies.ts';
import { startEgress, type Egress } from './egress.ts';
import { ELEMENTS_MAX, KEYS, PAGE_SCRIPT, TEXT_MAX, WORLD } from './page.ts';
import { CONVERT_SCRIPT, type ConversionFailure } from './documents.ts';

export interface BrowserSettings {
  /** Chromium, or Chrome. */
  executable: string;
  /** Chromium's own sandbox; on unless the deployment turned it off (`cdp.ts` says when that is needed). */
  sandbox?: boolean;
  /** Where a page may go: the rules `web.fetch` is held to. */
  reachable?: ReachableOptions;
  cookies: CookieStore;
  /** How many companies' browsers are open at once; another's work closes the one least lately used. */
  maxCompanies?: number;
  /** A tab, a company's browser and Chromium itself are closed after this long unused. */
  idleMs?: number;
  /**
   * The folder holding pdf.js (`pdf.min.mjs` and `pdf.worker.min.mjs`), which
   * the console's build puts in `console/dist/reader`; without it, a PDF is
   * not read (`convert`).
   */
  reader?: string;
  viewport?: { width: number; height: number };
}

export interface PageElement {
  /** What a step names it by, good until the page is read again. */
  ref: string;
  kind: 'link' | 'button' | 'field' | 'choice' | 'checkbox' | 'radio';
  name: string;
  href?: string;
  value?: string;
  /** A password field, whose value is never read. */
  password?: boolean;
  options?: string[];
  checked?: boolean;
  disabled?: boolean;
}

export interface Dialog {
  kind: string;
  message: string;
  accepted: boolean;
}

export interface PageReading {
  url: string;
  title: string;
  text: string;
  elements: PageElement[];
  /** How many more things there were to use than a reading lists. */
  moreElements?: number;
  /** What the page asked while it was read, and the answer it was given. */
  dialogs?: Dialog[];
}

export const STEP_KINDS = ['click', 'type', 'choose', 'tick', 'untick', 'press'] as const;

export interface ActStep {
  do: typeof STEP_KINDS[number];
  ref?: string;
  /** The element's name as the reading gave it: the step is refused if the ref now names something else. */
  name?: string;
  text?: string;
  option?: string;
  key?: string;
}

export interface ActInput {
  /** The page the steps are for, as the reading gave it. */
  url: string;
  steps: ActStep[];
  /** Answer yes to a dialog the page opens -- "Are you sure?" -- rather than no. */
  acceptDialogs?: boolean;
}

export interface ActResult extends PageReading {
  /** How many of the steps were done. */
  done: number;
  of: number;
  /** Why the steps stopped before the last, when they did. */
  stopped?: string;
  dialogs: Dialog[];
}

/** A tab as the owner sees it: whose it is, and where it is. */
export interface TabView {
  /** Chromium's id for it, which the owner names it by. */
  id: string;
  /** The work it is, or null for the owner's own. */
  taskId: string | null;
  url: string;
  title: string;
}

/** What the owner sends a tab while they hold the browser: where they pressed, scrolled or typed on its picture. */
export type OwnerInput =
  | { kind: 'click'; x: number; y: number }
  | { kind: 'scroll'; dy: number; dx?: number; x?: number; y?: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string };

export interface Screen {
  /** The tab's picture, JPEG, base64. */
  image: string;
  url: string;
  title: string;
  width: number;
  height: number;
}

/** A page's text without what is around it, as `extract` reads it. */
export interface ArticleReading {
  url: string;
  title: string;
  text: string;
  /** How many characters there were beyond the most asked for. */
  more: number;
}

/** The owner's own tab, apart from any work's. */
const OWNER_TAB = 'owner';

/** Pages `extract` reads at once; each is a context of its own while it does. */
const EXTRACTS_AT_ONCE = 4;

/** Documents `convert` reads at once, and how long one may take. */
const CONVERSIONS_AT_ONCE = 2;
const CONVERT_MS = 60_000;

/** What `convert` reads: a PDF, a Word document, an Excel workbook. */
export type DocumentKind = 'pdf' | 'word' | 'excel';

export const MAX_STEPS = 20;
const TABS_PER_COMPANY = 8;
const NAVIGATE_MS = 30_000;

interface Tab {
  key: string;
  taskId: string;
  targetId: string;
  sessionId: string;
  frameId: string;
  /** The page script's world in the current document, once it exists. */
  world: number | null;
  loading: boolean;
  /** Whether a page has ever been opened in it. */
  opened: boolean;
  lastUsed: number;
  busy: number;
  dialogs: Dialog[];
  acceptDialogs: boolean;
  wake: Set<() => void>;
}

interface Context {
  companyId: string;
  id: string;
  tabs: Map<string, Tab>;
  lastUsed: number;
  busy: number;
  /** The cookies as last sealed, to seal again only what changed. */
  saved: string;
  saving: Promise<unknown>;
  acceptLanguage: string;
  locale: string;
  timezone: string | null;
}

function normal(text: string | undefined): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function withoutHash(url: string): string {
  const at = url.indexOf('#');
  return at < 0 ? url : url.slice(0, at);
}

function stale(ref: string, step?: number): PalugadaError {
  return new PalugadaError('contract.violation',
    `${step ? `step ${step}: ` : ''}${ref} is not on the page any more: read the page again`, { ref });
}

/** What a site is told the company reads, from the language it works in. */
function languageOf(tag: string | null): { header: string; locale: string } {
  const lang = tag ?? 'en';
  const base = lang.split('-')[0]!;
  const parts = [lang];
  if (base !== lang) parts.push(`${base};q=0.9`);
  if (base !== 'en') parts.push('en;q=0.8');
  return { header: parts.join(','), locale: lang };
}

/** The steps, held to their shape before any page is touched. */
export function checkSteps(input: ActInput): void {
  const wrong = (message: string, step?: number) => new PalugadaError('contract.violation',
    `${step ? `step ${step}: ` : ''}${message}`, { field: 'steps' });
  if (typeof input.url !== 'string' || !/^https?:\/\//i.test(input.url)) throw wrong('url is the page the steps are for, as the reading gave it');
  if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > MAX_STEPS) {
    throw wrong(`steps are 1 to ${MAX_STEPS}`);
  }
  input.steps.forEach((step, index) => {
    const n = index + 1;
    if (!STEP_KINDS.includes(step.do)) throw wrong(`do is one of ${STEP_KINDS.join(', ')}`, n);
    if (step.ref !== undefined || step.do !== 'press') {
      if (typeof step.ref !== 'string' || !/^e\d{1,4}$/.test(step.ref)) throw wrong('ref is one the reading gave, such as e4', n);
      if (typeof step.name !== 'string' || !step.name.trim()) throw wrong('name is the element\'s name as the reading gave it', n);
    }
    if (step.do === 'type' && (typeof step.text !== 'string' || step.text.length > 5_000)) throw wrong('text is what to type, at most 5000 characters', n);
    if (step.do === 'choose' && (typeof step.option !== 'string' || !step.option.trim())) throw wrong('option is the one to choose, as the reading listed it', n);
    if (step.do === 'press' && !(typeof step.key === 'string' && step.key in KEYS)) throw wrong(`key is one of ${Object.keys(KEYS).join(', ')}`, n);
  });
}

export class Browsers {
  readonly #settings: BrowserSettings;
  #cdp: Cdp | null = null;
  #egress: Egress | null = null;
  #userAgent = '';
  #starting: Promise<void> | null = null;
  readonly #contexts = new Map<string, Context>();
  readonly #opening = new Map<string, Promise<Context>>();
  readonly #sessions = new Map<string, Tab>();
  readonly #queues = new Map<string, Promise<void>>();
  /** The contexts `extract` made, each for one reading. */
  readonly #readers = new Set<string>();
  #extracting = 0;
  #converting = 0;
  /** pdf.js, read once from `reader`, as the page imports it; null when it is not there. */
  #pdfjs: Promise<{ lib: string; worker: string } | null> | null = null;
  readonly #reaper: NodeJS.Timeout;
  #lastUsed = Date.now();
  #closed = false;

  constructor(settings: BrowserSettings) {
    this.#settings = settings;
    this.#reaper = setInterval(() => { void this.#reap().catch(() => undefined); }, 30_000);
    this.#reaper.unref();
  }

  get #idleMs(): number {
    return this.#settings.idleMs ?? 10 * 60_000;
  }

  /* ------------------------------------------------------------ reading --- */

  async read(at: { companyId: string; taskId: string }, input: { url?: string; link?: string }, signal?: AbortSignal): Promise<PageReading> {
    if (input.url !== undefined && input.link !== undefined) {
      throw new PalugadaError('contract.violation', 'name a url or a link, not both', { field: 'link' });
    }
    return this.#withTab(at, async (tab) => {
      let target = input.url;
      if (input.link !== undefined) {
        if (!tab.opened || tab.world === null) throw stale(input.link);
        const found = await this.#call<{ missing?: boolean; href?: string; kind?: string }>(tab, `__palugada.href(${JSON.stringify(input.link)})`);
        if (found.missing) throw stale(input.link);
        if (!found.href) {
          throw new PalugadaError('contract.violation',
            `${input.link} is a ${found.kind}, not a link: using it is a click, which browser.act does`, { field: 'link' });
        }
        target = found.href;
      }
      const since = Date.now();
      if (target !== undefined) {
        await this.#navigate(tab, target, since, signal);
      } else if (!tab.opened) {
        throw new PalugadaError('contract.violation', 'this work has not opened a page yet: name its url', { field: 'url' });
      }
      const reading = await this.#read(tab);
      const refused = this.#egress?.refusalFor(reading.url, since);
      if (refused) {
        throw new PalugadaError('capability.unreachable', `${new URL(reading.url).host} was not opened: ${refused}`, { url: reading.url });
      }
      const dialogs = tab.dialogs.splice(0);
      return dialogs.length > 0 ? { ...reading, dialogs } : reading;
    }, signal);
  }

  async #navigate(tab: Tab, url: string, since: number, signal?: AbortSignal): Promise<void> {
    const vetted = await assertReachable(url, this.#settings.reachable ?? {});
    const cdp = this.#live();
    // Loading is what Chromium says it is: a link within the page loads nothing.
    const answer = await cdp.send<{ errorText?: string }>('Page.navigate', { url: vetted.url.toString() }, tab.sessionId, NAVIGATE_MS);
    tab.opened = true;
    if (answer.errorText) {
      tab.loading = false;
      // Where it was sent last: the address asked for, or where it was redirected.
      const { targetInfo } = await cdp.send<{ targetInfo: { url: string } }>('Target.getTargetInfo', { targetId: tab.targetId });
      const refused = this.#egress?.refusalFor(targetInfo.url, since) ?? this.#egress?.refusalFor(vetted.url.toString(), since);
      throw new PalugadaError('capability.unreachable', refused
        ? `${new URL(targetInfo.url.startsWith('http') ? targetInfo.url : vetted.url.toString()).host} was not opened: ${refused}`
        : `${vetted.url.toString()} could not be opened: ${answer.errorText}`, { url });
    }
    await this.#settle(tab, NAVIGATE_MS, signal);
  }

  async #read(tab: Tab): Promise<PageReading> {
    const reading = await this.#call<PageReading & { moreElements: number }>(tab, `__palugada.read(${TEXT_MAX}, ${ELEMENTS_MAX})`);
    const { moreElements, ...rest } = reading;
    return moreElements > 0 ? { ...rest, moreElements } : rest;
  }

  /**
   * A page's text, read as `web.extract` reads one, in a browser that is
   * nobody's: a context made for this one reading and thrown away after it,
   * so no company's sign-ins go with it and nothing the page left is kept
   * or seen by the next. Its address is held to the same rules as any.
   */
  async extract(at: { companyId: string }, url: string, maxText: number, signal?: AbortSignal): Promise<ArticleReading> {
    if (this.#closed) throw new PalugadaError('capability.unreachable', 'the browser is shutting down', {});
    if (this.#extracting >= EXTRACTS_AT_ONCE) {
      throw new PalugadaError('capability.busy', `the browser is reading ${EXTRACTS_AT_ONCE} pages already; this waits for one of them`,
        { capability: 'web.extract', limit: EXTRACTS_AT_ONCE, notBefore: new Date(Date.now() + 30_000).toISOString() });
    }
    this.#extracting += 1;
    this.#lastUsed = Date.now();
    let context: Context | null = null;
    try {
      const cdp = await this.#ready();
      const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
        proxyServer: this.#egress!.server, proxyBypassList: '<-loopback>', disposeOnDetach: false,
      });
      const locale = await this.#localeOf(at.companyId);
      context = {
        companyId: '', id: browserContextId, tabs: new Map(), lastUsed: Date.now(), busy: 1,
        saved: '[]', saving: Promise.resolve(), ...locale,
      };
      this.#readers.add(browserContextId);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
      const tab = await this.#tab(context, 'extract', `extract/${browserContextId}`);
      const since = Date.now();
      await this.#navigate(tab, url, since, signal);
      const page = await this.#call<ArticleReading>(tab, `__palugada.article(${Math.max(1, Math.floor(maxText))})`);
      const refused = this.#egress?.refusalFor(page.url, since);
      if (refused) {
        throw new PalugadaError('capability.unreachable', `${new URL(page.url).host} was not opened: ${refused}`, { url: page.url });
      }
      return page;
    } finally {
      if (context) {
        for (const tab of context.tabs.values()) this.#sessions.delete(tab.sessionId);
        this.#readers.delete(context.id);
        await this.#cdp?.send('Target.disposeBrowserContext', { browserContextId: context.id }).catch(() => undefined);
      }
      this.#extracting -= 1;
      this.#lastUsed = Date.now();
    }
  }

  /**
   * A document's text, read in a page of a context made for it, set offline
   * and disposed of after (`documents.ts` says why it is read there and not
   * here). The answer is the text, or why there is none, which the caller
   * says with the file's name.
   */
  async convert(kind: DocumentKind, bytes: Buffer, signal?: AbortSignal): Promise<{ text: string } | { failure: ConversionFailure | 'no-reader' }> {
    if (this.#closed) throw new PalugadaError('capability.unreachable', 'the browser is shutting down', {});
    const libraries = kind === 'pdf' ? await this.#pdfLibraries() : null;
    if (kind === 'pdf' && !libraries) return { failure: 'no-reader' };
    if (this.#converting >= CONVERSIONS_AT_ONCE) {
      throw new PalugadaError('capability.busy', `the browser is reading ${CONVERSIONS_AT_ONCE} documents already; this waits for one of them`,
        { capability: 'files.read', limit: CONVERSIONS_AT_ONCE, notBefore: new Date(Date.now() + 30_000).toISOString() });
    }
    if (signal?.aborted) throw signal.reason ?? new Error('the work was stopped');
    this.#converting += 1;
    this.#lastUsed = Date.now();
    let contextId: string | null = null;
    const dispose = async () => {
      if (!contextId) return;
      const id = contextId;
      contextId = null;
      this.#readers.delete(id);
      await this.#cdp?.send('Target.disposeBrowserContext', { browserContextId: id }).catch(() => undefined);
    };
    const stop = () => { void dispose(); };
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const cdp = await this.#ready();
      ({ browserContextId: contextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
        proxyServer: this.#egress!.server, proxyBypassList: '<-loopback>', disposeOnDetach: false,
      }));
      this.#readers.add(contextId!);
      await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId: contextId });
      const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: contextId });
      const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
      // Offline as well as behind the proxy: a document has nothing to fetch.
      await cdp.send('Network.enable', {}, sessionId);
      await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
      const expression = `(${CONVERT_SCRIPT})(${JSON.stringify(kind)}, ${JSON.stringify(bytes.toString('base64'))}, ${JSON.stringify(libraries)})`;
      let answer: { result: { value?: unknown } };
      try {
        answer = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId, CONVERT_MS);
      } catch (failure) {
        if (signal?.aborted) throw signal.reason ?? failure;
        if (/did not answer/.test((failure as Error).message)) return { failure: 'too-slow' };
        throw failure;
      }
      const value = answer.result.value as { text?: unknown; failure?: unknown } | undefined;
      if (typeof value?.text === 'string') return { text: value.text };
      return { failure: (typeof value?.failure === 'string' ? value.failure : 'unreadable') as ConversionFailure };
    } finally {
      signal?.removeEventListener('abort', stop);
      await dispose();
      this.#converting -= 1;
      this.#lastUsed = Date.now();
    }
  }

  async #pdfLibraries(): Promise<{ lib: string; worker: string } | null> {
    this.#pdfjs ??= (async () => {
      if (!this.#settings.reader) return null;
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      try {
        const [lib, worker] = await Promise.all(['pdf.min.mjs', 'pdf.worker.min.mjs'].map((name) => readFile(join(this.#settings.reader!, name))));
        return { lib: lib!.toString('base64'), worker: worker!.toString('base64') };
      } catch {
        return null;
      }
    })();
    return this.#pdfjs;
  }

  /* ------------------------------------------------------------- acting --- */

  async act(at: { companyId: string; taskId: string }, input: ActInput, signal?: AbortSignal): Promise<ActResult> {
    checkSteps(input);
    return this.#withTab(at, async (tab) => {
      const cdp = this.#live();
      const { targetInfo } = await cdp.send<{ targetInfo: { url: string } }>('Target.getTargetInfo', { targetId: tab.targetId });
      if (!tab.opened || withoutHash(targetInfo.url) !== withoutHash(input.url)) {
        throw new PalugadaError('contract.violation',
          `the page is now ${tab.opened ? targetInfo.url : 'not open'}, not ${input.url}: read it again before acting on it`, { field: 'url' });
      }
      tab.dialogs = [];
      tab.acceptDialogs = input.acceptDialogs === true;
      let done = 0;
      let stopped: string | undefined;
      try {
        for (const [index, step] of input.steps.entries()) {
          if (signal?.aborted) throw signal.reason ?? new Error('the work was stopped');
          const refusal = await this.#step(tab, step, index + 1);
          if (refusal) {
            // Nothing done yet: the whole is refused. Something done: it
            // stops here and says how far it got.
            if (done === 0) throw new PalugadaError('contract.violation', refusal, { step: index + 1 });
            stopped = refusal;
            break;
          }
          done += 1;
          await this.#settle(tab, NAVIGATE_MS, signal);
        }
      } finally {
        tab.acceptDialogs = false;
      }
      const reading = await this.#read(tab);
      return { ...reading, done, of: input.steps.length, ...(stopped ? { stopped } : {}), dialogs: tab.dialogs.splice(0) };
    }, signal);
  }

  /** One step; null when it was done, else why it was not. */
  async #step(tab: Tab, step: ActStep, n: number): Promise<string | null> {
    const cdp = this.#live();
    if (step.do === 'press' && step.ref === undefined) {
      await this.#press(tab, step.key!);
      return null;
    }
    const ref = step.ref!;
    const state = await this.#call<PageElement & { missing?: boolean }>(tab, `__palugada.check(${JSON.stringify(ref)})`);
    if (state.missing) return stale(ref, n).message;
    if (normal(state.name) !== normal(step.name)) return `step ${n}: ${ref} is "${state.name}", not "${step.name}": read the page again`;
    if (state.disabled) return `step ${n}: "${state.name}" cannot be used now: the page has it switched off`;
    switch (step.do) {
      case 'click':
        return this.#click(tab, ref, state.name, n);
      case 'type': {
        if (state.kind !== 'field') return `step ${n}: "${state.name}" is a ${state.kind}, not a field to type in`;
        if (state.password) return `step ${n}: "${state.name}" is a password, which a role never types: the owner signs in themselves`;
        const focused = await this.#call<{ missing?: boolean }>(tab, `__palugada.focus(${JSON.stringify(ref)})`);
        if (focused.missing) return stale(ref, n).message;
        await cdp.send('Input.insertText', { text: step.text ?? '' }, tab.sessionId);
        await this.#call(tab, `__palugada.changed(${JSON.stringify(ref)})`);
        return null;
      }
      case 'choose': {
        if (state.kind !== 'choice') {
          return `step ${n}: "${state.name}" is a ${state.kind}, not a list to choose from; a list the page draws itself is clicked open, then its option clicked`;
        }
        const chosen = await this.#call<{ missing?: boolean; options?: string[] }>(tab,
          `__palugada.choose(${JSON.stringify(ref)}, ${JSON.stringify(step.option)})`);
        if (chosen.missing) return stale(ref, n).message;
        if (chosen.options) return `step ${n}: "${state.name}" has no option "${step.option}"; its options are ${chosen.options.join(', ')}`;
        return null;
      }
      case 'tick':
      case 'untick': {
        if (state.kind !== 'checkbox' && state.kind !== 'radio') return `step ${n}: "${state.name}" is a ${state.kind}, not a box to tick`;
        const wanted = step.do === 'tick';
        if (state.checked === wanted) return null;
        if (!wanted && state.kind === 'radio') return `step ${n}: "${state.name}" is one of several choices; another is ticked instead`;
        const clicked = await this.#click(tab, ref, state.name, n);
        if (clicked) return clicked;
        const after = await this.#call<PageElement & { missing?: boolean }>(tab, `__palugada.check(${JSON.stringify(ref)})`);
        return after.missing || after.checked === wanted ? null : `step ${n}: "${state.name}" did not change when it was clicked`;
      }
      case 'press': {
        const focused = await this.#call<{ missing?: boolean }>(tab, `__palugada.focus(${JSON.stringify(ref)})`);
        if (focused.missing) return stale(ref, n).message;
        await this.#press(tab, step.key!);
        return null;
      }
    }
    return null;
  }

  async #click(tab: Tab, ref: string, name: string, n: number): Promise<string | null> {
    const cdp = this.#live();
    const point = await this.#call<{ missing?: boolean; hidden?: boolean; covered?: string; x?: number; y?: number }>(tab,
      `__palugada.point(${JSON.stringify(ref)})`);
    if (point.missing) return stale(ref, n).message;
    if (point.hidden) return `step ${n}: "${name}" is not shown on the page`;
    if (point.covered) return `step ${n}: "${name}" is covered by "${point.covered}": that is closed first`;
    const at = { x: point.x!, y: point.y! };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, tab.sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }, tab.sessionId);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, tab.sessionId);
    return null;
  }

  async #press(tab: Tab, name: string): Promise<void> {
    const cdp = this.#live();
    const key = KEYS[name]!;
    const common = { key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode, nativeVirtualKeyCode: key.keyCode };
    await cdp.send('Input.dispatchKeyEvent', key.text
      ? { type: 'keyDown', ...common, text: key.text, unmodifiedText: key.text }
      : { type: 'rawKeyDown', ...common }, tab.sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common }, tab.sessionId);
  }

  /* ------------------------------------------------------- the owner's --- */

  /** The company's tabs in this process, without starting anything. */
  async tabs(companyId: string): Promise<TabView[]> {
    const context = this.#contexts.get(companyId);
    const cdp = this.#cdp;
    if (!context || !cdp || cdp.closed) return [];
    const views: TabView[] = [];
    for (const tab of context.tabs.values()) {
      const info = await cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: tab.targetId })
        .catch(() => null);
      if (!info) continue;
      views.push({ id: tab.targetId, taskId: tab.taskId === OWNER_TAB ? null : tab.taskId, url: info.targetInfo.url, title: info.targetInfo.title });
    }
    return views;
  }

  #tabById(companyId: string, tabId: string): Tab {
    const tab = [...(this.#contexts.get(companyId)?.tabs.values() ?? [])].find((one) => one.targetId === tabId);
    if (!tab) throw new PalugadaError('contract.violation', 'that tab is not open any more', { tabId });
    return tab;
  }

  /** A tab's picture, as it is now. */
  async screen(companyId: string, tabId: string): Promise<Screen> {
    const tab = this.#tabById(companyId, tabId);
    const cdp = this.#live();
    const { data } = await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, tab.sessionId);
    const { targetInfo } = await cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: tab.targetId });
    const viewport = this.#settings.viewport ?? { width: 1280, height: 800 };
    return { image: data, url: targetInfo.url, title: targetInfo.title, ...viewport };
  }

  /** Opens a page for the owner: in a work's tab, or in their own, under the same rules as any page. */
  async open(companyId: string, url: string, tabId?: string): Promise<TabView> {
    const taskId = tabId ? this.#tabById(companyId, tabId).taskId : OWNER_TAB;
    return this.#withTab({ companyId, taskId }, async (tab) => {
      await this.#navigate(tab, url, Date.now());
      const { targetInfo } = await this.#live().send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: tab.targetId });
      return { id: tab.targetId, taskId: taskId === OWNER_TAB ? null : taskId, url: targetInfo.url, title: targetInfo.title };
    });
  }

  /** What the owner pressed, scrolled or typed on a tab's picture, done on the tab. */
  async input(companyId: string, tabId: string, input: OwnerInput): Promise<void> {
    const viewport = this.#settings.viewport ?? { width: 1280, height: 800 };
    const onPage = (x: unknown, y: unknown) => typeof x === 'number' && typeof y === 'number'
      && x >= 0 && y >= 0 && x < viewport.width && y < viewport.height;
    switch (input.kind) {
      case 'click':
        if (!onPage(input.x, input.y)) {
          throw new PalugadaError('contract.violation',
            `a click is a point on the page: x from 0 to ${viewport.width - 1}, y from 0 to ${viewport.height - 1}`, { field: 'x' });
        }
        break;
      case 'scroll':
        if (typeof input.dy !== 'number' || Math.abs(input.dy) > 10_000 || (input.dx !== undefined && Math.abs(input.dx) > 10_000)) {
          throw new PalugadaError('contract.violation', 'a scroll is dy, and dx, in pixels, at most 10000 either way', { field: 'dy' });
        }
        break;
      case 'key':
        if (!(typeof input.key === 'string' && input.key in KEYS)) {
          throw new PalugadaError('contract.violation', `a key is one of ${Object.keys(KEYS).join(', ')}`, { field: 'key' });
        }
        break;
      case 'text':
        if (typeof input.text !== 'string' || input.text.length === 0 || input.text.length > 1_000) {
          throw new PalugadaError('contract.violation', 'text is 1 to 1000 characters', { field: 'text' });
        }
        break;
      default:
        throw new PalugadaError('contract.violation', 'an input is a click, a scroll, a key or text', { field: 'kind' });
    }
    const { taskId } = this.#tabById(companyId, tabId);
    await this.#withTab({ companyId, taskId }, async (tab) => {
      const cdp = this.#live();
      if (input.kind === 'click') {
        const at = { x: input.x, y: input.y };
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at }, tab.sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, button: 'left', buttons: 1, clickCount: 1 }, tab.sessionId);
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, button: 'left', buttons: 0, clickCount: 1 }, tab.sessionId);
      } else if (input.kind === 'scroll') {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel', x: onPage(input.x, input.y) ? input.x : viewport.width / 2, y: onPage(input.x, input.y) ? input.y : viewport.height / 2,
          deltaX: input.dx ?? 0, deltaY: input.dy,
        }, tab.sessionId);
      } else if (input.kind === 'key') {
        await this.#press(tab, input.key);
      } else {
        await cdp.send('Input.insertText', { text: input.text }, tab.sessionId);
      }
      // What the input started -- a form sent, a page opened -- a moment to begin.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await this.#until(tab, () => !tab.loading, 10_000);
    });
  }

  /** The owner is done: what they signed in to is sealed, and their own tab closed. */
  async ownerDone(companyId: string): Promise<void> {
    const context = this.#contexts.get(companyId);
    if (!context) return;
    await this.#save(context).catch(() => undefined);
    await context.saving;
    const own = context.tabs.get(OWNER_TAB);
    if (own && own.busy === 0) await this.#closeTab(context, own);
  }

  /* ----------------------------------------------------- the page itself --- */

  /** Runs an expression in the page script's world; once more if the document changed under it. */
  async #call<T>(tab: Tab, expression: string): Promise<T> {
    const cdp = this.#live();
    for (let attempt = 0; ; attempt += 1) {
      if (tab.world === null) await this.#until(tab, () => tab.world !== null, 5_000);
      if (tab.world === null) throw new PalugadaError('capability.unreachable', 'the page did not finish opening', {});
      try {
        const answer = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
          'Runtime.evaluate', { expression, contextId: tab.world, returnByValue: true }, tab.sessionId);
        if (answer.exceptionDetails) {
          throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
        }
        return answer.result.value;
      } catch (failure) {
        if (attempt === 0 && /context/i.test((failure as Error).message)) {
          tab.world = null;
          await this.#settle(tab, NAVIGATE_MS);
          continue;
        }
        throw failure;
      }
    }
  }

  /** Waits for the page to stop loading and its script to be there. */
  async #settle(tab: Tab, ms: number, signal?: AbortSignal): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 120));
    await this.#until(tab, () => !tab.loading, ms, signal);
    await this.#until(tab, () => tab.world !== null, 5_000, signal);
    // A page that draws itself after it loads -- most of them now -- a moment to.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async #until(tab: Tab, ready: () => boolean, ms: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (!ready()) {
      if (signal?.aborted) throw signal.reason ?? new Error('the work was stopped');
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          tab.wake.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(left, 250));
        tab.wake.add(done);
      });
    }
    return true;
  }

  /* --------------------------------------------- tabs, contexts, Chromium --- */

  /** One piece of work's tab, one call at a time. */
  async #withTab<T>(at: { companyId: string; taskId: string }, work: (tab: Tab) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) throw new PalugadaError('capability.unreachable', 'the browser is shutting down', {});
    const key = `${at.companyId}/${at.taskId}`;
    const before = this.#queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mine = before.then(() => gate, () => gate);
    this.#queues.set(key, mine);
    await before.catch(() => undefined);
    try {
      const context = await this.#context(at.companyId);
      try {
        const tab = await this.#tab(context, at.taskId, key);
        tab.busy += 1;
        try {
          if (signal?.aborted) throw signal.reason ?? new Error('the work was stopped');
          return await work(tab);
        } finally {
          tab.busy -= 1;
          tab.lastUsed = Date.now();
          await this.#save(context).catch(() => undefined);
        }
      } finally {
        context.busy -= 1;
        context.lastUsed = Date.now();
        this.#lastUsed = Date.now();
      }
    } finally {
      release();
      if (this.#queues.get(key) === mine) this.#queues.delete(key);
    }
  }

  #live(): Cdp {
    if (!this.#cdp || this.#cdp.closed) throw new PalugadaError('capability.unreachable', 'the browser stopped', {});
    return this.#cdp;
  }

  async #ready(): Promise<Cdp> {
    if (this.#cdp && !this.#cdp.closed) return this.#cdp;
    this.#starting ??= (async () => {
      this.#egress ??= await startEgress(this.#settings.reachable ?? {});
      const cdp = await Cdp.launch(this.#settings.executable, { sandbox: this.#settings.sandbox !== false });
      this.#listen(cdp);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      const version = await cdp.send<{ userAgent: string }>('Browser.getVersion');
      // Chromium without a window says so in its user agent, and sites turn
      // it away for that alone; it is the same browser either way.
      this.#userAgent = version.userAgent.replace('HeadlessChrome', 'Chrome');
      this.#cdp = cdp;
    })().finally(() => { this.#starting = null; });
    await this.#starting;
    return this.#live();
  }

  #listen(cdp: Cdp): void {
    const tabOf = (sessionId: string | undefined) => (sessionId ? this.#sessions.get(sessionId) : undefined);
    const wake = (tab: Tab) => { for (const one of [...tab.wake]) one(); };
    cdp.on('Page.frameStartedLoading', (params, sessionId) => {
      const tab = tabOf(sessionId);
      if (tab && params.frameId === tab.frameId) { tab.loading = true; wake(tab); }
    });
    cdp.on('Page.frameStoppedLoading', (params, sessionId) => {
      const tab = tabOf(sessionId);
      if (tab && params.frameId === tab.frameId) { tab.loading = false; wake(tab); }
    });
    cdp.on('Page.frameNavigated', (params, sessionId) => {
      const tab = tabOf(sessionId);
      const frame = params.frame as { id: string; parentId?: string };
      if (tab && !frame.parentId) { tab.frameId = frame.id; wake(tab); }
    });
    cdp.on('Runtime.executionContextCreated', (params, sessionId) => {
      const tab = tabOf(sessionId);
      const context = params.context as { id: number; name: string; auxData?: { frameId?: string } };
      if (tab && context.name === WORLD && context.auxData?.frameId === tab.frameId) { tab.world = context.id; wake(tab); }
    });
    cdp.on('Runtime.executionContextDestroyed', (params, sessionId) => {
      const tab = tabOf(sessionId);
      if (tab && params.executionContextId === tab.world) tab.world = null;
    });
    cdp.on('Runtime.executionContextsCleared', (_params, sessionId) => {
      const tab = tabOf(sessionId);
      if (tab) tab.world = null;
    });
    cdp.on('Page.javascriptDialogOpening', (params, sessionId) => {
      const tab = tabOf(sessionId);
      if (!tab) return;
      const kind = String(params.type);
      // Leaving a page the role asked to leave, and an alert, which has only OK.
      const accept = kind === 'beforeunload' || kind === 'alert' || tab.acceptDialogs;
      tab.dialogs.push({ kind, message: String(params.message ?? '').slice(0, 500), accepted: accept });
      void cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId).catch(() => undefined);
    });
    // A window a page opened despite everything is closed.
    cdp.on('Target.targetCreated', (params) => {
      const info = params.targetInfo as { targetId: string; type: string; openerId?: string; browserContextId?: string };
      const ours = [...this.#contexts.values()].some((context) => context.id === info.browserContextId)
        || (info.browserContextId !== undefined && this.#readers.has(info.browserContextId));
      if (info.type === 'page' && info.openerId && ours) void cdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
    });
    const gone = (sessionId: string | undefined) => {
      const tab = tabOf(sessionId);
      if (!tab) return;
      this.#sessions.delete(tab.sessionId);
      for (const context of this.#contexts.values()) {
        if (context.tabs.get(tab.taskId) === tab) context.tabs.delete(tab.taskId);
      }
      tab.world = null;
      wake(tab);
    };
    cdp.on('Inspector.targetCrashed', (_params, sessionId) => gone(sessionId));
    cdp.on('Target.detachedFromTarget', (params) => gone(params.sessionId as string | undefined));
    cdp.on('closed', () => {
      if (this.#cdp !== cdp) return;
      this.#cdp = null;
      this.#contexts.clear();
      this.#sessions.clear();
    });
  }

  /** The company's browser, open; counted as busy until the caller is done with it. */
  async #context(companyId: string): Promise<Context> {
    for (;;) {
      const cdp = await this.#ready();
      const open = this.#contexts.get(companyId);
      if (open) {
        open.busy += 1;
        return open;
      }
      const opening = this.#opening.get(companyId);
      if (opening) {
        await opening.catch(() => undefined);
        continue;
      }
      const made = this.#open(cdp, companyId);
      this.#opening.set(companyId, made);
      try {
        const context = await made;
        context.busy += 1;
        return context;
      } finally {
        this.#opening.delete(companyId);
      }
    }
  }

  async #open(cdp: Cdp, companyId: string): Promise<Context> {
    const limit = Math.max(1, this.#settings.maxCompanies ?? 4);
    const othersOpening = () => [...this.#opening.keys()].filter((id) => id !== companyId).length;
    while (this.#contexts.size + othersOpening() >= limit) {
      const idle = [...this.#contexts.values()].filter((one) => one.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) {
        throw new PalugadaError('capability.busy',
          `the browser has ${limit} companies' pages open, all in use; this waits for one of them`,
          { capability: 'browser', limit, notBefore: new Date(Date.now() + 30_000).toISOString() });
      }
      await this.#closeContext(idle);
    }
    const locale = await this.#localeOf(companyId);
    const { browserContextId } = await cdp.send<{ browserContextId: string }>('Target.createBrowserContext', {
      // Through the proxy, loopback included: Chromium's own exception for
      // it is taken away with `<-loopback>`.
      proxyServer: this.#egress!.server, proxyBypassList: '<-loopback>', disposeOnDetach: false,
    });
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
    const cookies = await this.#settings.cookies.load(companyId);
    await this.#restore(cdp, browserContextId, cookies);
    const context: Context = {
      companyId, id: browserContextId, tabs: new Map(), lastUsed: Date.now(), busy: 0,
      saved: JSON.stringify(keepable(cookies)), saving: Promise.resolve(), ...locale,
    };
    this.#contexts.set(companyId, context);
    return context;
  }

  /** What a site is told of the company: the language it works in and where its day is. */
  async #localeOf(companyId: string): Promise<Pick<Context, 'acceptLanguage' | 'locale' | 'timezone'>> {
    const { rows: [company] } = await withControlPlane((tx) => tx.query<{ work_language: string | null; timezone: string | null }>(
      'SELECT work_language, timezone FROM companies WHERE id = $1', [companyId]));
    const language = languageOf(company?.work_language ?? null);
    return { acceptLanguage: language.header, locale: language.locale, timezone: company?.timezone ?? null };
  }

  /** Cookies back into a context; one Chromium will not take is left out rather than losing the rest. */
  async #restore(cdp: Cdp, browserContextId: string, cookies: StoredCookie[]): Promise<void> {
    if (cookies.length === 0) return;
    try {
      await cdp.send('Storage.setCookies', { cookies, browserContextId });
    } catch {
      for (const cookie of cookies) await cdp.send('Storage.setCookies', { cookies: [cookie], browserContextId }).catch(() => undefined);
    }
  }

  async #tab(context: Context, taskId: string, key: string): Promise<Tab> {
    const open = context.tabs.get(taskId);
    if (open) return open;
    const cdp = this.#live();
    if (context.tabs.size >= TABS_PER_COMPANY) {
      const idle = [...context.tabs.values()].filter((one) => one.busy === 0).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (idle) await this.#closeTab(context, idle);
    }
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', browserContextId: context.id });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const tab: Tab = {
      key, taskId, targetId, sessionId, frameId: '', world: null, loading: false, opened: false,
      lastUsed: Date.now(), busy: 0, dialogs: [], acceptDialogs: false, wake: new Set(),
    };
    this.#sessions.set(sessionId, tab);
    const viewport = this.#settings.viewport ?? { width: 1280, height: 800 };
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PAGE_SCRIPT, worldName: WORLD }, sessionId);
    // Files are neither given to a page that asks for one nor taken from one that offers it.
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId).catch(() => undefined);
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false }, sessionId);
    // A page behaves as the one in front: a tab in the background is not
    // given focus, and a field marked to take it would not.
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => undefined);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: this.#userAgent, acceptLanguage: context.acceptLanguage, platform: 'Linux x86_64',
    }, sessionId);
    await cdp.send('Emulation.setLocaleOverride', { locale: context.locale }, sessionId).catch(() => undefined);
    if (context.timezone) await cdp.send('Emulation.setTimezoneOverride', { timezoneId: context.timezone }, sessionId).catch(() => undefined);
    const { frameTree } = await cdp.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree', {}, sessionId);
    tab.frameId = frameTree.frame.id;
    context.tabs.set(taskId, tab);
    return tab;
  }

  async #save(context: Context): Promise<void> {
    const cdp = this.#cdp;
    if (!cdp || cdp.closed || this.#contexts.get(context.companyId) !== context) return;
    const { cookies } = await cdp.send<{ cookies: Array<StoredCookie & { session?: boolean; size?: number }> }>(
      'Storage.getCookies', { browserContextId: context.id });
    const kept = keepable(cookies);
    const text = JSON.stringify(kept);
    if (text === context.saved) return;
    const saving = context.saving.then(async () => {
      if (await this.#settings.cookies.save(context.companyId, kept)) context.saved = text;
    });
    context.saving = saving.catch(() => undefined);
    await saving;
  }

  async #closeTab(context: Context, tab: Tab): Promise<void> {
    context.tabs.delete(tab.taskId);
    this.#sessions.delete(tab.sessionId);
    await this.#cdp?.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
  }

  async #closeContext(context: Context): Promise<void> {
    await this.#save(context).catch(() => undefined);
    await context.saving;
    this.#contexts.delete(context.companyId);
    for (const tab of context.tabs.values()) this.#sessions.delete(tab.sessionId);
    await this.#cdp?.send('Target.disposeBrowserContext', { browserContextId: context.id }).catch(() => undefined);
  }

  /** Closes what nobody has used for a while: tabs, then companies' browsers, then Chromium. */
  async #reap(): Promise<void> {
    const now = Date.now();
    for (const context of [...this.#contexts.values()]) {
      for (const tab of [...context.tabs.values()]) {
        if (tab.busy === 0 && now - tab.lastUsed > this.#idleMs) await this.#closeTab(context, tab);
      }
      if (context.busy === 0 && context.tabs.size === 0 && now - context.lastUsed > this.#idleMs) await this.#closeContext(context);
    }
    if (this.#cdp && this.#contexts.size === 0 && this.#opening.size === 0 && this.#extracting === 0 && this.#converting === 0
      && now - this.#lastUsed > this.#idleMs) {
      const cdp = this.#cdp;
      this.#cdp = null;
      await cdp.close();
    }
  }

  /** Seals every company's cookies, and stops Chromium and the proxy. */
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#reaper);
    await this.#starting?.catch(() => undefined);
    for (const context of [...this.#contexts.values()]) await this.#closeContext(context);
    const cdp = this.#cdp;
    this.#cdp = null;
    await cdp?.close();
    await this.#egress?.close();
    this.#egress = null;
  }
}
