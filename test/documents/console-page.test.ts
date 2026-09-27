/**
 * The console's source keeps the promises the page makes (PRD v2 F10).
 *
 * No browser runs these, so they cannot press a button. What they can do is
 * read the source for the failures that cost the most for the least reason:
 * a string from an agent rendered as markup, a page in the navigation with
 * nothing behind it, a script from another origin, a session token written
 * where it outlives the tab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONSOLE = fileURLToPath(new URL('../../console', import.meta.url));

/** Every source file of the console, by path relative to `console/src`. */
async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`);
      else if (/\.(ts|tsx)$/.test(entry.name)) files.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'));
    }
  };
  await walk(join(CONSOLE, 'src'), '');
  return files;
}

test('the console renders every string as text, never as markup', async () => {
  // Every title, rationale and consequence on this page came from an agent,
  // and an agent is a third party writing into the owner's browser. React
  // escapes what it renders; these are the ways around that, and none of
  // them is needed by a page that only shows what it was told.
  const files = await sources();
  assert.ok(files.size > 10, `only ${files.size} source files were found; the scan is broken`);
  for (const [path, source] of files) {
    for (const forbidden of [
      'dangerouslySetInnerHTML', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
      'eval(', 'new Function(',
    ]) {
      assert.equal(source.includes(forbidden), false, `${path} uses ${forbidden}`);
    }
  }
});

test('every page in the navigation has a component behind it, and the reverse', async () => {
  const app = await readFile(join(CONSOLE, 'src', 'App.tsx'), 'utf8');
  const router = await readFile(join(CONSOLE, 'src', 'router.ts'), 'utf8');
  const listed = [...app.matchAll(/\{ id: '([a-z]+)', label: N\('[^']+'\), icon: \w+, group: '(decide|company|setup)' \}/g)]
    .map((match) => match[1]!);
  assert.ok(listed.length >= 8, `only ${listed.length} pages were found; the scan is broken`);
  const routed = [...app.matchAll(/case '([a-z]+)': return <(\w+) ctx=\{ctx\} route=\{route\} \/>;/g)];
  assert.deepEqual([...listed].sort(), routed.map((match) => match[1]!).sort(),
    'a page in the navigation with no component, or a component nothing navigates to');
  // And the address knows every page, or a reload lands somewhere else.
  const known = router.match(/COMPANY_PAGES = \[([^\]]+)\]/)?.[1] ?? '';
  assert.deepEqual([...known.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!).sort(), [...listed].sort());
  // Imported, or loaded when first opened -- from its own page either way.
  for (const [, , component] of routed) {
    assert.match(app, new RegExp(`import \\{ ${component} \\} from './pages/${component}\\.tsx';`
      + `|const ${component} = lazy\\(\\(\\) => import\\('\\./pages/${component}\\.tsx'\\)\\.then\\(\\(module\\) => \\(\\{ default: module\\.${component} \\}\\)\\)\\);`),
      `${component} is routed to and never imported`);
  }
});

test('every section of the settings has a component behind it, and the reverse', async () => {
  const hub = await readFile(join(CONSOLE, 'src', 'pages', 'SettingsHub.tsx'), 'utf8');
  const router = await readFile(join(CONSOLE, 'src', 'router.ts'), 'utf8');
  const listed = [...hub.matchAll(/\{ id: '([a-z]+)', label: N\(/g)].map((match) => match[1]!);
  const drawn = [...hub.matchAll(/case '([a-z]+)': return </g)].map((match) => match[1]!);
  const known = router.match(/SETTINGS_SECTIONS = \[([^\]]+)\]/)?.[1] ?? '';
  assert.ok(listed.length >= 6, `only ${listed.length} sections were found; the scan is broken`);
  assert.deepEqual([...drawn].sort(), [...listed].sort());
  assert.deepEqual([...known.matchAll(/'([a-z]+)'/g)].map((match) => match[1]!).sort(), [...listed].sort());
});

test('the console loads nothing from another origin', async () => {
  // The owner API serves the page under a policy of `script-src 'self'`; a
  // script or stylesheet from a CDN would be refused in the browser, and the
  // owner would see a blank page with nothing to say why.
  const page = await readFile(join(CONSOLE, 'index.html'), 'utf8');
  assert.doesNotMatch(page, /<(script|link)[^>]+(src|href)="(https?:)?\/\//, 'index.html names another origin');
  for (const [path, source] of await sources()) {
    assert.doesNotMatch(source, /fetch\(\s*['`]https?:/, `${path} fetches from another origin`);
  }
});

test('the session token is held in memory and nowhere else', async () => {
  // A token in localStorage survives a closed tab and is readable by anything
  // that manages to run script on this origin. The console forgets it with
  // the tab, which is what a person expects of anything that guards money.
  const files = await sources();
  const wire = files.get('api.ts') ?? '';
  assert.match(wire, /let token: string \| null = null;/);
  for (const [path, source] of files) {
    assert.doesNotMatch(source, /\b(localStorage|sessionStorage)\.|document\.cookie\s*=/, `${path} stores something in the browser`);
  }
  // Nor does a library write there on the console's behalf: Mantine keeps the
  // colour scheme in localStorage unless it is handed a manager that does not.
  assert.match(files.get('main.tsx') ?? '', /colorSchemeManager=\{memoryColorSchemeManager\(\)\}/,
    'Mantine is left to keep the colour scheme in localStorage');
});

test('approving is never the prettiest button, and never a keystroke', async () => {
  // "Approve" is the irreversible one. It is an outline beside a plain
  // "Deny"; a console that made approving the easiest thing to hit would get
  // approvals it did not mean. The arrows move between items; nothing
  // approves from the keyboard.
  const decisions = (await sources()).get('pages/Decisions.tsx') ?? '';
  const approve = decisions.match(/<Button[^\n]*onClick=\{\(\) => void decide\('approve'\)\}/)?.[0] ?? '';
  assert.ok(approve.length > 0, 'the approve button was not found; the scan is broken');
  assert.match(approve, /variant="outline" color="teal"/);
  const hotkeys = decisions.match(/useHotkeys\(\[(.*)\]\)/)?.[1] ?? '';
  assert.ok(hotkeys.length > 0, 'the hotkeys were not found; the scan is broken');
  assert.doesNotMatch(hotkeys, /approve|decide/);
});

test("the policy form's example is a condition the engine accepts", async () => {
  // It used to be `{ "capability": "email.send" }`, which is not a condition:
  // an owner who pressed "Write it" on the example was told the policy
  // "references unknown field undefined", in the form meant to teach them the
  // shape.
  const { assertValidCondition } = await import('../../src/policy/condition.ts');
  const page = (await sources()).get('pages/Organization.tsx') ?? '';
  const example = /const \[condition, setCondition\] = useState\('((?:[^'\\]|\\.)*)'\)/.exec(page)?.[1];
  assert.ok(example, 'the example condition was not found; the scan is broken');
  assert.doesNotThrow(() => assertValidCondition(JSON.parse(example.replace(/\\n/g, '\n'))));
});
