/**
 * The console's script and its page agree (PRD v2 F10).
 *
 * No browser runs in this environment, so this cannot press a button. What it
 * can do is catch the failure that costs the most for the least reason: an id
 * the script reaches for that the page does not have. `document.getElementById`
 * answers `null`, the next line throws, and the panel silently never draws --
 * which looks, to the owner, exactly like a company with nothing in it.
 *
 * That is worth a guard on its own, because the page has no build step and no
 * framework: nothing else in this repository would notice a renamed id.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function read(name: string): Promise<string> {
  return readFile(new URL(`../../console/${name}`, import.meta.url), 'utf8');
}

test('every id the console script reaches for exists on the page', async () => {
  const [script, page] = await Promise.all([read('console.js'), read('index.html')]);

  const onPage = new Set([...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
  assert.ok(onPage.size > 10, `only ${onPage.size} ids were found; the scan is broken`);

  // `el('name')` for the fixed ones, and the panels, which are built from the
  // tab list as `panel-${id}`.
  const wanted = new Set([...script.matchAll(/\bel\('([^']+)'\)/g)].map((match) => match[1]!));
  for (const match of script.matchAll(/\bel\(`panel-\$\{([^}]+)\}`\)/g)) {
    void match;
    for (const tab of script.matchAll(/^\s*\['([a-z]+)', '[^']+', draw\w+\],$/gm)) {
      wanted.add(`panel-${tab[1]!}`);
    }
  }

  const missing = [...wanted].filter((id) => !onPage.has(id)).sort();
  assert.deepEqual(
    missing, [],
    'the script reaches for ids the page does not have. `getElementById` answers '
      + 'null, the next line throws, and the panel silently never draws:\n'
      + missing.map((id) => `  ${id}`).join('\n'),
  );
});

test('every tab in the script has a panel on the page, and the reverse', async () => {
  const [script, page] = await Promise.all([read('console.js'), read('index.html')]);

  const tabs = [...script.matchAll(/^\s*\['([a-z]+)', '[^']+', draw\w+\],$/gm)]
    .map((match) => match[1]!);
  assert.ok(tabs.length >= 5, `only ${tabs.length} tabs were found; the scan is broken`);

  const panels = [...page.matchAll(/\bid="panel-([a-z]+)"/g)].map((match) => match[1]!);

  assert.deepEqual(
    tabs.filter((tab) => !panels.includes(tab)), [],
    'a tab with no panel: pressing it hides every panel and shows nothing',
  );
  assert.deepEqual(
    panels.filter((panel) => !tabs.includes(panel)), [],
    'a panel with no tab: it is on the page and nothing can reach it',
  );

  // And every one of them names a function that exists, because a tab wired to
  // a name nothing defines is a `ReferenceError` on the first press.
  for (const match of script.matchAll(/^\s*\['[a-z]+', '[^']+', (draw\w+)\],$/gm)) {
    const name = match[1]!;
    assert.match(
      script, new RegExp(`(async )?function ${name}\\b`),
      `the tab list names ${name}, which nothing defines`,
    );
  }
});

test('the console builds every string with textContent, never as HTML', async () => {
  // Every title, rationale and consequence on this page came from an agent,
  // and an agent is a third party writing into the owner's browser.
  // `textContent` makes that structurally impossible to exploit; `innerHTML`
  // would make it a question of escaping, and escaping is a thing people get
  // right until they do not.
  const script = await read('console.js');
  for (const forbidden of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.equal(
      script.includes(forbidden), false,
      `console.js uses ${forbidden}; every string on this page comes from an agent`,
    );
  }
});
