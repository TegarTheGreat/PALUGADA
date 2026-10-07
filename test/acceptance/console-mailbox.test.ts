/**
 * A division's mailbox in the console, drawn in a real browser at a phone's
 * width (console/src/pages/Organization.tsx, src/capabilities/mailbox.ts):
 * the division says which of its capabilities need a mailbox, and the owner
 * gives it one in a form -- not a key pasted -- that the mail servers check
 * before it is sealed.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { closePools } from '../../src/db/pool.ts';
import { withControlPlane } from '../../src/db/tenant.ts';
import { CapabilityRegistry } from '../../src/broker/registry.ts';
import { mailboxCapabilities } from '../../src/capabilities/mailbox.ts';
import { createCompany, grantCapability } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';
import { chromium, openPage, type Page } from '../helpers/browser.ts';
import { certificate, imapServer, smtpServer } from '../helpers/mail-servers.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

const BUILT = fileURLToPath(new URL('../../console/dist', import.meta.url));
const browser = chromium();
const cert = certificate();
const ACCOUNT = { user: 'sales@tokokopi.example', password: 'app-password-5678' };

/** Types into the field a label names, as a person does: focused, then key by key. */
async function fill(page: Page, label: string, text: string): Promise<void> {
  const found = await page.evaluate(`(() => {
    const named = [...document.querySelectorAll('label')].find((one) => one.innerText.trim().startsWith(${JSON.stringify(label)}));
    const field = named && document.getElementById(named.htmlFor);
    if (!field) return false;
    field.focus();
    field.select?.();
    return true;
  })()`);
  assert.ok(found, `a field labelled ${label}`);
  await page.type(text);
}

test('a division is given its mailbox in a form, checked by the mail servers before it is sealed', { skip: browser && cert ? false : 'no Chromium to draw the console in, or no openssl' }, async () => {
  assert.ok(existsSync(`${BUILT}/index.html`), 'the console is built first (npm run console:build)');
  const fixture = await createCompany('console-mailbox');
  await withControlPlane((tx) => tx.query("UPDATE companies SET name = 'Toko Kopi Senja' WHERE id = $1", [fixture.companyId]));
  const imap = await imapServer(cert!, ACCOUNT);
  const smtp = await smtpServer(cert!, ACCOUNT);
  const registry = new CapabilityRegistry();
  for (const capability of mailboxCapabilities({ ca: cert!.cert })) registry.register(capability);
  await registry.sync();
  await grantCapability(fixture, 'mailbox.read');
  await grantCapability(fixture, 'email.send');
  const api = await consoleWithSettings({ staticRoot: BUILT, registry });
  const page = await openPage(browser as string, { width: 390, height: 844 });
  try {
    await page.goto(api.url);
    await page.waitFor(`document.querySelector('input[autocomplete="one-time-code"]')`, 'the sign-in');
    await page.evaluate(`document.querySelector('input[autocomplete="one-time-code"]').focus()`);
    await page.type(api.code());
    await page.waitFor(`!document.querySelector('input[autocomplete="one-time-code"]') && document.body.innerText.includes('Toko Kopi Senja')`, 'the console');

    await page.evaluate(`location.hash = '#/c/${fixture.companyId}/team'`);
    await page.waitFor(`[...document.querySelectorAll('div')].some((one) => one.style.cursor === 'pointer' && one.innerText.includes('Operations'))`, 'the division');
    await page.evaluate(`[...document.querySelectorAll('button')].find((one) => one.innerText.trim() === 'Skip the tour')?.click()`);
    await page.evaluate(`[...document.querySelectorAll('div')].filter((one) => one.style.cursor === 'pointer' && one.innerText.includes('Operations')).at(-1).click()`);

    // Asked for as a mailbox, with the fields a mailbox has, not a key's one box.
    await page.waitFor(`document.body.innerText.includes('needs the mailbox key') && document.body.innerText.includes('IMAP server')`, 'the mailbox asked for', 20_000);
    const asked = String(await page.evaluate('document.body.innerText'));
    assert.ok(asked.includes('email.send, mailbox.read needs the mailbox key'), asked);
    assert.ok(!asked.includes('Issue it with'), 'a mailbox has no scopes to issue it with');
    await fill(page, 'The mailbox\'s address', ACCOUNT.user);
    await fill(page, 'The mailbox\'s password', ACCOUNT.password);
    await fill(page, 'IMAP server', '127.0.0.1');
    await page.evaluate(`(() => {
      const ports = [...document.querySelectorAll('label')].filter((one) => one.innerText.trim() === 'Port').map((one) => document.getElementById(one.htmlFor));
      for (const [field, port] of [[ports[0], ${imap.port}], [ports[1], ${smtp.port}]]) {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(field, String(port));
        field.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`);
    await fill(page, 'SMTP server', '127.0.0.1');
    const wide = await page.evaluate('document.documentElement.scrollWidth - window.innerWidth');
    assert.ok(Number(wide) <= 0, `the form is ${String(wide)} pixels wider than a phone`);

    await page.evaluate(`[...document.querySelectorAll('.mantine-Drawer-content button')].find((one) => one.innerText.trim() === 'Save' && !one.disabled).click()`);
    // The owner signed in with their device, and that is the factor: the mailbox is kept with no code asked for.
    await page.waitFor(`document.body.innerText.includes('Change the mailbox')`, 'the mailbox held', 20_000);
    assert.ok(!String(await page.evaluate('document.body.innerText')).includes('Confirm with your authenticator'), 'no code was asked for');

    const { rows } = await withControlPlane((tx) => tx.query<{ alias: string; scopes: string[] }>(
      'SELECT alias, scopes FROM credentials WHERE division_id = $1', [fixture.divisionId]));
    assert.deepEqual(rows.map((row) => [row.alias, row.scopes]), [['mailbox', ['mail:send', 'mail:read']]]);
    assert.ok(imap.logins.some((login) => login.user === ACCOUNT.user && login.password === ACCOUNT.password), 'the servers were asked');
    assert.ok(!String(await page.evaluate('document.body.innerText')).includes(ACCOUNT.password));
  } finally {
    await page.close();
    await api.close();
    await imap.close();
    await smtp.close();
  }
});
