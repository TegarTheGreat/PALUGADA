/**
 * Money (F1.5-F1.9, F11.3): the period's ceiling and what has been spent
 * against it, cost per day, the account tree underneath, and every company
 * side by side.
 */
// The charts' styles come with the page that draws them, not with every page.
import '@mantine/charts/styles.css';
import { useState } from 'react';
import {
  Alert, Badge, Button, Grid, Group, Modal, NumberInput, Paper, Progress, RingProgress,
  Stack, Table, Text, TextInput,
} from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import { IconAdjustments, IconPlus } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Account, CostPeriod, Spend, Structure } from '../types.ts';
import { centsFrom, count, currencyAffix, currencyName, dateTime, day, money, moneyDisplay, roleLabel, typedFrom } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { N, t } from '../i18n.ts';
import { KpiStrip, LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

export function Money({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [spend, cost, platform, accounts, structure]: [
      Spend, { timeline: CostPeriod[] },
      { companies: Array<{ slug: string; name: string; costCents: number; tokens: number }>; assistant: { costCents: number; tokens: number } },
      { accounts: Account[] }, Structure,
    ] = await Promise.all([
      api('GET', `/api/companies/${companyId}/spend`),
      api('GET', `/api/companies/${companyId}/cost`),
      api('GET', '/api/control/cost'),
      api('GET', `/api/companies/${companyId}/budget-accounts`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { spend, cost, platform, accounts: accounts.accounts, structure };
  }, [companyId], { every: 30_000 });
  const [opening, setOpening] = useState(false);
  const [adjusting, setAdjusting] = useState<Account | null>(null);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Money')}
      description={t('What this company may spend this period, what it has spent, and where. Money is reserved before work starts, so the ceiling holds.')}
      live={view.updatedAt}
      actions={<Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setOpening(true)}>{t('Open an account')}</Button>}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={5} /></>;
  const { spend, cost, platform, accounts, structure } = view.data;
  const used = spend.limitCents > 0 ? (spend.spentCents / spend.limitCents) * 100 : 0;
  const tone = used >= 100 ? 'red' : used >= 80 ? 'orange' : 'brand';
  const topCompany = Math.max(1, ...platform.companies.map((row) => row.costCents), platform.assistant.costCents);

  // Read in the owner's currency (0106): said once, so a rupiah figure is
  // never taken for what was charged.
  const display = moneyDisplay();

  return (
    <Stack gap="lg">
      {header}
      {display && (
        <Text size="sm" c="dimmed">
          {t('Amounts are in {currency}, at {rate} for one US dollar: the rate you set in your settings. PALUGADA counts in US dollars.', {
            currency: currencyName(display.currency), rate: money(100),
          })}
        </Text>
      )}

      <KpiStrip items={[
        { label: t('Spent this period'), value: money(spend.spentCents), hint: `${day(spend.periodStart)} – ${day(spend.periodEnd)}` },
        { label: t('Ceiling'), value: money(spend.limitCents), hint: t('Warns at 80%, pauses at 100%') },
        { label: t('Left'), value: money(Math.max(0, spend.limitCents - spend.spentCents)), alert: used >= 100 },
        {
          label: t('Spending'),
          value: spend.pausedAt ? t('Paused') : t('Allowed'),
          alert: spend.pausedAt !== null,
          hint: spend.overrideUntil ? t('Override until {when}', { when: dateTime(spend.overrideUntil) }) : spend.pauseReason ?? t('No override'),
        },
      ]} />

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Section title={t('The ceiling')}>
            <Group justify="center" mb="md">
              <RingProgress size={180} thickness={16} roundCaps sections={[{ value: Math.min(100, used), color: tone }]}
                label={<Stack gap={0} align="center"><Text fw={800} fz={26}>{Math.round(used)}%</Text><Text size="xs" c="dimmed">{t('used')}</Text></Stack>} />
            </Group>
            <CeilingForm companyId={companyId} spend={spend} changed={view.reload} />
            {spend.pausedAt && <PauseControls companyId={companyId} changed={view.reload} />}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Section title={t('Cost per day')} description={t('Last thirty days.')}>
            {cost.timeline.length === 0 ? <Text size="sm" c="dimmed">{t('Nothing spent yet.')}</Text> : (
              <BarChart
                h={300}
                data={cost.timeline.map((row) => ({ day: day(row.period), cost: row.costCents, tokens: row.tokens }))}
                dataKey="day"
                series={[{ name: 'cost', label: t('Cost'), color: 'brand.6' }]}
                valueFormatter={(value) => money(value)}
                gridAxis="y"
                barProps={{ radius: 4 }}
              />
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Section
        title={t('Accounts')}
        description={t('A budget is a tree: a task draws on the narrowest account that covers it, and a spend counts against every account above.')}
      >
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead><Table.Tr><Table.Th>{t('Account')}</Table.Th><Table.Th>{t('Tokens')}</Table.Th><Table.Th>{t('Money')}</Table.Th><Table.Th /></Table.Tr></Table.Thead>
            <Table.Tbody>
              {accounts.map((account) => {
                const tokenShare = account.tokensMax > 0 ? ((account.tokensSpent + account.tokensReserved) / account.tokensMax) * 100 : 0;
                const moneyShare = account.moneyMaxCents > 0 ? (account.moneySpentCents / account.moneyMaxCents) * 100 : 0;
                return (
                  <Table.Tr key={account.id}>
                    <Table.Td>
                      <Text size="sm" fw={600}>{accountName(account)}</Text>
                      <Text size="xs" c="dimmed">{scopeLabel(account.scopeType)}{account.scopeName ? ` · ${account.scopeName}` : ''}</Text>
                    </Table.Td>
                    <Table.Td w="32%">
                      <Group justify="space-between" mb={4}><Text size="xs">{t('{spent} spent this month · {held} held', { spent: count(account.tokensSpent), held: count(account.tokensReserved) })}</Text><Text size="xs" c="dimmed">{count(account.tokensMax)}</Text></Group>
                      <Progress value={Math.min(100, tokenShare)} color={tokenShare > 90 ? 'red' : 'brand'} size="sm" radius="xl" />
                    </Table.Td>
                    <Table.Td w="32%">
                      {account.moneyMaxCents > 0 ? (
                        <>
                          <Group justify="space-between" mb={4}><Text size="xs">{money(account.moneySpentCents)}</Text><Text size="xs" c="dimmed">{money(account.moneyMaxCents)}</Text></Group>
                          <Progress value={Math.min(100, moneyShare)} color={moneyShare > 90 ? 'red' : 'teal'} size="sm" radius="xl" />
                        </>
                      ) : <Badge variant="light" color="gray">{t('No money ceiling')}</Badge>}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Button size="xs" variant={tokenShare > 90 ? 'light' : 'subtle'} color={tokenShare > 90 ? 'red' : undefined}
                        leftSection={<IconAdjustments size={14} />} onClick={() => setAdjusting(account)}>
                        {t('Ceilings')}
                      </Button>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>

      <Section title={t('Every company')} description={t('The same thirty days, side by side.')}>
        <Stack gap="sm">
          {platform.companies.map((row) => (
            <div key={row.slug}>
              <Group justify="space-between"><Text size="sm" fw={600}>{row.name}</Text><Text size="sm">{money(row.costCents)} <Text span c="dimmed" size="xs">· {t('{count} tokens', { count: count(row.tokens) })}</Text></Text></Group>
              <Progress value={(row.costCents / topCompany) * 100} size="md" mt={4} radius="xl" />
            </div>
          ))}
          {/* PALUGADA's own assistant is no company's, and costs money too (N8). */}
          {platform.assistant.costCents > 0 && (
            <div>
              <Group justify="space-between">
                <Text size="sm" fw={600} c="dimmed">{t("PALUGADA's assistant")}</Text>
                <Text size="sm">{money(platform.assistant.costCents)} <Text span c="dimmed" size="xs">· {t('{count} tokens', { count: count(platform.assistant.tokens) })}</Text></Text>
              </Group>
              <Progress value={(platform.assistant.costCents / topCompany) * 100} size="md" mt={4} radius="xl" color="gray" />
            </div>
          )}
        </Stack>
      </Section>

      <Modal opened={adjusting !== null} onClose={() => setAdjusting(null)} title={t('Ceilings of {account}', { account: adjusting ? accountName(adjusting) : '' })} centered>
        {adjusting && (
          <AccountCeilings companyId={companyId} account={adjusting} changed={() => { setAdjusting(null); view.reload(); }} />
        )}
      </Modal>

      <Modal opened={opening} onClose={() => setOpening(false)} title={t('Open an account')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'label', label: t('Name'), required: true, placeholder: t('Growth experiments') },
            { name: 'tokensMax', label: t('Token ceiling'), type: 'number', required: true },
            { name: 'moneyMax', label: t('Money ceiling'), type: 'money' },
            { name: 'scopeType', label: t('For'), type: 'select', description: t('Blank for the whole company'), options: [
              { value: 'project', label: t('A project') }, { value: 'division', label: t('A division') }, { value: 'role', label: t('A role') },
            ] },
            { name: 'scopeId', label: t('Which one'), type: 'select', options: [
              ...structure.projects.map((one) => ({ value: one.id, label: `${t('Project')} · ${one.name}` })),
              ...structure.divisions.map((one) => ({ value: one.id, label: `${t('Division')} · ${one.name}` })),
              ...structure.roles.map((one) => ({ value: one.id, label: `${t('Role')} · ${roleLabel(one)}` })),
            ] },
            { name: 'parentAccountId', label: t('The account above it'), type: 'select', options: accounts.map((one) => ({ value: one.id, label: accountName(one) })) },
          ]}
          submit={({ moneyMax, ...values }, proof) => api('POST', `/api/companies/${companyId}/budget-accounts`, {
            ...values,
            // Typed in dollars; kept, like every amount, in cents.
            ...(moneyMax === undefined || moneyMax === '' ? {} : { moneyMaxCents: centsFrom(moneyMax) }),
            proof,
          })}
          factor={t('Open a budget account')}
          action={t('Open it')}
          success={t('Account opened.')}
          done={() => { setOpening(false); view.reload(); }}
        />
      </Modal>
    </Stack>
  );
}

const SCOPES: Record<string, string> = {
  company: N('Whole company'), project: N('Project'), division: N('Division'), role: N('Role'),
};

/**
 * An account by what it covers: the name the owner gave it, its division's
 * name, or the whole company (§2.3 item 7). A template labels accounts with
 * the platform's codes, "company" and a division's short name.
 */
function accountName(account: Account): string {
  return account.name ?? t('The whole company');
}

function scopeLabel(scope: string): string {
  const label = SCOPES[scope];
  return label ? t(label) : scope;
}

/**
 * Lowering the ceiling is the session's; raising it takes the factor, like
 * everything else here that loosens a control.
 */
function CeilingForm({ companyId, spend, changed }: { companyId: string; spend: Spend; changed: () => void }) {
  const requireFactor = useFactor();
  const [value, setValue] = useState<number | string>(typedFrom(spend.limitCents));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const moneyMaxCents = centsFrom(value);
    setError(null);
    setBusy(true);
    try {
      if (moneyMaxCents > spend.limitCents) {
        const done = await requireFactor(t('Raise the spend ceiling'), (proof) =>
          api('POST', `/api/companies/${companyId}/spend/limit`, { moneyMaxCents, proof }));
        if (!done) return;
      } else {
        await api('POST', `/api/companies/${companyId}/spend/limit`, { moneyMaxCents });
      }
      notifications.show({ color: 'teal', message: t('Ceiling set.') });
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <NumberInput label={t('Monthly ceiling')} {...currencyAffix()} value={value} onChange={setValue} min={0} decimalScale={2} thousandSeparator style={{ flex: 1 }} />
        <Button loading={busy} onClick={() => void save()}>{t('Set')}</Button>
      </Group>
      <Text size="xs" c="dimmed">{t('Raising it asks for your authenticator; lowering it does not.')}</Text>
      {error && <Alert color="red" variant="light">{error}</Alert>}
    </Stack>
  );
}

/**
 * An account's two ceilings. What it spent counts until the month ends
 * (0101), so this is how an account that ran out gets more before then.
 * Raising either asks for the authenticator; lowering does not.
 */
function AccountCeilings({ companyId, account, changed }: { companyId: string; account: Account; changed: () => void }) {
  const requireFactor = useFactor();
  const [tokens, setTokens] = useState<number | string>(account.tokensMax);
  const [ceiling, setCeiling] = useState<number | string>(typedFrom(account.moneyMaxCents));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const tokensMax = Math.round(Number(tokens));
    const moneyMaxCents = centsFrom(ceiling);
    setError(null);
    setBusy(true);
    try {
      if (tokensMax > account.tokensMax || moneyMaxCents > account.moneyMaxCents) {
        const done = await requireFactor(t('Raise the ceilings of {account}', { account: accountName(account) }), (proof) =>
          api('POST', `/api/companies/${companyId}/budget-accounts/${account.id}/limit`, { tokensMax, moneyMaxCents, proof }));
        if (!done) return;
      } else {
        await api('POST', `/api/companies/${companyId}/budget-accounts/${account.id}/limit`, { tokensMax, moneyMaxCents });
      }
      notifications.show({ color: 'teal', message: t('Ceilings set.') });
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t('{spent} tokens spent this month and {held} held. The count starts again on the first of each month (UTC); raise the ceiling to give the account more before then.', { spent: count(account.tokensSpent), held: count(account.tokensReserved) })}
      </Text>
      <NumberInput label={t('Token ceiling')} value={tokens} onChange={setTokens} min={0} thousandSeparator />
      <NumberInput label={t('Money ceiling')} {...currencyAffix()} value={ceiling} onChange={setCeiling} min={0} decimalScale={2} thousandSeparator />
      <Text size="xs" c="dimmed">{t('Raising either asks for your authenticator; lowering does not.')}</Text>
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button loading={busy} onClick={() => void save()}>{t('Set')}</Button>
      </Group>
    </Stack>
  );
}

/**
 * Both directions of F1.9 together, because they are one decision: an
 * override says "past the ceiling until then", and lifting says "the ceiling
 * was wrong".
 */
function PauseControls({ companyId, changed }: { companyId: string; changed: () => void }) {
  const [until, setUntil] = useState('');
  return (
    <Paper withBorder radius="md" p="sm" mt="md">
      <Text size="sm" fw={600} mb="xs">{t('The company is paused')}</Text>
      <Stack gap="xs">
        <ActionButton
          label={t('Lift the pause')}
          variant="light"
          color="red"
          factor={t('Lift the spend pause')}
          run={(proof) => api('POST', `/api/companies/${companyId}/spend/resume`, { proof })}
          done={changed}
        />
        <TextInput type="datetime-local" label={t('Or override until')} value={until} onChange={(event) => setUntil(event.currentTarget.value)} />
        <ActionButton
          label={t('Override')}
          factor={t('Override the spend pause')}
          run={(proof) => api('POST', `/api/companies/${companyId}/spend/resume`, { until: new Date(until).toISOString(), proof })}
          done={changed}
        />
      </Stack>
    </Paper>
  );
}

