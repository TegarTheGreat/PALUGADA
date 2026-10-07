/**
 * The company's invoices (0122, STATUS 2.154), on the Books page.
 *
 * What the company bills is kept here, numbered without gaps and written in the
 * books with the entry that puts what is owed in them. The owner issues one,
 * takes a payment against it, or voids it -- all with the session: it is
 * written in the books and sent nowhere, and it is voided, not edited. The
 * bookkeeper writes to the same invoices with `invoice.issue` and records a
 * payment with `ledger.record`; a seat reads them.
 */
import { useState } from 'react';
import {
  ActionIcon, Alert, Badge, Button, CopyButton, Group, Modal, NumberInput, Paper, Select, Stack, Switch, Table, Text, Textarea, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconPlus, IconTrash } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { saveCompanyFile } from '../files.ts';
import { useLoad } from '../hooks.ts';
import { inCurrency, moneyDisplay, numberSeparators } from '../format.ts';
import { locale, t } from '../i18n.ts';
import type { Collections, Contact, InvoiceDetail, InvoiceRow, Invoices as InvoicesView } from '../types.ts';
import { ActionButton, ActionForm } from './ActionForm.tsx';
import { EmptyState, KpiStrip, LoadFailed, Loading } from './ui.tsx';

const today = () => new Date().toISOString().slice(0, 10);
const dayShown = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(locale());

function StatusBadge({ invoice }: { invoice: Pick<InvoiceRow, 'status' | 'overdue'> }) {
  if (invoice.overdue) return <Badge size="sm" variant="light" color="red">{t('Overdue')}</Badge>;
  switch (invoice.status) {
    case 'paid': return <Badge size="sm" variant="light" color="teal">{t('Paid')}</Badge>;
    case 'partial': return <Badge size="sm" variant="light" color="yellow">{t('Part paid')}</Badge>;
    case 'void': return <Badge size="sm" variant="light" color="gray">{t('Void')}</Badge>;
    default: return <Badge size="sm" variant="light" color="blue">{t('Open')}</Badge>;
  }
}

export function Invoices({ companyId, owner, issuing, closeIssue, depositOptions, changed }: {
  companyId: string;
  owner: boolean;
  issuing: boolean;
  closeIssue: () => void;
  /** The asset accounts a payment may be taken into, by code and name. */
  depositOptions: Array<{ value: string; label: string }>;
  /** What the invoices moved in the books, which the page above reads again. */
  changed: () => void;
}) {
  const view = useLoad<InvoicesView>(() => api('GET', `/api/companies/${companyId}/invoices`), [companyId]);
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => { view.reload(); changed(); };

  if (view.error && !view.data) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={3} />;
  const { invoices, outstanding, reminding, collections } = view.data;

  return (
    <Stack gap="lg">
      {outstanding.length > 0 && (
        <KpiStrip items={outstanding.flatMap((one) => [
          { label: t('Owed to you'), value: inCurrency(one.outstandingCents, one.currency) },
          { label: t('Overdue'), value: inCurrency(one.overdueCents, one.currency), alert: one.overdueCents > 0 },
        ])} />
      )}
      <RemindersPanel companyId={companyId} owner={owner} collections={collections} changed={view.reload} />
      {invoices.length === 0 ? (
        <Paper withBorder radius="lg">
          <EmptyState
            title={t('No invoice yet')}
            description={t('What you bill customers is kept here, numbered, and paid or voided in the books. Nothing is sent to a customer from here.')}
          />
        </Paper>
      ) : (
        <Paper withBorder radius="lg" p="md">
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="xs" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('Number')}</Table.Th><Table.Th>{t('Customer')}</Table.Th><Table.Th>{t('Due')}</Table.Th>
                  <Table.Th ta="right">{t('Total')}</Table.Th><Table.Th ta="right">{t('Owed')}</Table.Th><Table.Th>{t('Status')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {invoices.map((invoice) => (
                  <Table.Tr key={invoice.id} onClick={() => setOpen(invoice.id)} style={{ cursor: 'pointer' }}>
                    <Table.Td><Text size="sm" fw={600} className="tabular">{invoice.number}</Text></Table.Td>
                    <Table.Td><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{invoice.customerName}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{dayShown(invoice.dueDate)}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" className="tabular">{inCurrency(invoice.totalCents, invoice.currency)}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" className="tabular">{inCurrency(invoice.outstandingCents, invoice.currency)}</Text></Table.Td>
                    <Table.Td>
                      <StatusBadge invoice={invoice} />
                      {reminding[invoice.id]?.held && invoice.outstandingCents > 0
                        ? <Badge size="xs" variant="outline" color="gray" ml={6}>{t('Left alone')}</Badge>
                        : reminding[invoice.id]?.lastOn && invoice.outstandingCents > 0
                          ? <Text size="xs" c="dimmed">{t('Last reminder {date}', { date: dayShown(reminding[invoice.id]!.lastOn!) })}</Text>
                          : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
      <IssueInvoice companyId={companyId} opened={issuing} close={closeIssue} done={() => { closeIssue(); reload(); }} />
      <InvoiceView companyId={companyId} id={open} owner={owner} close={() => setOpen(null)} depositOptions={depositOptions} changed={reload} />
    </Stack>
  );
}

/**
 * Reminding customers about overdue invoices (STATUS 2.178): a letter written
 * from the books, on the days the owner sets, by the roles that bill customers
 * or the CEO. The switch is the owner's decision to let them; what is sent and
 * to whom is never a model's.
 */
function RemindersPanel({ companyId, owner, collections, changed }: {
  companyId: string; owner: boolean; collections: Collections; changed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const path = `/api/companies/${companyId}/collections`;
  const flip = async (enabled: boolean) => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/collections`, { enabled });
      notifications.show({ color: 'teal', message: t('Saved.') });
      changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };
  const nobody = collections.enabled && collections.senders.names.length === 0;
  return (
    <Paper withBorder radius="lg" p="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <div style={{ minWidth: 0 }}>
          <Text fw={600}>{t('Reminders for overdue invoices')}</Text>
          <Text size="sm" c="dimmed">{t('A letter written from the books goes to the customer on the days below. You are told only about an invoice a letter did not mend.')}</Text>
        </div>
        <Switch checked={collections.enabled} disabled={!owner || busy} aria-label={t('Remind customers about overdue invoices')}
          onChange={(event) => void flip(event.currentTarget.checked)} />
      </Group>
      {collections.enabled && (
        <Stack gap="sm" mt="md">
          {collections.senders.names.length > 0 && (
            <Text size="sm" c="dimmed">{t('Sent by {roles}.', { roles: collections.senders.names.join(', ') })}</Text>
          )}
          {nobody && (
            <Alert color="yellow" variant="light">
              <Text size="sm">{t('No role can send reminders yet. This lets the roles that issue invoices send them, or hires a bookkeeper when none does.')}</Text>
              {owner && (
                <Group mt="xs">
                  <ActionButton size="xs" variant="default" label={t('Let them send reminders')} run={() => api('POST', path, { enabled: true })} done={changed} />
                </Group>
              )}
            </Alert>
          )}
          {owner && (
            <ActionForm
              columns={1}
              fields={[
                { name: 'days', label: t('Days after the due date'), initial: collections.stepsDays.join(', '), placeholder: '3, 10, 24' },
                {
                  name: 'note', label: t('How customers pay'), type: 'textarea', initial: collections.paymentNote ?? '',
                  description: t('Added to every reminder. Left out when empty.'),
                },
              ]}
              action={t('Save')}
              success={t('Saved.')}
              submit={(values) => api('POST', path, {
                stepsDays: String(values.days).split(/[\s,;]+/).filter(Boolean).map(Number),
                paymentNote: String(values.note).trim() === '' ? null : String(values.note),
              })}
              done={changed}
            />
          )}
        </Stack>
      )}
    </Paper>
  );
}

/** What an invoice says, as plain text to paste into a message. */
function invoiceText(invoice: InvoiceDetail): string {
  return [
    t('Invoice {number}', { number: invoice.number }),
    invoice.customerName,
    t('Issued {date}', { date: dayShown(invoice.issueDate) }) + ' · ' + t('Due {date}', { date: dayShown(invoice.dueDate) }),
    '',
    ...invoice.lines.map((line) => `${line.description}: ${line.quantity} × ${inCurrency(line.unitCents, invoice.currency)} = ${inCurrency(line.amountCents, invoice.currency)}`),
    '',
    ...(invoice.taxCents > 0 ? [`${t('Tax')} ${invoice.taxRateBps / 100}%: ${inCurrency(invoice.taxCents, invoice.currency)}`] : []),
    `${t('Total')}: ${inCurrency(invoice.totalCents, invoice.currency)}`,
    ...(invoice.paidCents > 0 ? [`${t('Paid')}: ${inCurrency(invoice.paidCents, invoice.currency)}`, `${t('Owed')}: ${inCurrency(invoice.outstandingCents, invoice.currency)}`] : []),
    ...(invoice.note ? ['', invoice.note] : []),
  ].join('\n');
}

function InvoiceView({ companyId, id, owner, close, depositOptions, changed }: {
  companyId: string; id: string | null; owner: boolean; close: () => void; depositOptions: Array<{ value: string; label: string }>; changed: () => void;
}) {
  const detail = useLoad<InvoiceDetail | null>(
    () => (id ? api('GET', `/api/companies/${companyId}/invoices/${id}`) : Promise.resolve(null)), [companyId, id]);
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const invoice = detail.data;
  const reload = () => { detail.reload(); changed(); };

  return (
    <Modal opened={id !== null} onClose={() => { close(); setPaying(false); setVoiding(false); }} size="lg" centered
      title={<Text fw={700}>{invoice ? t('Invoice {number}', { number: invoice.number }) : t('Invoices')}</Text>}>
      {detail.error && !invoice ? <LoadFailed message={detail.error} retry={detail.reload} /> : !invoice ? <Loading rows={3} /> : (
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" wrap="wrap">
            <div style={{ minWidth: 0 }}>
              <Text fw={600} style={{ overflowWrap: 'anywhere' }}>{invoice.customerName}</Text>
              {invoice.customerEmail && <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{invoice.customerEmail}</Text>}
              <Text size="xs" c="dimmed">{t('Issued {date}', { date: dayShown(invoice.issueDate) })} · {t('Due {date}', { date: dayShown(invoice.dueDate) })}</Text>
            </div>
            <Group gap={6}>
              <StatusBadge invoice={invoice} />
              {invoice.writtenBy === 'agent' && <Badge size="sm" variant="outline" color="gray">{t('By an agent')}</Badge>}
            </Group>
          </Group>

          <Table.ScrollContainer minWidth={420}>
            <Table verticalSpacing={4}>
              <Table.Tbody>
                {invoice.lines.map((line, n) => (
                  <Table.Tr key={n}>
                    <Table.Td><Text size="sm" style={{ overflowWrap: 'anywhere' }}>{line.description}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="xs" c="dimmed" className="tabular">{line.quantity} × {inCurrency(line.unitCents, invoice.currency)}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" className="tabular">{inCurrency(line.amountCents, invoice.currency)}</Text></Table.Td>
                  </Table.Tr>
                ))}
                {invoice.taxCents > 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={2}><Text size="sm" c="dimmed">{t('Tax')} {invoice.taxRateBps / 100}%</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" className="tabular">{inCurrency(invoice.taxCents, invoice.currency)}</Text></Table.Td>
                  </Table.Tr>
                )}
                <Table.Tr>
                  <Table.Td colSpan={2}><Text size="sm" fw={700}>{t('Total')}</Text></Table.Td>
                  <Table.Td ta="right"><Text size="sm" fw={700} className="tabular">{inCurrency(invoice.totalCents, invoice.currency)}</Text></Table.Td>
                </Table.Tr>
                {invoice.status !== 'void' && invoice.paidCents > 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={2}><Text size="sm" c="dimmed">{t('Owed')}</Text></Table.Td>
                    <Table.Td ta="right"><Text size="sm" className="tabular">{inCurrency(invoice.outstandingCents, invoice.currency)}</Text></Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>

          {invoice.note && <Text size="sm" c="dimmed" style={{ overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{invoice.note}</Text>}

          {invoice.payments.length > 0 && (
            <Stack gap={4}>
              <Text size="sm" fw={600}>{t('Payments')}</Text>
              {invoice.payments.map((payment) => (
                <Group key={payment.id} justify="space-between" wrap="nowrap" style={{ opacity: payment.reversed ? 0.6 : 1 }}>
                  <Group gap={6} wrap="wrap">
                    <Text size="sm">{dayShown(payment.paidOn)}</Text>
                    {payment.reversed && <Badge size="xs" variant="light" color="gray">{t('Reversed')}</Badge>}
                  </Group>
                  <Text size="sm" className="tabular" td={payment.reversed ? 'line-through' : undefined}>{inCurrency(payment.amountCents, invoice.currency)}</Text>
                </Group>
              ))}
            </Stack>
          )}

          {(invoice.reminders.length > 0 || invoice.held) && (
            <Stack gap={4}>
              <Group gap={6}>
                <Text size="sm" fw={600}>{t('Reminders')}</Text>
                {invoice.held && <Badge size="xs" variant="outline" color="gray">{t('Left alone')}</Badge>}
              </Group>
              {invoice.reminders.map((one) => (
                <Text key={one.step} size="sm" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                  {t('Reminder {step} · {date} · {address}', { step: one.step, date: dayShown(one.sentOn), address: one.to })}
                </Text>
              ))}
            </Stack>
          )}

          {voiding && (
            <Alert color="red" variant="light" title={t('Void {number}?', { number: invoice.number })}>
              <Text size="sm" mb="sm">{t('What was owed on it comes out of the books, and its number is not used again.')}</Text>
              <Group gap="xs">
                <Button size="xs" variant="default" onClick={() => setVoiding(false)}>{t('Keep it')}</Button>
                <ActionButton size="xs" variant="filled" color="red" label={t('Void it')}
                  run={() => api('POST', `/api/companies/${companyId}/invoices/${invoice.id}/void`, {})}
                  done={() => { setVoiding(false); reload(); }} />
              </Group>
            </Alert>
          )}

          <Group justify="space-between" wrap="wrap">
            <Group gap="xs">
              <CopyButton value={invoiceText(invoice)}>
                {({ copied, copy }) => <Button size="xs" variant="default" onClick={copy}>{copied ? t('Copied') : t('Copy as text')}</Button>}
              </CopyButton>
              {owner && invoice.status !== 'void' && (
                <ActionButton size="xs" variant="default" label={t('Download PDF')} leftSection={<IconDownload size={14} />}
                  run={async () => {
                    const made: { path: string } = await api('POST', `/api/companies/${companyId}/invoices/${invoice.id}/pdf`, {});
                    await saveCompanyFile(companyId, made.path);
                  }} />
              )}
            </Group>
            {owner && invoice.status !== 'void' && (
              <Group gap="xs">
                {invoice.outstandingCents > 0 && (
                  <ActionButton size="xs" variant="subtle"
                    label={invoice.held ? t('Remind about this invoice again') : t('Stop reminding about this invoice')}
                    run={() => api('POST', `/api/companies/${companyId}/invoices/${invoice.id}/reminders`, { held: !invoice.held })}
                    done={reload} />
                )}
                {invoice.paidCents === 0 && <Button size="xs" variant="subtle" color="red" onClick={() => setVoiding(true)}>{t('Void the invoice')}</Button>}
                {invoice.outstandingCents > 0 && <Button size="xs" onClick={() => setPaying(true)}>{t('Record a payment')}</Button>}
              </Group>
            )}
          </Group>

          <RecordPayment companyId={companyId} invoice={invoice} opened={paying} close={() => setPaying(false)} depositOptions={depositOptions}
            done={() => { setPaying(false); reload(); }} />
        </Stack>
      )}
    </Modal>
  );
}

function RecordPayment({ companyId, invoice, opened, close, done, depositOptions }: {
  companyId: string; invoice: InvoiceDetail; opened: boolean; close: () => void; done: () => void; depositOptions: Array<{ value: string; label: string }>;
}) {
  const [value, setValue] = useState<number | ''>(invoice.outstandingCents / 100);
  const [date, setDate] = useState(today());
  const [into, setInto] = useState<string | null>(null);
  return (
    <Modal opened={opened} onClose={close} title={t('Record a payment')} centered size="sm">
      <Stack gap="sm">
        <NumberInput label={t('Amount')} min={0} value={value} allowDecimal decimalScale={2} {...numberSeparators()}
          onChange={(next) => setValue(typeof next === 'number' ? next : '')}
          description={t('Owed {amount}', { amount: inCurrency(invoice.outstandingCents, invoice.currency) })} />
        <TextInput type="date" label={t('Paid on')} value={date} onChange={(event) => setDate(event.currentTarget.value)} />
        <Select label={t('Into account')} data={depositOptions} value={into} clearable placeholder={t('Cash and bank')}
          onChange={setInto} />
        <Group justify="flex-end">
          <ActionButton variant="filled" label={t('Record it')}
            run={() => api('POST', `/api/companies/${companyId}/invoices/${invoice.id}/payments`, {
              amountCents: Math.round((value === '' ? 0 : value) * 100), date, ...(into ? { depositTo: into } : {}),
            })} done={done} />
        </Group>
      </Stack>
    </Modal>
  );
}

interface Line { description: string; quantity: number | ''; price: number | '' }
const BLANK: Line = { description: '', quantity: 1, price: '' };

function IssueInvoice({ companyId, opened, close, done }: { companyId: string; opened: boolean; close: () => void; done: () => void }) {
  const contacts = useLoad<{ contacts: Contact[] }>(
    () => (opened ? api('GET', `/api/companies/${companyId}/contacts`) : Promise.resolve({ contacts: [] })), [companyId, opened]);
  const [contactId, setContactId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currency, setCurrency] = useState(moneyDisplay()?.currency ?? 'USD');
  const [dueInDays, setDueInDays] = useState<number | ''>(14);
  const [tax, setTax] = useState<number | ''>('');
  const [lines, setLines] = useState<Line[]>([{ ...BLANK }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const cents = (value: number | '') => (value === '' ? 0 : Math.round(value * 100));
  const amountOf = (line: Line) => Math.round((line.quantity === '' ? 0 : line.quantity) * cents(line.price));
  const subtotal = lines.reduce((sum, line) => sum + amountOf(line), 0);
  const taxed = Math.round(subtotal * (tax === '' ? 0 : tax) / 100);
  const shown = /^[A-Z]{3}$/.test(currency) ? currency : 'USD';
  const change = (n: number, next: Partial<Line>) => setLines((was) => was.map((line, at) => (at === n ? { ...line, ...next } : line)));
  const ready = subtotal > 0 && (contactId !== null || name.trim() !== '') && lines.every((line) => line.description.trim() !== '' || amountOf(line) === 0);

  const save = async () => {
    setBusy(true);
    try {
      const made: { number: string } = await api('POST', `/api/companies/${companyId}/invoices`, {
        currency,
        ...(contactId ? { contactId } : { customerName: name.trim(), ...(email.trim() ? { customerEmail: email.trim() } : {}) }),
        ...(dueInDays === '' ? {} : { dueInDays }),
        ...(tax === '' || tax === 0 ? {} : { taxRatePercent: tax }),
        lines: lines.filter((line) => amountOf(line) > 0).map((line) => ({ description: line.description.trim(), quantity: line.quantity, unitCents: cents(line.price) })),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      notifications.show({ color: 'teal', message: t('Issued {number}.', { number: made.number }) });
      setContactId(null); setName(''); setEmail(''); setTax(''); setNote(''); setLines([{ ...BLANK }]);
      done();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('Issue an invoice')} centered size="lg">
      <Stack gap="sm">
        <Select label={t('Customer record')} placeholder={t('Or type the customer below')} clearable searchable value={contactId} onChange={setContactId}
          data={(contacts.data?.contacts ?? []).filter((one) => !one.archivedAt).map((one) => ({ value: one.id, label: one.organisation ? `${one.name} · ${one.organisation}` : one.name }))} />
        {contactId === null && (
          <Group grow align="flex-start" wrap="wrap">
            <TextInput label={t('Customer name')} value={name} onChange={(event) => setName(event.currentTarget.value)} style={{ minWidth: 180 }} />
            <TextInput label={t('Email')} value={email} onChange={(event) => setEmail(event.currentTarget.value)} style={{ minWidth: 180 }} />
          </Group>
        )}
        <Group grow align="flex-start" wrap="wrap">
          <TextInput label={t('Currency')} maxLength={3} value={currency} onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} style={{ minWidth: 90 }} />
          <NumberInput label={t('Due in days')} min={0} max={365} value={dueInDays} allowDecimal={false} onChange={(next) => setDueInDays(typeof next === 'number' ? next : '')} style={{ minWidth: 110 }} />
          <NumberInput label={t('Tax, %')} min={0} max={100} value={tax} allowDecimal decimalScale={2} {...numberSeparators()} onChange={(next) => setTax(typeof next === 'number' ? next : '')} style={{ minWidth: 110 }} />
        </Group>
        {lines.map((line, n) => (
          <Group key={n} gap="xs" align="flex-end" wrap="wrap">
            <TextInput label={n === 0 ? t('Description') : undefined} value={line.description} style={{ flex: 3, minWidth: 180 }}
              onChange={(event) => change(n, { description: event.currentTarget.value })} />
            <NumberInput label={n === 0 ? t('Quantity') : undefined} min={0} value={line.quantity} allowDecimal decimalScale={3} {...numberSeparators()} style={{ flex: 1, minWidth: 90 }}
              onChange={(next) => change(n, { quantity: typeof next === 'number' ? next : '' })} />
            <NumberInput label={n === 0 ? t('Unit price') : undefined} min={0} value={line.price} allowDecimal decimalScale={2} {...numberSeparators()} style={{ flex: 1, minWidth: 110 }}
              onChange={(next) => change(n, { price: typeof next === 'number' ? next : '' })} />
            {lines.length > 1 && (
              <ActionIcon variant="subtle" color="gray" aria-label={t('Remove the line')} onClick={() => setLines((was) => was.filter((_, at) => at !== n))}>
                <IconTrash size={16} />
              </ActionIcon>
            )}
          </Group>
        ))}
        <Group justify="space-between" wrap="wrap">
          <Button size="xs" variant="subtle" leftSection={<IconPlus size={14} />} onClick={() => setLines((was) => [...was, { ...BLANK }])}>{t('Add a line')}</Button>
          <Text size="sm" className="tabular">{t('Total {amount}', { amount: inCurrency(subtotal + taxed, shown) })}</Text>
        </Group>
        <Textarea label={t('Note')} autosize minRows={2} value={note} onChange={(event) => setNote(event.currentTarget.value)} />
        <Group justify="flex-end">
          <Button loading={busy} disabled={!ready} onClick={() => void save()}>{t('Issue it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
