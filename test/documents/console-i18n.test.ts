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
import { ID } from '../../console/src/locales/id.ts';

const SRC = fileURLToPath(new URL('../../console/src', import.meta.url));

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

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
}

test('every sentence the console draws has a translation in every language it offers', async () => {
  const wanted = new Set<string>();
  for (const source of (await sources()).values()) for (const sentence of sentencesIn(source)) wanted.add(sentence);
  assert.ok(wanted.size > 300, `only ${wanted.size} sentences were found; the scan is broken`);

  const missing = [...wanted].filter((sentence) => ID[sentence] === undefined);
  assert.deepEqual(missing, [], 'sentences with no Indonesian');

  const unused = Object.keys(ID).filter((key) => !wanted.has(key));
  assert.deepEqual(unused, [], 'Indonesian for sentences the console no longer says');

  for (const [english, indonesian] of Object.entries(ID)) {
    assert.deepEqual(placeholders(indonesian), placeholders(english), `"${english}" and its translation name different values`);
    assert.ok(indonesian.trim().length > 0, `"${english}" is translated as nothing`);
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
