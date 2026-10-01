/**
 * The console speaks the owner's language, all of it (console/src/i18n.ts).
 *
 * A console that is "translated" except for the one dialog that asks for the
 * authenticator is a console the owner cannot trust to have said what they
 * think it said. So the source is read for every sentence it hands to `t`,
 * `tp` or `N`, and every language offered must have all of them -- with the
 * same `{placeholders}`, because a translation that drops `{amount}` drops the
 * amount. It is also read for English that never went through `t` at all:
 * text between tags, and the props a person reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Dictionary } from '../../console/src/locales/types.ts';

const SRC = fileURLToPath(new URL('../../console/src', import.meta.url));
const LOCALES = join(SRC, 'locales');

async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // The dictionaries are the translations, not the source of sentences.
        if (entry.name !== 'locales') await walk(path, `${prefix}${entry.name}/`);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'));
      }
    }
  };
  await walk(SRC, '');
  return files;
}

const STRING = String.raw`(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")`;

function unescape(raw: string): string {
  return raw.replace(/\\(.)/g, '$1');
}

/** Every sentence the source asks to have translated. */
export function sentencesIn(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(new RegExp(String.raw`\b(?:t|N)\(\s*${STRING}`, 'g'))) {
    found.push(unescape(match[1] ?? match[2] ?? ''));
  }
  for (const match of source.matchAll(new RegExp(String.raw`\btp\(\s*${STRING}\s*,\s*${STRING}`, 'g'))) {
    found.push(unescape(match[1] ?? match[2] ?? ''), unescape(match[3] ?? match[4] ?? ''));
  }
  return found;
}

/** The pairs handed to `tp`: the English for one, and for any other count. */
function pluralsIn(source: string): Array<[string, string]> {
  return [...source.matchAll(new RegExp(String.raw`\btp\(\s*${STRING}\s*,\s*${STRING}`, 'g'))]
    .map((match) => [unescape(match[1] ?? match[2] ?? ''), unescape(match[3] ?? match[4] ?? '')]);
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

interface Offered { code: string; name: string; locale: string }

/** The languages `LANGUAGES` in i18n.ts offers, read from its source. */
function offered(i18n: string): Offered[] {
  return [...i18n.matchAll(/\{ code: '([^']+)', name: '([^']+)', locale: '([^']+)' \}/g)]
    .map((match) => ({ code: match[1]!, name: match[2]!, locale: match[3]! }));
}

/** Every dictionary in the locales folder, by its file's name. */
async function dictionaries(): Promise<Map<string, { dictionary: Dictionary; kept: readonly string[] }>> {
  const found = new Map<string, { dictionary: Dictionary; kept: readonly string[] }>();
  for (const name of (await readdir(LOCALES)).sort()) {
    if (!name.endsWith('.ts') || name === 'types.ts') continue;
    const module = await import(join(LOCALES, name)) as { DICTIONARY?: Dictionary; KEPT?: readonly string[] };
    assert.ok(module.DICTIONARY, `locales/${name} exports no DICTIONARY`);
    assert.ok(Array.isArray(module.KEPT), `locales/${name} exports no KEPT`);
    found.set(name.replace(/\.ts$/, ''), { dictionary: module.DICTIONARY, kept: module.KEPT });
  }
  return found;
}

/** Every form a translation has: one for a string, one per category for plural forms. */
function forms(translation: Dictionary[string]): string[] {
  return typeof translation === 'string' ? [translation] : Object.values(translation);
}

/**
 * The script a language is written in, where it is not Latin: a translation
 * with none of it is English that nobody translated, unless it is kept.
 */
const SCRIPT: Record<string, RegExp> = {
  zh: /\p{Script=Han}/u,
  ru: /\p{Script=Cyrillic}/u,
  hi: /\p{Script=Devanagari}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  th: /\p{Script=Thai}/u,
  ar: /\p{Script=Arabic}/u,
};

/**
 * How much of a dictionary may be kept as English. Names and a few words a
 * language's software uses as they are, not whole screens: Indonesian keeps
 * 43 of some 1,800.
 */
const KEPT_AT_MOST = 0.03;

test('every sentence the console draws has a translation in every language it offers', async () => {
  const files = await sources();
  const wanted = new Set<string>();
  for (const source of files.values()) for (const sentence of sentencesIn(source)) wanted.add(sentence);
  assert.ok(wanted.size > 300, `only ${wanted.size} sentences were found; the scan is broken`);

  const languages = offered(files.get('i18n.ts') ?? '');
  assert.ok(languages.some((one) => one.code === 'en'), 'the scan of LANGUAGES is broken');
  const found = await dictionaries();
  assert.deepEqual([...found.keys()].sort(), languages.filter((one) => one.code !== 'en').map((one) => one.code).sort(),
    'every language offered but English has a dictionary in locales/, and every dictionary there is offered');
  for (const code of found.keys()) {
    assert.match(files.get('i18n.ts') ?? '', new RegExp(`from './locales/${code}\\.ts'`), `i18n.ts does not use locales/${code}.ts`);
  }

  for (const [code, { dictionary, kept }] of found) {
    const missing = [...wanted].filter((sentence) => dictionary[sentence] === undefined);
    assert.deepEqual(missing, [], `sentences with no ${code}`);

    const unused = Object.keys(dictionary).filter((key) => !wanted.has(key));
    assert.deepEqual(unused, [], `${code} for sentences the console no longer says`);

    const script = SCRIPT[code];
    for (const [english, translation] of Object.entries(dictionary)) {
      for (const one of forms(translation)) {
        assert.deepEqual(placeholders(one), placeholders(english), `${code}: "${english}" and its translation name different values`);
        assert.ok(one.trim().length > 0, `${code}: "${english}" is translated as nothing`);
        if (script && !kept.includes(english)) {
          assert.match(one, script, `${code}: "${english}" is translated as "${one}", which is not written in its script`);
        }
      }
      if (translation === english) {
        assert.ok(kept.includes(english), `${code}: "${english}" is left in English; translate it, or list it in KEPT if it is a name`);
      }
    }
    for (const english of kept) {
      assert.equal(typeof dictionary[english], 'string', `${code}: KEPT names "${english}", which the console does not say`);
    }
    assert.ok(kept.length <= Object.keys(dictionary).length * KEPT_AT_MOST,
      `${code} keeps ${kept.length} sentences in English; at most ${Math.round(KEPT_AT_MOST * 100)}% may be`);
  }
});

test('a sentence that depends on a count has every form its language needs', async () => {
  const files = await sources();
  const pairs = new Map<string, string>();
  for (const source of files.values()) for (const [one, other] of pluralsIn(source)) pairs.set(other, one);
  assert.ok(pairs.size >= 10, `only ${pairs.size} plural sentences were found; the scan is broken`);

  // A language's "one" is not always the number 1: Russian says it for 21
  // and 101, Hindi and Portuguese for 0. So the "one" sentence of a pair
  // names the count wherever the other does -- "the run" for 21 runs is
  // wrong in every language whose "one" covers 21. A sentence for exactly
  // one goes through `t` on its own.
  for (const [other, one] of pairs) {
    if (placeholders(other).includes('count')) {
      assert.ok(placeholders(one).includes('count'), `tp("${one}", "${other}"): the first names no {count}, and some languages say it for more than one`);
    }
  }

  const languages = offered(files.get('i18n.ts') ?? '');
  for (const [code, { dictionary }] of await dictionaries()) {
    const rules = new Intl.PluralRules(languages.find((one) => one.code === code)!.locale);
    const categories = new Set<string>(rules.resolvedOptions().pluralCategories);
    // The categories whole counts fall in, for the English "other" sentence:
    // Russian's few and many, and nothing more for a language with one form.
    const counted = new Set(Array.from({ length: 1001 }, (_, n) => rules.select(n)));
    for (const [other, one] of pairs) {
      const needed = [...counted].filter((category) => one === other || category !== 'one');
      const translation = dictionary[other]!;
      if (typeof translation === 'string') {
        assert.ok(needed.length <= 1, `${code}: "${other}" needs the forms ${needed.join(', ')}, and has one`);
        continue;
      }
      for (const category of Object.keys(translation)) {
        assert.ok(categories.has(category), `${code}: "${other}" has a form for ${category}, which the language does not have`);
      }
      for (const category of needed.filter((category) => category !== 'other')) {
        assert.ok(translation[category as Intl.LDMLPluralRule], `${code}: "${other}" has no form for ${category}`);
      }
    }
    for (const [english, translation] of Object.entries(dictionary)) {
      if (typeof translation !== 'string') {
        assert.ok(pairs.has(english), `${code}: "${english}" has plural forms but is not the plural sentence of a tp()`);
      }
    }
  }
});

/**
 * English that went around `t`. A heuristic, and deliberately a narrow one:
 * text between two tags on one line, and the props that are read rather than
 * used. Anything it flags is either a missed sentence or not English -- a
 * slug, an identifier -- and the second kind is excluded by shape.
 */
function strays(path: string, source: string): string[] {
  const found: string[] = [];
  // An identifier, a slug, a command: letters joined by punctuation, or a brand in capitals.
  const code = (text: string) => /^[\w.\-/:@*…]+$/.test(text) && /[._\-/:@*\d]/.test(text);
  const brand = (text: string) => /^[A-Z]{2,}$/.test(text);
  const words = (text: string) => /[A-Za-z]{2,}/.test(text) && !code(text.trim()) && !brand(text.trim());
  // A sentence: a capital, then words; code rarely looks like that.
  const prose = (text: string) => /^[A-Z“"][^<>{}]*\s/.test(text.trim()) && !/=>|&&|\|\|/.test(text);
  const lines = source.split('\n');
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('import ')) return;
    for (const match of line.matchAll(/(?<![=\-])>([^<>{}\n]+)</g)) {
      const body = match[1]!;
      if (!words(body)) continue;
      if (/&&|\|\||=>|[;(){}]|\?/.test(body) && !prose(body)) continue;
      found.push(`${path}:${index + 1} text "${body.trim()}"`);
    }
    // Text on a line of its own, inside an element opened on the line above.
    const above = (lines[index - 1] ?? '').trim();
    if (above.endsWith('>') && !above.startsWith('*') && !above.startsWith('//') && prose(trimmed)
      && !/[<>{}=]/.test(trimmed) && trimmed.split(/\s+/).length >= 2) {
      found.push(`${path}:${index + 1} text "${trimmed}"`);
    }
    for (const match of line.matchAll(/\b(label|description|placeholder|title|action|success|factor|nothingFound|aria-label|hint)="([^"]*)"/g)) {
      if (words(match[2]!)) found.push(`${path}:${index + 1} ${match[1]}="${match[2]}"`);
    }
    for (const match of line.matchAll(/\b(label|description|placeholder|success|message|title|action|factor): '([^']*)'/g)) {
      if (words(match[2]!)) found.push(`${path}:${index + 1} ${match[1]}: '${match[2]}'`);
    }
    // Any other sentence in quotes -- a ternary's branch, an argument -- that
    // is not the argument of `t`, `tp` or `N`. A sentence is a capital and a
    // lower-case word after it; "Inter Variable" and "Kopi Nusantara" are names.
    for (const match of line.matchAll(/(['"])([A-Z][^'"\n]*? [a-z][^'"\n]*)\1/g)) {
      const before = line.slice(0, match.index);
      if (/\b(?:t|N|tp)\(\s*$/.test(before) || /\btp\(\s*(['"])(?:\\.|(?!\1).)*\1\s*,\s*$/.test(before)) continue;
      found.push(`${path}:${index + 1} "${match[2]}"`);
    }
    // A single capitalised word as a ternary's branch: `? 'Paused' : 'Running'`.
    for (const match of line.matchAll(/[?:]\s*(['"])([A-Z][a-z]+(?:-[a-z]+)?)\1/g)) {
      found.push(`${path}:${index + 1} "${match[2]}"`);
    }
    // Words between values between tags: `>{count} capabilities · up to {max} at once<`
    // reads as a sentence and never passed `t`. The values are cut out and
    // what is left is judged; nested braces are code, not text. Only in
    // .tsx, where there is markup: in .ts, `<T>(...) => {...}` is a generic.
    for (const match of path.endsWith('.tsx') ? line.matchAll(/(?<![=\-])>([^<>\n]*\{[^<>\n]*)</g) : []) {
      const outside = match[1]!.replace(/\{[^{}]*\}/g, ' ');
      if (/[{}]/.test(outside) || /=>|&&|\|\|/.test(match[1]!)) continue;
      if ((outside.match(/[A-Za-z]{2,}/g) ?? []).length >= 2) found.push(`${path}:${index + 1} text "${match[1]!.trim()}"`);
    }
    // A lower-case sentence as a ternary's branch: `? 'is unchanged since it was installed.'`.
    for (const match of line.matchAll(/[?:]\s*(['"])([a-z]+(?: [a-z,']+){2,}[.!?]?)\1/g)) {
      found.push(`${path}:${index + 1} "${match[2]}"`);
    }
  });
  return found;
}

test('no English reaches the page without going through the dictionary', async () => {
  const found: string[] = [];
  for (const [path, source] of await sources()) {
    if (path !== 'i18n.ts') found.push(...strays(path, source));
  }
  assert.deepEqual(found, []);
});

test('the language is kept by the deployment, never by the browser', async () => {
  // The console stores nothing in the browser (console-page.test.ts); the
  // choice goes to the owner API and comes back on sign-in.
  const files = await sources();
  const app = files.get('App.tsx') ?? '';
  assert.match(app, /api\('GET', '\/api\/control\/languages'\)/);
  assert.match(app, /api\('POST', '\/api\/control\/languages'/);
});
