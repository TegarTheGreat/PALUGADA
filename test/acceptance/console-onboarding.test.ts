/**
 * Starting a company is one short screen (the owner's feedback of 7 October:
 * "the onboarding is still ugly, not like Paperclip").
 *
 * An owner who signs in to a deployment with no company used to meet a tour of
 * eight steps laid over an empty page and, behind it, a form in a dialog under
 * a paragraph about seven divisions. Now there is a name, and what the company
 * is for; then the company runs, with its CEO already speaking. Drawn in a
 * real browser at a phone's width, because that is where most owners start.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { installFoundingTemplate } from '../../src/templates/founding.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(async () => {
  await resetData();
  await registerStandardCatalogue();
  await installFoundingTemplate();
});
after(async () => {
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

test('an owner with no company is asked for a name and what it is for, and meets the CEO who has read it', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const mission = 'We roast Gayo coffee and sell it to cafés in Bandung.';
  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`document.body.innerText.includes("Let's start your company")`, 'the first screen');

    // Nothing is laid over it: no tour, no dialog, and nothing wider than a phone.
    assert.equal(await page.evaluate(`document.querySelectorAll('[role=dialog]').length`), 0, 'no tour or dialog over the first screen');
    assert.equal(await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), true, 'nothing scrolls sideways');
    const disabled = (): Promise<boolean> => page.evaluate(
      `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start the company').disabled`);
    assert.equal(await disabled(), true, 'it cannot be started without a name');

    await page.evaluate(`document.querySelector('input[placeholder^="e.g."]').focus()`);
    await page.type('Kopi Senja');
    await page.evaluate(`document.querySelector('textarea').focus()`);
    await page.type(mission);
    assert.equal(await disabled(), false);
    await page.evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start the company').click()`);

    // Starting a company asks for the authenticator when it has not been given a moment ago.
    await page.waitFor(
      `document.querySelector('input[autocomplete="one-time-code"]') || document.body.innerText.includes('I know what it is for')`,
      'the company, or its authenticator prompt');
    if (await page.evaluate<boolean>(`!!document.querySelector('input[autocomplete="one-time-code"]')`)) {
      // Six digits that are wider than the dialog cannot be typed into: the first and
      // the last were cut off at this width.
      const off = await page.evaluate<number>(`(() => {
        const dialog = document.querySelector('[role=dialog]').getBoundingClientRect();
        return [...document.querySelectorAll('[role=dialog] input')].map((box) => box.getBoundingClientRect())
          .filter((r) => r.width > 0 && (r.left < dialog.left || r.right > dialog.right)).length;
      })()`);
      assert.equal(off, 0, 'the six digits of the code sit inside the dialog');
      await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
      await page.type(api.code());
    }
    await page.waitFor(`document.body.innerText.includes('I know what it is for')`, 'the CEO speaking', 30_000);
    const said = await page.evaluate<string>('document.body.innerText');
    assert.ok(said.includes(mission), 'the CEO says back what the company is for');
    assert.ok(!said.includes('what does Kopi Senja sell'), 'and does not ask what it sells');

    // And what exists is what the owner asked for: one company, one role, the CEO.
    const { rows } = await withControlPlane((tx) => tx.query<{ companies: string; roles: string; title: string | null }>(
      `SELECT (SELECT count(*) FROM companies) AS companies, (SELECT count(*) FROM roles) AS roles,
              (SELECT min(title) FROM roles) AS title`));
    assert.deepEqual(rows[0], { companies: '1', roles: '1', title: 'CEO' });
  } finally {
    await page.close();
    await api.close();
  }
});
