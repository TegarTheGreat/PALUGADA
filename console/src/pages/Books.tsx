/**
 * Books (0119, STATUS 2.139): the company's own books, by double entry.
 *
 * Every account and what it holds, this month's profit, and the latest
 * entries. The owner adds an account, records an entry and reverses a
 * mistake here with the session: the books move no money, and an entry is
 * never rewritten -- a reversal stands beside what it undoes. A seat reads
 * them. The bookkeeper writes to the same books with `ledger.record`.
 */
import { useState } from 'react';
import {
  ActionIcon, Badge, Button, Group, Modal, NumberInput, Paper, Select, Stack, Table, Tabs, Text, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowBackUp, IconPlus, IconTrash } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { inCurrency, moneyDisplay, numberSeparators } from '../format.ts';
import { N, locale, t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import type { BookAccount, Books as BooksView, JournalEntry } from '../types.ts';
import { ActionButton } from '../components/ActionForm.tsx';
import { Invoices } from '../components/Invoices.tsx';
import { EmptyState, KpiStrip, LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';

/** The accounts the books open with, by what the platform knows them as, in the owner's language. */
const SYSTEM_NAMES: Record<string, string> = {
  cash: N('Cash and bank'),
  receivable: N('Accounts receivable'),
  payable: N('Accounts payable'),
  tax: N('Taxes owed'),
  equity: N('Owner\'s equity'),
  revenue: N('Sales'),
  expense: N('Expenses'),
};

const KINDS: Record<BookAccount['kind'], string> = {
  asset: N('Asset'),
  liability: N('Liability'),
  equity: N('Equity'),
  income: N('Income'),
  expense: N('Expense'),
};

function accountSaid(account: { systemKey: string | null; name: string }): string {
  return account.systemKey && SYSTEM_NAMES[account.systemKey] ? t(SYSTEM_NAMES[account.systemKey]!) : account.name;
}

const amount = inCurrency;

export function Books({ ctx }: PageProps) {
  const { companyId } = ctx;
  const owner = ctx.staff === null;
  const view = useLoad<BooksView>(() => api('GET', `/api/companies/${companyId}/books`), [companyId]);
  const [adding, setAdding] = useState(false);
  const [recording, setRecording] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [tab, setTab] = useState<string | null>('ledger');

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Books')}
      description={t('The company\'s own books, by double entry: every entry\'s debits equal its credits, and a mistake is undone by a reversing entry beside it.')}
      actions={owner
        ? (tab === 'invoices'
          ? <Button leftSection={<IconPlus size={16} />} onClick={() => setIssuing(true)}>{t('Issue an invoice')}</Button>
          : <Button leftSection={<IconPlus size={16} />} onClick={() => setRecording(true)}>{t('Record an entry')}</Button>)
        : undefined}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={4} /></>;
  const { accounts, entries, month } = view.data;

  return (
    <Stack gap="lg">
      {header}
      <Tabs value={tab} onChange={setTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="ledger">{t('Ledger')}</Tabs.Tab>
          <Tabs.Tab value="invoices">{t('Invoices')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="ledger" pt="lg">
      <Stack gap="lg">
      {month.profit.length > 0 && (
        <KpiStrip items={month.profit.flatMap((one) => [
          { label: t('Income this month'), value: amount(one.incomeCents, one.currency) },
          { label: t('Expenses this month'), value: amount(one.expenseCents, one.currency) },
          { label: t('Profit this month'), value: amount(one.profitCents, one.currency), alert: one.profitCents < 0 },
        ])} />
      )}

      <Section
        title={t('Accounts')}
        actions={owner ? <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('Add an account')}</Button> : undefined}
      >
        <Table.ScrollContainer minWidth={420}>
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr><Table.Th>{t('Code')}</Table.Th><Table.Th>{t('Account')}</Table.Th><Table.Th>{t('Kind')}</Table.Th><Table.Th ta="right">{t('Balance')}</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {accounts.map((account) => (
                <Table.Tr key={account.id}>
                  <Table.Td><Text size="sm" className="tabular">{account.code}</Text></Table.Td>
                  <Table.Td><Text size="sm">{accountSaid(account)}</Text></Table.Td>
                  <Table.Td><Text size="sm" c="dimmed">{t(KINDS[account.kind])}</Text></Table.Td>
                  <Table.Td ta="right">
                    <Text size="sm" className="tabular">
                      {account.balances.length === 0 ? '—' : account.balances.map((one) => amount(one.cents, one.currency)).join(' · ')}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Section>

      <Section title={t('Entries')} description={t('The latest first.')}>
        {entries.length === 0 ? (
          <EmptyState title={t('No entry yet')} description={t('What the company earns and spends is recorded here, by you or by the bookkeeper.')} />
        ) : (
          <Stack gap="xs">
            {entries.map((entry) => <EntryRow key={entry.id} companyId={companyId} entry={entry} owner={owner} changed={view.reload} />)}
          </Stack>
        )}
      </Section>

      </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="invoices" pt="lg">
          <Invoices
            companyId={companyId} owner={owner} issuing={issuing} closeIssue={() => setIssuing(false)} changed={view.reload}
            depositOptions={accounts.filter((account) => account.kind === 'asset' && !account.archivedAt && account.systemKey !== 'receivable')
              .map((account) => ({ value: account.code, label: `${account.code} ${accountSaid(account)}` }))}
          />
        </Tabs.Panel>
      </Tabs>

      <AddAccount companyId={companyId} opened={adding} close={() => setAdding(false)} done={() => { setAdding(false); view.reload(); }} />
      <RecordEntry companyId={companyId} accounts={accounts} opened={recording} close={() => setRecording(false)}
        done={() => { setRecording(false); view.reload(); }} />
    </Stack>
  );
}

function EntryRow({ companyId, entry, owner, changed }: { companyId: string; entry: JournalEntry; owner: boolean; changed: () => void }) {
  return (
    <Paper withBorder radius="md" p="sm" style={{ opacity: entry.reversedBy ? 0.7 : 1 }}>
      <Group justify="space-between" wrap="wrap" gap="xs" align="flex-start">
        <div style={{ minWidth: 0, flex: 1 }}>
          <Group gap={6} wrap="wrap">
            <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{entry.memo}</Text>
            {entry.reverses && <Badge size="xs" variant="light" color="gray">{t('A reversal')}</Badge>}
            {entry.reversedBy && <Badge size="xs" variant="light" color="gray">{t('Reversed')}</Badge>}
            {entry.writtenBy === 'agent' && <Badge size="xs" variant="outline" color="gray">{t('By an agent')}</Badge>}
          </Group>
          <Text size="xs" c="dimmed">{new Date(`${entry.date}T00:00:00`).toLocaleDateString(locale())}</Text>
          <Stack gap={0} mt={4}>
            {entry.lines.map((line, n) => (
              <Group key={n} gap="xs" wrap="nowrap" justify="space-between">
                <Text size="xs" style={{ overflowWrap: 'anywhere', paddingLeft: line.creditCents > 0 ? 16 : 0 }}>{line.account} {line.name}</Text>
                <Text size="xs" className="tabular" style={{ flexShrink: 0 }}>
                  {line.debitCents > 0 ? t('Debit {amount}', { amount: amount(line.debitCents, entry.currency) }) : t('Credit {amount}', { amount: amount(line.creditCents, entry.currency) })}
                </Text>
              </Group>
            ))}
          </Stack>
        </div>
        {owner && !entry.reverses && !entry.reversedBy && (
          <ActionButton size="xs" variant="subtle" color="gray" label={t('Reverse')} leftSection={<IconArrowBackUp size={14} />}
            run={() => api('POST', `/api/companies/${companyId}/books/entries/${entry.id}/reverse`, {})} done={changed} />
        )}
      </Group>
    </Paper>
  );
}

function AddAccount({ companyId, opened, close, done }: { companyId: string; opened: boolean; close: () => void; done: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<BookAccount['kind']>('expense');
  return (
    <Modal opened={opened} onClose={close} title={t('Add an account')} centered>
      <Stack gap="sm">
        <Group grow align="flex-start" wrap="wrap">
          <TextInput label={t('Code')} placeholder="5200" value={code} onChange={(event) => setCode(event.currentTarget.value)} style={{ minWidth: 100 }} inputMode="numeric" />
          <Select label={t('Kind')} value={kind} allowDeselect={false} style={{ minWidth: 140 }}
            data={(Object.keys(KINDS) as Array<BookAccount['kind']>).map((one) => ({ value: one, label: t(KINDS[one]) }))}
            onChange={(next) => setKind((next ?? 'expense') as BookAccount['kind'])} />
        </Group>
        <TextInput label={t('Name')} placeholder={t('e.g. Rent')} value={name} onChange={(event) => setName(event.currentTarget.value)} />
        <Group justify="flex-end">
          <ActionButton variant="filled" label={t('Add it')}
            run={async () => {
              await api('POST', `/api/companies/${companyId}/books/accounts`, { code: code.trim(), name: name.trim(), kind });
              setCode(''); setName('');
            }} done={done} />
        </Group>
      </Stack>
    </Modal>
  );
}

interface Line { account: string | null; debit: number | ''; credit: number | '' }

function RecordEntry({ companyId, accounts, opened, close, done }: {
  companyId: string; accounts: BookAccount[]; opened: boolean; close: () => void; done: () => void;
}) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState('');
  const [currency, setCurrency] = useState(moneyDisplay()?.currency ?? 'USD');
  const [lines, setLines] = useState<Line[]>([{ account: null, debit: '', credit: '' }, { account: null, debit: '', credit: '' }]);
  const [busy, setBusy] = useState(false);
  const cents = (value: number | '') => (value === '' ? 0 : Math.round(value * 100));
  const debits = lines.reduce((sum, line) => sum + cents(line.debit), 0);
  const credits = lines.reduce((sum, line) => sum + cents(line.credit), 0);
  const options = accounts.filter((account) => !account.archivedAt).map((account) => ({ value: account.code, label: `${account.code} ${accountSaid(account)}` }));
  const change = (n: number, next: Partial<Line>) => setLines((was) => was.map((line, at) => (at === n ? { ...line, ...next } : line)));

  const save = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/books/entries`, {
        date, memo, currency,
        lines: lines.filter((line) => line.account && (cents(line.debit) > 0 || cents(line.credit) > 0)).map((line) => (cents(line.debit) > 0
          ? { account: line.account, debitCents: cents(line.debit) }
          : { account: line.account, creditCents: cents(line.credit) })),
      });
      setMemo('');
      setLines([{ account: null, debit: '', credit: '' }, { account: null, debit: '', credit: '' }]);
      done();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Record an entry')} centered size="lg">
      <Stack gap="sm">
        <Group grow align="flex-start" wrap="wrap">
          <TextInput type="date" label={t('Date')} value={date} onChange={(event) => setDate(event.currentTarget.value)} style={{ minWidth: 150 }} />
          <TextInput label={t('Currency')} maxLength={3} value={currency} onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} style={{ minWidth: 90 }} />
        </Group>
        <TextInput label={t('Memo')} placeholder={t('e.g. Rent for October')} value={memo} onChange={(event) => setMemo(event.currentTarget.value)} />
        {lines.map((line, n) => (
          <Group key={n} gap="xs" align="flex-end" wrap="wrap">
            <Select label={n === 0 ? t('Account') : undefined} data={options} value={line.account} searchable style={{ flex: 2, minWidth: 180 }}
              onChange={(next) => change(n, { account: next })} />
            <NumberInput label={n === 0 ? t('Debit') : undefined} min={0} value={line.debit} allowDecimal {...numberSeparators()} style={{ flex: 1, minWidth: 110 }}
              onChange={(next) => change(n, { debit: typeof next === 'number' ? next : '', ...(typeof next === 'number' && next > 0 ? { credit: '' } : {}) })} />
            <NumberInput label={n === 0 ? t('Credit') : undefined} min={0} value={line.credit} allowDecimal {...numberSeparators()} style={{ flex: 1, minWidth: 110 }}
              onChange={(next) => change(n, { credit: typeof next === 'number' ? next : '', ...(typeof next === 'number' && next > 0 ? { debit: '' } : {}) })} />
            {lines.length > 2 && (
              <ActionIcon variant="subtle" color="gray" aria-label={t('Remove the line')} onClick={() => setLines((was) => was.filter((_, at) => at !== n))}>
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
        ))}
        <Group justify="space-between" wrap="wrap">
          <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setLines((was) => [...was, { account: null, debit: '', credit: '' }])}>
            {t('Add a line')}
          </Button>
          <Text size="sm" c={debits === credits && debits > 0 ? 'teal' : 'red'} className="tabular">
            {t('Debits {debits} · credits {credits}', { debits: amount(debits, /^[A-Z]{3}$/.test(currency) ? currency : 'USD'), credits: amount(credits, /^[A-Z]{3}$/.test(currency) ? currency : 'USD') })}
          </Text>
        </Group>
        <Group justify="flex-end">
          <Button loading={busy} disabled={!memo.trim() || debits === 0 || debits !== credits} onClick={() => void save()}>{t('Record it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
