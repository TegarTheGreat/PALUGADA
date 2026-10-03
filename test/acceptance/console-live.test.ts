/**
 * The console shows work moving the moment it moves (the analysis of
 * 3 October, §9 P1 item 11).
 *
 * The work list asked again every ten seconds, so a finished task sat under
 * Running for as long. Drawn in a real browser, the list now changes within a
 * few seconds of the task -- sooner than it would ask again by itself, so it
 * was the live stream (`live.test.ts`) that told it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { createRootTask, transition } from '../../src/engine/tasks.ts';
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

test('the work list shows a task finished within seconds of it finishing', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('live-console');
  const { companyId } = fixture;
  await withControlPlane(async (tx) => {
    await tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [companyId]);
    await tx.query('UPDATE platform_control SET tour_finished_at = now()');
  });
  const task = await createRootTask({
    companyId, projectId: fixture.projectId, divisionId: fixture.divisionId, roleId: fixture.roleId,
    budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId, input: { goal: 'Write the October newsletter' },
    createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(companyId, task.id, 'running');

  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 1280, height: 900 });
  try {
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`document.body.innerText.includes('Toko Kopi Senja')`, 'the console');
    await page.evaluate(`location.hash = '#/c/${companyId}/work'`);
    await page.waitFor(`document.body.innerText.includes('Write the October newsletter') && document.body.innerText.includes('Running · 1')`,
      'the task under Running');
    // Long enough for the page to have opened its stream, short of its next ask.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    await transition(companyId, task.id, 'completed', { output: { summary: 'Drafted, 140 words.' } });
    await page.waitFor(`document.body.innerText.includes('Done · 1')`, 'the task under Done, from the live stream', 4_000);
  } finally {
    await page.close();
    await api.close();
  }
});
