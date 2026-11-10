/**
 * The rooms' console keeps the promises the rooms make (F19.5, F19.7, F19.21;
 * STATUS 2.207), read from its source.
 *
 * A browser test sees one room drawn once. These read every file of the
 * Rooms page for the mistakes that would be cheap to make and expensive to
 * miss: an approval made the easiest thing to press or pressed from the
 * keyboard, an agent's words drawn as anything but safe text, a person drawn
 * as an agent or an agent as a person, and a route called by a path built
 * somewhere else, which the route tests cannot read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE = fileURLToPath(new URL('../../console/src', import.meta.url));
const ROUTES = fileURLToPath(new URL('../../src/owner/routes/rooms.ts', import.meta.url));

/** The Rooms page and its components, by path relative to `console/src`. */
async function workspace(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readdir(join(CONSOLE, 'workspace'))) {
    if (/\.(ts|tsx)$/.test(entry)) files.set(`workspace/${entry}`, await readFile(join(CONSOLE, 'workspace', entry), 'utf8'));
  }
  for (const path of ['pages/Rooms.tsx', 'components/DecisionButtons.tsx']) {
    files.set(path, await readFile(join(CONSOLE, path), 'utf8'));
  }
  return files;
}

test('approving on a card is an outline button and never a keystroke', async () => {
  // A decision in a room is the inbox's decision (F19.7): the same buttons,
  // so the same friction. Approve is an outline beside a plain Deny, and
  // nothing in the rooms approves, decides or sends work from the keyboard.
  const files = await workspace();
  const buttons = files.get('components/DecisionButtons.tsx')!;
  const approve = buttons.match(/<Button[^\n]*onClick=\{\(\) => void decide\('approve'\)\}/)?.[0] ?? '';
  assert.ok(approve.length > 0, 'the approve button was not found in DecisionButtons.tsx; the scan is broken');
  assert.match(approve, /variant="outline" color="teal"/);
  assert.doesNotMatch(buttons, /useHotkeys|onKeyDown|getHotkeyHandler|autoFocus/, 'the decision buttons answer a key');
  const card = files.get('workspace/ApprovalCard.tsx') ?? '';
  assert.match(card, /<DecisionButtons\b/, 'a room\'s approval card draws its own buttons');
  assert.doesNotMatch(card, /<Button[^\n]*decide\('approve'\)/, 'a room\'s approval card draws its own approve button');
  const inbox = await readFile(join(CONSOLE, 'pages', 'Decisions.tsx'), 'utf8');
  assert.match(inbox, /<DecisionButtons\b/, 'the inbox draws its decision with the same buttons');

  for (const [path, source] of files) {
    for (const keys of source.matchAll(/useHotkeys\(\s*\[([\s\S]*?)\]\s*(?:,|\))/g)) {
      assert.doesNotMatch(keys[1]!, /decide|approve|\/work|giveAsWork|ask\(|send\(/, `${path} decides, asks or sends from a hotkey`);
    }
    for (const handler of source.matchAll(/onKeyDown=\{([\s\S]*?)\}\s*(?:\n|\/?>)/g)) {
      assert.doesNotMatch(handler[1]!, /decide|approve|\/work|\/tell|\/stop/, `${path} decides or makes work from a key`);
    }
  }
});

test('what an agent wrote is drawn with Prose', async () => {
  // A card's result, its last line, a run's question and a work thread's
  // progress are an agent's words (F19.5): drawn through Prose, which renders
  // no markup and keeps links to safe addresses, and never as raw text that a
  // later change could hand to something less careful. A person's words are
  // drawn the same way, so no two paths exist for one message body.
  const files = await workspace();
  const all = [...files.values()].join('\n');
  for (const [field, drawn] of [
    ['result', /<Prose[^>]*text=\{[^}]*card\.result/],
    ['lastLine', /<Prose[^>]*text=\{[^}]*card\.lastLine/],
    ['question', /<Prose[^>]*text=\{[^}]*question\.text/],
    ['progress', /<Prose[^>]*text=\{[^}]*progress/],
    ['body', /<Prose[^>]*text=\{[^}]*message\.body/],
  ] as const) {
    assert.match(all, drawn, `${field} is not drawn with Prose anywhere in the Rooms page`);
  }
  // Raw, they would be an expression between tags: anywhere but Prose's `text=`.
  for (const [path, source] of files) {
    assert.doesNotMatch(source, /(?<!text=)\{\s*card\.(result|lastLine|goal)\s*\}/, `${path} draws an agent's words as raw text`);
    assert.doesNotMatch(source, /(?<!text=)\{\s*(?:card\.)?question\.text\s*\}/, `${path} draws a run's question as raw text`);
    assert.doesNotMatch(source, /(?<!text=)\{\s*(?:thread\.)?progress\s*\}/, `${path} draws a work's progress as raw text`);
  }
});

test('a person is drawn with their picture, and an agent with its role\'s picture and badge', async () => {
  // People are pictures chosen or given from their seat, never from a
  // name's letters (F19.2), and the owner is the owner's picture; an agent is
  // never a member and appears only as its work, drawn with its role's
  // picture and marked as an agent (F19.5). A row of a message never draws a
  // role, and a card never draws a person as its worker.
  const files = await workspace();
  const row = files.get('workspace/MessageRow.tsx') ?? '';
  assert.match(row, /personPicture\(/, 'a message\'s author is not drawn with their picture');
  assert.doesNotMatch(row, /rolePicture\(/, 'a message\'s author is drawn as a role');
  // The chip that says who wrote it is read from the principal, never the name (F19.21).
  assert.match(row, /principal === 'owner'/, 'the owner\'s chip is not drawn from the principal');
  assert.doesNotMatch(row, /name\s*===\s*['"]Owner['"]|t\('Owner'\)\s*===/, 'the owner\'s chip is drawn from a name');
  const work = files.get('workspace/WorkState.tsx') ?? '';
  assert.match(work, /rolePicture\(/, 'the work is not drawn with its role\'s picture');
  assert.match(work, /t\('agent'\)/, 'the work does not say that an agent does it');
  assert.doesNotMatch(work, /personPicture\(/, 'the worker is drawn as a person');
  for (const path of ['workspace/MentionPicker.tsx', 'workspace/NewMessage.tsx', 'workspace/RoomInfo.tsx']) {
    const source = files.get(path) ?? '';
    assert.match(source, /personPicture\(/, `${path} does not draw people with their pictures`);
    assert.doesNotMatch(source, /rolePicture\(/, `${path} offers a role among the people`);
  }
});

test('every workspace route is written out at its call', async () => {
  // Each room route the server offers is pressed from the Rooms page, written
  // as `api('METHOD', '/api/...')` with its path spelled out, so the route
  // tests can read it; a path built in a variable is pressed by nobody they
  // can see.
  const files = await workspace();
  const app = await readFile(join(CONSOLE, 'App.tsx'), 'utf8');
  const pressed = new Set<string>();
  for (const source of [...files.values(), app]) {
    for (const call of source.matchAll(/\bapi\(\s*'([A-Z]+)'\s*,\s*['`](\/api\/[^'`]*)['`]/g)) {
      pressed.add(`${call[1]} ${call[2]!.replace(/\?.*$/, '').replace(/\$\{[^}]+\}/g, ':x')}`);
    }
  }
  const routes = [...(await readFile(ROUTES, 'utf8')).matchAll(/method: '([A-Z]+)',\s*\n\s*pattern: '([^']+)'/g)]
    .map((match) => ({ method: match[1]!, pattern: match[2]! }));
  assert.ok(routes.length >= 26, `only ${routes.length} room routes were found; the scan is broken`);
  for (const route of routes) {
    const normal = `${route.method} ${route.pattern.replace(/:[A-Za-z]+/g, ':x')}`;
    assert.ok(pressed.has(normal), `${route.method} ${route.pattern} is not pressed from the Rooms page`);
  }
  for (const [path, source] of files) {
    assert.doesNotMatch(source, /\bapi(?:<[^>]*>)?\(\s*'[A-Z]+'\s*,\s*(?![\s'`])/, `${path} calls a route by a path built elsewhere`);
  }
});

test("a file is attached from the composer, from a phone's camera too, and only a small picture is drawn", async () => {
  // F19.16: a phone attaches what its camera takes, as a desktop attaches a
  // file. And F19.4's files are drawn only when the server says a file is a
  // small picture of a kind no browser runs (`inline`), from a data address
  // the console's policy allows; everything else -- an SVG, a page -- is
  // saved as an octet stream with its name, never opened from this origin.
  const files = await workspace();
  const composer = files.get('workspace/Composer.tsx') ?? '';
  assert.match(composer, /<input[^>]*type="file"[^>]*multiple/, 'the composer attaches files');
  assert.match(composer, /<input[^>]*accept="image\/\*"[^>]*capture="environment"/, 'and takes a picture with a phone\'s camera');
  const drawn = files.get('workspace/RoomFiles.tsx') ?? '';
  assert.match(files.get('workspace/MessageRow.tsx') ?? '', /<RoomFiles\b/, 'a message draws its files');
  assert.match(drawn, /\.inline\b/, 'what is drawn is what the server says may be');
  assert.match(drawn, /`data:\$\{[^}]+\};base64,\$\{[^}]+\}`/, 'a picture is drawn from a data address');
  for (const blob of drawn.matchAll(/new Blob\(\[[^\]]*\],\s*\{([^}]*)\}/g)) {
    assert.match(blob[1]!, /type:\s*'application\/octet-stream'/, 'a file is saved as bytes, never as the kind it says it is');
  }
  assert.doesNotMatch(drawn, /window\.open|target="_blank"|<iframe|<object|<embed/, 'a file is never opened in the console\'s origin');
});
