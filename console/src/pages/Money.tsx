/**
 * Money (F1.5-F1.9, F11.3): the period's ceiling and what has been spent
 * against it, cost per day, the account tree underneath, and every company
 * side by side.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Grid, Group, Modal, NumberInput, Paper, Progress, RingProgress, SimpleGrid,
  Stack, Table, Text, TextInput, Title,
} from '@mantine/core';
import { BarChart } from '@mantine/charts';
import { notifications } from '@mantine/notifications';
import { IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Account, CostPeriod, Spend, Structure } from '../types.ts';
import { count, dateTime, day, money } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { LoadFailed, Loading, Section, StatCard } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

export function Money({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [spend, cost, platform, accounts, structure]: [
      Spend, { timeline: CostPeriod[] }, { companies: Array<{ slug: string; costCents: number; tokens: number }> },
      { accounts: Account[] }, Structure,
    ] = await Promise.all([
      api('GET', `/api/companies/${companyId}/spend`),
      api('GET', `/api/companies/${companyId}/cost`),
      api('GET', '/api/control/cost'),
      api('GET', `/api/companies/${companyId}/budget-accounts`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { spend, cost, platform, accounts: accounts.accounts, structure };
  }, [companyId]);
  const [opening, setOpening] = useState(false);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={5} />;
  const { spend, cost, platform, accounts, structure } = view.data;
  const used = spend.limitCents > 0 ? (spend.spentCents / spend.limitCents) * 100 : 0;
  const tone = used >= 100 ? 'red' : used >= 80 ? 'orange' : 'blue';
  const topCompany = Math.max(1, ...platform.companies.map((row) => row.costCents));

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>Money</Title>
      </div>

      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard label="Spent this period" value={money(spend.spentCents)} hint={`${day(spend.periodStart)} – ${day(spend.periodEnd)}`} />
        <StatCard label="Ceiling" value={money(spend.limitCents)} hint="Warns at 80%, pauses at 100%" />
        <StatCard label="Left" value={money(Math.max(0, spend.limitCents - spend.spentCents))} alert={used >= 100} />
        <StatCard label="State" value={spend.pausedAt ? 'Paused' : 'Running'} alert={spend.pausedAt !== null}
          hint={spend.overrideUntil ? `Override until ${dateTime(spend.overrideUntil)}` : spend.pauseReason ?? 'No override'} />
      </SimpleGrid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Section title="The ceiling">
            <Group justify="center" mb="md">
              <RingProgress size={180} thickness={16} roundCaps sections={[{ value: Math.min(100, used), color: tone }]}
                label={<Stack gap={0} align="center"><Text fw={800} fz={26}>{Math.round(used)}%</Text><Text size="xs" c="dimmed">used</Text></Stack>} />
            </Group>
            <CeilingForm companyId={companyId} spend={spend} changed={view.reload} />
            {spend.pausedAt && <PauseControls companyId={companyId} changed={view.reload} />}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Section title="Cost per day" description="Last thirty days.">
            {cost.timeline.length === 0 ? <Text size="sm" c="dimmed">Nothing spent yet.</Text> : (
              <BarChart
                h={300}
                data={cost.timeline.map((row) => ({ day: day(row.period), cost: row.costCents / 100, tokens: row.tokens }))}
                dataKey="day"
                series={[{ name: 'cost', label: 'Cost', color: 'blue.6' }]}
                valueFormatter={(value) => value.toFixed(2)}
                gridAxis="y"
                barProps={{ radius: 4 }}
              />
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Section
        title="Accounts"
        description="A budget is a tree: a task draws on the narrowest account that covers it, and a spend counts against every account above (F1.6)."
        actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setOpening(true)}>Open an account</Button>}
      >
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead><Table.Tr><Table.Th>Account</Table.Th><Table.Th>Tokens</Table.Th><Table.Th>Money</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>
              {accounts.map((account) => {
                const tokenShare = account.tokensMax > 0 ? ((account.tokensSpent + account.tokensReserved) / account.tokensMax) * 100 : 0;
                const moneyShare = account.moneyMaxCents > 0 ? (account.moneySpentCents / account.moneyMaxCents) * 100 : 0;
                return (
                  <Table.Tr key={account.id}>
                    <Table.Td>
                      <Text size="sm" fw={600}>{account.label}</Text>
                      <Text size="xs" c="dimmed">{account.scopeType}{account.scopeName ? ` · ${account.scopeName}` : ''}</Text>
                    </Table.Td>
                    <Table.Td w="32%">
                      <Group justify="space-between" mb={4}><Text size="xs">{count(account.tokensSpent)} spent · {count(account.tokensReserved)} held</Text><Text size="xs" c="dimmed">{count(account.tokensMax)}</Text></Group>
                      <Progress value={Math.min(100, tokenShare)} color={tokenShare > 90 ? 'red' : 'blue'} size="sm" />
                    </Table.Td>
                    <Table.Td w="32%">
                      {account.moneyMaxCents > 0 ? (
                        <>
                          <Group justify="space-between" mb={4}><Text size="xs">{money(account.moneySpentCents)}</Text><Text size="xs" c="dimmed">{money(account.moneyMaxCents)}</Text></Group>
                          <Progress value={Math.min(100, moneyShare)} color={moneyShare > 90 ? 'red' : 'teal'} size="sm" />
                        </>
                      ) : <Badge variant="light" color="gray">No money ceiling</Badge>}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>

      <Section title="Every company" description="The same thirty days, side by side.">
        <Stack gap="sm">
          {platform.companies.map((row) => (
            <div key={row.slug}>
              <Group justify="space-between"><Text size="sm" fw={600}>{row.slug}</Text><Text size="sm">{money(row.costCents)} <Text span c="dimmed" size="xs">· {count(row.tokens)} tokens</Text></Text></Group>
              <Progress value={(row.costCents / topCompany) * 100} size="md" mt={4} radius="xl" />
            </div>
          ))}
        </Stack>
      </Section>

      <Modal opened={opening} onClose={() => setOpening(false)} title="Open an account" centered size="lg">
        <ActionForm
          fields={[
            { name: 'label', label: 'Name', required: true, placeholder: 'Growth experiments' },
            { name: 'tokensMax', label: 'Token ceiling', type: 'number', required: true },
            { name: 'moneyMaxCents', label: 'Money ceiling (cents)', type: 'number' },
            { name: 'scopeType', label: 'For', type: 'select', description: 'Blank for the whole company', options: [
              { value: 'project', label: 'A project' }, { value: 'division', label: 'A division' }, { value: 'role', label: 'A role' },
            ] },
            { name: 'scopeId', label: 'Which one', type: 'select', options: [
              ...structure.projects.map((one) => ({ value: one.id, label: `Project · ${one.name}` })),
              ...structure.divisions.map((one) => ({ value: one.id, label: `Division · ${one.name}` })),
              ...structure.roles.map((one) => ({ value: one.id, label: `Role · ${one.slug}` })),
            ] },
            { name: 'parentAccountId', label: 'The account above it', type: 'select', options: accounts.map((one) => ({ value: one.id, label: one.label })) },
          ]}
          submit={(values, proof) => api('POST', `/api/companies/${companyId}/budget-accounts`, { ...values, proof })}
          factor="Open a budget account"
          action="Open it"
          success="Account opened."
          done={() => { setOpening(false); view.reload(); }}
        />
      </Modal>
    </Stack>
  );
}

/**
 * Lowering the ceiling is the session's; raising it takes the factor, like
 * everything else here that loosens a control.
 */
function CeilingForm({ companyId, spend, changed }: { companyId: string; spend: Spend; changed: () => void }) {
  const requireFactor = useFactor();
  const [value, setValue] = useState<number | string>(spend.limitCents / 100);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const moneyMaxCents = Math.round(Number(value) * 100);
    setError(null);
    setBusy(true);
    try {
      if (moneyMaxCents > spend.limitCents) {
        const done = await requireFactor('Raise the spend ceiling', (proof) =>
          api('POST', `/api/companies/${companyId}/spend/limit`, { moneyMaxCents, proof }));
        if (!done) return;
      } else {
        await api('POST', `/api/companies/${companyId}/spend/limit`, { moneyMaxCents });
      }
      notifications.show({ color: 'teal', message: 'Ceiling set.' });
      changed();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack gap="xs">
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <NumberInput label="Monthly ceiling" value={value} onChange={setValue} min={0} decimalScale={2} thousandSeparator="," style={{ flex: 1 }} />
        <Button loading={busy} onClick={() => void save()}>Set</Button>
      </Group>
      <Text size="xs" c="dimmed">Raising it asks for your authenticator; lowering it does not.</Text>
      {error && <Alert color="red" variant="light">{error}</Alert>}
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
      <Text size="sm" fw={600} mb="xs">The company is paused</Text>
      <Stack gap="xs">
        <ActionButton
          label="Lift the pause"
          variant="light"
          color="red"
          factor="Lift the spend pause"
          run={(proof) => api('POST', `/api/companies/${companyId}/spend/resume`, { proof })}
          done={changed}
        />
        <TextInput type="datetime-local" label="Or override until" value={until} onChange={(event) => setUntil(event.currentTarget.value)} />
        <ActionButton
          label="Override"
          factor="Override the spend pause"
          run={(proof) => api('POST', `/api/companies/${companyId}/spend/resume`, { until: new Date(until).toISOString(), proof })}
          done={changed}
        />
      </Stack>
    </Paper>
  );
}

