/**
 * A staff seat in the console, drawn in a real browser (src/owner/staff.ts,
 * 0110): joined from the owner's invite, shown its one company without the
 * owner's controls, able to approve what is small and told that tier 3 is
 * the owner's.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane, withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import { decodeBase32, stepFor, totpCode } from '../../src/owner/mfa.ts';
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

test('an approver joins from the invite, sees one company without the owner\'s controls, and approves what is small', { skip: browser ? false : 'no Chromium to draw the console in' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('staff-console');
  await createCompany('staff-console-other');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const small = await inbox.requestApproval({
    companyId: fixture.companyId, capabilityName: 'email.send', tier: 2, title: 'email.send: to ana@example.test',
    actionSummary: 'email.send: to ana@example.test', rationale: 'A reply to Ana.', consequenceIfDenied: 'No reply is sent.',
  });

  const api = await consoleWithSettings({ staticRoot: BUILT });
  const page = await openPage(browser as string, { width: 1280, height: 900 });
  try {
    const owner = await api.signIn();
    const made = await api.call('POST', `/api/companies/${fixture.companyId}/staff`, owner, { name: 'Budi', kind: 'approver', proof: { totp: api.code() } });
    assert.equal(made.status, 200, JSON.stringify(made.body));

    await page.goto(`${api.url}/#/join/${made.body.invite}`);
    await page.waitFor(`document.body.innerText.includes('Welcome, Budi')`, 'the join page');
    // The key the page shows, for an app that cannot scan; read as the person would type it.
    const secret = String(await page.evaluate(`[...document.querySelectorAll('code')].map((one) => one.innerText).find((text) => /^[A-Z2-7 ]{20,}$/.test(text)) ?? ''`)).replace(/\s/g, '');
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(totpCode(decodeBase32(secret), stepFor(new Date())));
    await page.waitFor(`document.body.innerText.includes('Toko Kopi Senja') && document.body.innerText.includes('Approver')`, 'the console, as Budi');

    // Wherever the seat lands, and on Home, which lists every company it may see.
    const owners = ['Stop everything', 'Ask PALUGADA', 'This deployment', 'Start a company', 'Restore from an export'];
    for (const at of ['', '#/home']) {
      if (at) {
        await page.evaluate(`location.hash = '${at}'`);
        await page.waitFor(`document.body.innerText.includes('Toko Kopi Senja') && document.body.innerText.includes('Your companies')`, 'Home, as Budi');
      }
      const text = String(await page.evaluate('document.body.innerText'));
      for (const one of owners) assert.ok(!text.includes(one), `"${one}" is the owner's${at ? ', on Home' : ''}`);
      assert.ok(!text.includes('staff-console-other'), 'nor is another company shown');
    }

    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/inbox'`);
    await page.waitFor(`document.body.innerText.includes('A reply to Ana.')`, 'the card');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Approve').click()`);
    const deadline = Date.now() + 8_000;
    let decided: { decision: string | null; decided_by_seat: string | null } | undefined;
    while (Date.now() < deadline) {
      ({ rows: [decided] } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string | null; decided_by_seat: string | null }>(
        'SELECT decision, decided_by_seat FROM inbox_items WHERE id = $1', [small])));
      if (decided?.decision) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(decided?.decision, 'approve');
    assert.equal(decided?.decided_by_seat, made.body.seatId);

    await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'record.delete', tier: 3, title: 'record.delete: recordId cust-042',
      actionSummary: 'record.delete: recordId cust-042', rationale: 'A duplicate of cust-041.', consequenceIfDenied: 'It stays.',
    });
    await page.waitFor(`document.body.innerText.includes('A duplicate of cust-041.')`, 'the tier 3 card', 20_000);
    await page.waitFor(`document.body.innerText.includes("Tier 3 is the owner's to decide")`, 'what it says instead of buttons');
  } finally {
    await page.close();
    await api.close();
  }
});
