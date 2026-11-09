/**
 * Every place that carries outside words into derived work also carries
 * staff words (F8.9, F19.9; STATUS section 2.204).
 *
 * Work made from other work -- run again, followed up, handed on as an
 * escalation, a ticket or a to-do, the weekly meeting, the quarter, the week
 * and the month -- carries the mark that a customer's words were read
 * (`carriesOutside`, or `carriesOutsideFrom` where the context builder finds
 * it late), so its tier 2 action asks the owner. A member of staff's words
 * are the same kind of thing for the same reason: they are not the owner's,
 * and the work made from them must hold at tier 2 as the work they steered
 * did. A site that carries one and forgets the other is how a seat's words
 * become work the owner's standing approval lets through, so the source is
 * read for it.
 *
 * The rule is read per call: the call, or for a declaration the braces, that
 * holds `carriesOutside` or `carriesOutsideFrom` also holds `carriesStaff` or
 * `carriesStaffFrom`. Strings and comments are blanked first, so a sentence
 * that names one does not count as either.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function sources(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.set(relative(ROOT, path), await readFile(path, 'utf8'));
    }
  };
  await walk(join(ROOT, 'src'));
  return found;
}

/**
 * The text with every comment, string and template literal replaced by
 * spaces of the same length, so positions stay where they were and no
 * bracket inside one is counted.
 */
function code(text: string): string {
  let out = '';
  let i = 0;
  const blank = (end: number) => {
    out += text.slice(i, end).replace(/[^\n]/g, ' ');
    i = end;
  };
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '//') {
      const end = text.indexOf('\n', i);
      blank(end === -1 ? text.length : end);
    } else if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      blank(end === -1 ? text.length : end + 2);
    } else if (text[i] === "'" || text[i] === '"' || text[i] === '`') {
      const quote = text[i]!;
      let end = i + 1;
      while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
      blank(Math.min(end + 1, text.length));
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/**
 * The text of the call around `at` -- the innermost `(` opened by a name,
 * as `assignTask(` or `withTenant(` is, rather than by `if`, a spread or a
 * group -- or, when no call holds it, of the innermost braces.
 */
function holding(source: string, at: number): string {
  const opened: Array<{ char: string; at: number }> = [];
  for (let i = 0; i < at; i += 1) {
    const char = source[i]!;
    if (char === '(' || char === '{' || char === '[') opened.push({ char, at: i });
    else if (char === ')' || char === '}' || char === ']') opened.pop();
  }
  const close = (start: number): number => {
    let depth = 0;
    for (let i = start; i < source.length; i += 1) {
      const char = source[i]!;
      if (char === '(' || char === '{' || char === '[') depth += 1;
      else if (char === ')' || char === '}' || char === ']') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return source.length;
  };
  for (let n = opened.length - 1; n >= 0; n -= 1) {
    const one = opened[n]!;
    if (one.char !== '(') continue;
    const before = source.slice(Math.max(0, one.at - 40), one.at);
    const name = /([A-Za-z_$][\w$]*)\s*(<[^()]*>)?\s*$/.exec(before)?.[1];
    if (name && !['if', 'for', 'while', 'switch', 'catch', 'return', 'await', 'typeof', 'function'].includes(name)) {
      return source.slice(one.at, close(one.at) + 1);
    }
  }
  const braces = [...opened].reverse().find((one) => one.char === '{');
  return braces ? source.slice(braces.at, close(braces.at) + 1) : source;
}

test('every place that carries outside words also carries staff words', async () => {
  const missing: string[] = [];
  const sites = new Set<string>();
  for (const [path, text] of await sources()) {
    const source = code(text);
    for (const found of source.matchAll(/\bcarriesOutside(From)?\b/g)) {
      const around = holding(source, found.index);
      const line = text.slice(0, found.index).split('\n').length;
      if (!/\bcarriesStaff(From)?\b/.test(around)) missing.push(`${path}:${line}`);
      // A carrying site, as against the definitions that pass the mark along
      // (the task's input and the context builder's answer): a call that
      // makes work from other work.
      if (path !== 'src/engine/tasks.ts' && path !== 'src/context/builder.ts') sites.add(`${path}@${around.length}:${around.slice(0, 60)}`);
    }
  }
  assert.deepEqual(missing, [], 'each names outside words and not staff words');
  // Running again, the quarter, the meeting, a follow-up, triage and a to-do
  // given out, a ticket the owner hands on, an escalation handed, and the
  // week with the month: nine calls today. A scan that finds fewer is broken.
  assert.ok(sites.size >= 9, `only ${sites.size} sites found: ${[...sites].join(', ')}`);
});
