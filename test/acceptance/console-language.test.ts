/**
 * The deployment learns the language the owner reads (the owner's complaint of
 * 6 October: "the language was chosen as Indonesian, and the agent still greets
 * in English").
 *
 * An owner whose browser is in Indonesian is shown a console in Indonesian
 * without having chosen anything, and the deployment -- which writes the CEO's
 * first words, every push and every card, and decides what the agents that
 * have no language of their own write in -- kept `console_language` empty and
 * wrote in English. Now the console says, once, which language it has drawn
 * itself in; and what the owner has already chosen is never overwritten by
 * the browser.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { deploymentLanguages, setDeploymentLanguages } from '../../src/domain/language.ts';
import { createCompany } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage } from '../helpers/browser.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();

/** Opens the console in a browser set to `language`, signed in, and says what the deployment knows once it is up. */
async function signedIn(language: string) {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  await createCompany('lang-browser');
  await withControlPlane((tx) => tx.query('UPDATE platform_control SET tour_finished_at = now()'));
  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 1200, height: 800 }, language);
  await page.goto(api.url);
  await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
  await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
  await page.type(api.code());
  await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.querySelector('nav, aside')`, 'the console');
  return { api, page };
}

/** The deployment's panel language, once it is `expected` (it is written a moment after the console is up). */
async function learned(expected: string | null): Promise<string | null> {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const { console: known } = await deploymentLanguages();
    if (known === expected) return known;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return (await deploymentLanguages()).console;
}

test('a console drawn in the browser\'s language tells the deployment, so the CEO and the agents speak it too', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  const { api, page } = await signedIn('id');
  try {
    assert.equal(await learned('id'), 'id', 'the deployment now knows the owner reads Indonesian');
    const after = await deploymentLanguages();
    assert.deepEqual(after, { console: 'id', agents: 'id', agentsChosen: false }, 'and the agents that were told nothing follow');
  } finally {
    await page.close();
    await api.close();
  }
});

test('what the owner chose is never overwritten by the browser', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  await setDeploymentLanguages({ console: 'ms' });
  const { api, page } = await signedIn('id');
  try {
    // Give it every chance to have written.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal((await deploymentLanguages()).console, 'ms');
  } finally {
    await page.close();
    await api.close();
  }
});
