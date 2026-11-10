/**
 * A budget account is named for what it covers (the analysis of 3 October,
 * §2.3 item 7).
 *
 * The accounts a template makes are labelled with the platform's codes -- the
 * company's "company", each division's by its short name, "ops" -- and the
 * console showed those labels as the accounts' names; a role's budget said
 * what it rolls up through as the first eight characters of each account's
 * id; and a budget halt told the owner "the company account is out of
 * tokens" in English inside an Indonesian sentence. An account is named for
 * what it covers, unless the owner named it.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import { createCompanyFromTemplate } from '../../src/templates/company.ts';
import { STANDARD_TEMPLATE_SLUG, installStandardTemplate } from '../helpers/standard-team.ts';
import { registerStandardCatalogue } from '../helpers/catalogue-stubs.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';
import { consoleWithSettings } from '../helpers/owner-console.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

test('an account is named for what it covers, unless the owner named it, and so is the chain a role rolls up through', async () => {
  await registerStandardCatalogue();
  await installStandardTemplate();
  const company = await createCompanyFromTemplate({
    templateSlug: STANDARD_TEMPLATE_SLUG, companySlug: 'named-accounts', name: 'Named Accounts', timezone: 'Asia/Jakarta',
  });
  const api = await consoleWithSettings();
  try {
    const token = await api.signIn();
    const { rows: [role] } = await withTenant(company.companyId, (tx) => tx.query<{ id: string; division_id: string }>(
      "SELECT r.id, r.division_id FROM roles r JOIN divisions d ON d.id = r.division_id WHERE d.slug = 'ops' LIMIT 1"));
    // On one role, the narrowest scope there is: an account beside the
    // division's own, on the same division, would be a tie for which covers it.
    const opened = await api.call('POST', `/api/companies/${company.companyId}/budget-accounts`, token, {
      label: 'Ramadan promotion', tokensMax: 50_000, scopeType: 'role', scopeId: role!.id,
      parentAccountId: (await accountOf(company.companyId, 'ops')), proof: { totp: api.code() },
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));

    const listed = await api.call('GET', `/api/companies/${company.companyId}/budget-accounts`, token);
    const names = new Map((listed.body.accounts as Array<{ label: string; name: string | null }>)
      .map((account) => [account.label, account.name]));
    assert.equal(names.get('company'), null, 'the whole company, which the console says in the owner\'s language');
    assert.equal(names.get('ops'), 'Operations', 'a division\'s, by the division\'s name');
    assert.equal(names.get('Ramadan promotion'), 'Ramadan promotion', 'and the owner\'s own, by the name they gave it');

    const budget = await api.call('GET', `/api/companies/${company.companyId}/divisions/${role!.division_id}/roles/${role!.id}/budget`, token);
    assert.equal(budget.status, 200, JSON.stringify(budget.body));
    // The narrowest account covering the role is the one opened above.
    assert.deepEqual(budget.body.chainNames, ['Ramadan promotion', 'Operations', null], 'what it rolls up through, by name');
  } finally {
    await api.close();
  }
});

async function accountOf(companyId: string, label: string): Promise<string> {
  const { rows } = await withTenant(companyId, (tx) => tx.query<{ id: string }>(
    'SELECT id FROM budget_accounts WHERE label = $1', [label]));
  return rows[0]!.id;
}
