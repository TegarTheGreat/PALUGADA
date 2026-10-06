/**
 * The people the company deals with (0118, STATUS 2.138): customers who
 * wrote on a channel, and anyone the owner or a run keeps. Each has what was
 * noted about them, the deals with them, and their conversations.
 *
 * The owner adds, changes, notes and archives here with the session, as with
 * a document: a record grants and spends nothing. A seat reads it.
 */
import { useEffect, useState } from 'react';
import {
  Badge, Button, Drawer, Group, Modal, NumberInput, Paper, Select, Stack, Text, Textarea, TextInput, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArchive, IconArchiveOff, IconMessageCircle, IconPlus, IconSearch, IconUser } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { moneyDisplay, numberSeparators, relative } from '../format.ts';
import { N, locale, t } from '../i18n.ts';
import type { Contact, ContactDetail, Deal, DealStage } from '../types.ts';
import { ActionButton } from './ActionForm.tsx';
import { channelSaid } from './ChatThread.tsx';
import { EmptyState, LoadFailed, Loading, Section } from './ui.tsx';

const STAGES: Record<DealStage, string> = {
  lead: N('Lead'),
  qualified: N('Qualified'),
  proposal: N('Proposal'),
  won: N('Won'),
  lost: N('Lost'),
};

/** A deal's worth in its own currency, as the owner's language writes it. */
function worth(value: Deal['value']): string | null {
  if (!value) return null;
  return (value.amountCents / 100).toLocaleString(locale(), { style: 'currency', currency: value.currency, maximumFractionDigits: 2 });
}

export function Contacts({ companyId, owner, openChat }: { companyId: string; owner: boolean; openChat: (chatId: string) => void }) {
  const [typed, setTyped] = useState('');
  const [query, setQuery] = useState('');
  // Asked once the owner stops typing, not at every letter.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);
  const list = useLoad(async (): Promise<Contact[]> =>
    (await api('GET', `/api/companies/${companyId}/contacts?q=${encodeURIComponent(query)}`) as { contacts: Contact[] }).contacts,
  [companyId, query]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Section
      title={t('Contacts')}
      description={t('Everyone the company deals with: customers who wrote, and anyone you or the agents keep, with what was noted about them and the deals with them.')}
      actions={owner ? <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('Add a person')}</Button> : undefined}
      padding="lg"
    >
      <Stack gap="sm">
        <TextInput
          leftSection={<IconSearch size={14} />}
          placeholder={t('Find by name, organisation, address or number')}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
        {list.error ? <LoadFailed message={list.error} retry={list.reload} /> : !list.data ? <Loading rows={3} /> : list.data.length === 0 ? (
          query
            ? <Text size="sm" c="dimmed">{t('Nobody matches that.')}</Text>
            : <EmptyState title={t('No one yet')} description={t('A customer who writes on a channel is kept here, and so is anyone you add.')} />
        ) : (
          <Stack gap={4}>
            {list.data.map((contact) => (
              <UnstyledButton key={contact.id} onClick={() => setOpen(contact.id)} className="clickable-row" p="xs"
                style={{ opacity: contact.archivedAt ? 0.65 : 1 }}>
                <Group wrap="nowrap" gap="sm" align="flex-start">
                  <IconUser size={18} style={{ flexShrink: 0, marginTop: 2 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="wrap">
                      <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{contact.name}</Text>
                      {contact.organisation && <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{contact.organisation}</Text>}
                      {contact.openDeals > 0 && <Badge size="xs" variant="light" color="teal">{t('Open deals: {count}', { count: contact.openDeals })}</Badge>}
                      {contact.archivedAt && <Badge size="xs" variant="light" color="gray">{t('Archived')}</Badge>}
                    </Group>
                    <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
                      {[contact.email, contact.phone].filter(Boolean).join(' · ') || t('No address or number yet')}
                      {' · '}{relative(contact.updatedAt)}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Stack>
      <AddPerson companyId={companyId} opened={adding} close={() => setAdding(false)} done={(id) => { setAdding(false); list.reload(); setOpen(id); }} />
      {open && (
        <PersonDrawer companyId={companyId} contactId={open} owner={owner} close={() => setOpen(null)} changed={list.reload}
          openChat={(chatId) => { setOpen(null); openChat(chatId); }} />
      )}
    </Section>
  );
}

/** Name, organisation, address and number, as the owner types them. */
function PersonFields({ value, onChange }: {
  value: { name: string; organisation: string; email: string; phone: string };
  onChange: (next: { name: string; organisation: string; email: string; phone: string }) => void;
}) {
  return (
    <>
      <TextInput label={t('Name')} required value={value.name} onChange={(event) => onChange({ ...value, name: event.currentTarget.value })} />
      <TextInput label={t('Organisation')} value={value.organisation} onChange={(event) => onChange({ ...value, organisation: event.currentTarget.value })} />
      <Group grow align="flex-start" wrap="wrap">
        <TextInput label={t('Email')} type="email" value={value.email} onChange={(event) => onChange({ ...value, email: event.currentTarget.value })} style={{ minWidth: 200 }} />
        <TextInput label={t('Phone')} placeholder="+62 812 3456 7890" value={value.phone} onChange={(event) => onChange({ ...value, phone: event.currentTarget.value })} style={{ minWidth: 200 }} />
      </Group>
    </>
  );
}

const BLANK = { name: '', organisation: '', email: '', phone: '' };

function AddPerson({ companyId, opened, close, done }: { companyId: string; opened: boolean; close: () => void; done: (id: string) => void }) {
  const [person, setPerson] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const answer: { contactId: string } = await api('POST', `/api/companies/${companyId}/contacts`, person);
      setPerson(BLANK);
      done(answer.contactId);
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('Add a person')} centered>
      <Stack gap="sm">
        <PersonFields value={person} onChange={setPerson} />
        <Group justify="flex-end">
          <Button loading={busy} disabled={!person.name.trim()} onClick={() => void save()}>{t('Add them')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function PersonDrawer({ companyId, contactId, owner, close, changed, openChat }: {
  companyId: string; contactId: string; owner: boolean; close: () => void; changed: () => void; openChat: (chatId: string) => void;
}) {
  const view = useLoad(async (): Promise<ContactDetail> => api('GET', `/api/companies/${companyId}/contacts/${contactId}`), [companyId, contactId]);
  const [person, setPerson] = useState(BLANK);
  const [note, setNote] = useState('');
  const data = view.data;
  useEffect(() => {
    if (!data) return;
    setPerson({ name: data.contact.name, organisation: data.contact.organisation ?? '', email: data.contact.email ?? '', phone: data.contact.phone ?? '' });
  }, [data]);
  const reload = () => { view.reload(); changed(); };

  return (
    <Drawer opened onClose={close} position="right" size="lg" title={<Text fw={700}>{data?.contact.name ?? ''}</Text>}>
      {view.error ? <LoadFailed message={view.error} retry={view.reload} /> : !data ? <Loading rows={4} /> : (
        <Stack gap="lg">
          {owner ? (
            <Stack gap="sm">
              <PersonFields value={person} onChange={setPerson} />
              <Group gap="xs">
                <ActionButton size="xs" variant="filled" label={t('Save')}
                  run={() => api('POST', `/api/companies/${companyId}/contacts/${contactId}`, person)} done={reload} />
                {data.contact.archivedAt ? (
                  <ActionButton size="xs" variant="light" label={t('Put it back')} leftSection={<IconArchiveOff size={14} />}
                    run={() => api('POST', `/api/companies/${companyId}/contacts/${contactId}`, { archived: false })} done={reload} />
                ) : (
                  <ActionButton size="xs" variant="light" color="gray" label={t('Archive')} leftSection={<IconArchive size={14} />}
                    run={() => api('POST', `/api/companies/${companyId}/contacts/${contactId}`, { archived: true })} done={reload} />
                )}
              </Group>
            </Stack>
          ) : (
            <Stack gap={2}>
              {data.contact.organisation && <Text size="sm">{data.contact.organisation}</Text>}
              <Text size="sm" c="dimmed">{[data.contact.email, data.contact.phone].filter(Boolean).join(' · ') || t('No address or number yet')}</Text>
            </Stack>
          )}

          <Stack gap="xs">
            <Text fw={600} size="sm">{t('Deals')}</Text>
            {data.deals.length === 0 && <Text size="sm" c="dimmed">{t('No deal with them yet.')}</Text>}
            {data.deals.map((deal) => (
              <Paper key={deal.id} withBorder radius="md" p="sm">
                <Group justify="space-between" wrap="wrap" gap="xs">
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{deal.title}</Text>
                    <Text size="xs" c="dimmed">
                      {[worth(deal.value), deal.expectedOn ? t('Expected {date}', { date: new Date(`${deal.expectedOn}T00:00:00`).toLocaleDateString(locale()) }) : null]
                        .filter(Boolean).join(' · ') || t('No value given')}
                    </Text>
                  </div>
                  {owner ? (
                    <Select size="xs" w={140} value={deal.stage} allowDeselect={false}
                      data={(Object.keys(STAGES) as DealStage[]).map((stage) => ({ value: stage, label: t(STAGES[stage]) }))}
                      onChange={(stage) => {
                        if (!stage || stage === deal.stage) return;
                        api('POST', `/api/companies/${companyId}/contacts/${contactId}/deals`, { id: deal.id, stage })
                          .then(reload, (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) }));
                      }} />
                  ) : (
                    <Badge variant="light" color={deal.stage === 'won' ? 'teal' : deal.stage === 'lost' ? 'gray' : 'blue'}>{t(STAGES[deal.stage])}</Badge>
                  )}
                </Group>
              </Paper>
            ))}
            {owner && <NewDeal companyId={companyId} contactId={contactId} done={reload} />}
          </Stack>

          <Stack gap="xs">
            <Text fw={600} size="sm">{t('Notes')}</Text>
            {owner && (
              <Group align="flex-end" wrap="nowrap" gap="xs">
                <Textarea style={{ flex: 1 }} autosize minRows={1} maxRows={6} placeholder={t('What the next person to serve them should know')}
                  value={note} onChange={(event) => setNote(event.currentTarget.value)} />
                <ActionButton size="sm" label={t('Note it')}
                  run={async () => {
                    await api('POST', `/api/companies/${companyId}/contacts/${contactId}/notes`, { body: note });
                    setNote('');
                  }} done={reload} />
              </Group>
            )}
            {data.notes.length === 0 && <Text size="sm" c="dimmed">{t('Nothing noted yet.')}</Text>}
            {data.notes.map((written) => (
              <Paper key={written.id} withBorder radius="md" p="sm">
                <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{written.body}</Text>
                <Text size="xs" c="dimmed" mt={4}>
                  {written.by === 'owner' ? t('You, {when}', { when: relative(written.at) }) : t('An agent, {when}', { when: relative(written.at) })}
                </Text>
              </Paper>
            ))}
          </Stack>

          <Stack gap="xs">
            <Text fw={600} size="sm">{t('Conversations')}</Text>
            {data.chats.length === 0 && <Text size="sm" c="dimmed">{t('They have not written on a channel.')}</Text>}
            {data.chats.map((chat) => (
              <UnstyledButton key={chat.id} onClick={() => openChat(chat.id)} className="clickable-row" p="xs">
                <Group gap="xs" wrap="nowrap">
                  <IconMessageCircle size={16} style={{ flexShrink: 0 }} />
                  <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{channelSaid(chat.kind, chat.account)}</Text>
                  <Text size="xs" c="dimmed">{relative(chat.lastMessageAt)}</Text>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Stack>
      )}
    </Drawer>
  );
}

/** A deal opened with them: what, how far, and what it is worth in a currency of the owner's choosing. */
function NewDeal({ companyId, contactId, done }: { companyId: string; contactId: string; done: () => void }) {
  const [title, setTitle] = useState('');
  const [stage, setStage] = useState<DealStage>('lead');
  const [amount, setAmount] = useState<number | ''>('');
  const [currency, setCurrency] = useState(moneyDisplay()?.currency ?? 'USD');
  const [expectedOn, setExpectedOn] = useState('');
  return (
    <Paper withBorder radius="md" p="sm">
      <Stack gap="xs">
        <TextInput size="xs" label={t('A new deal')} placeholder={t('e.g. Coffee for 40 rooms, every month')} value={title}
          onChange={(event) => setTitle(event.currentTarget.value)} />
        <Group grow align="flex-start" wrap="wrap" gap="xs">
          <Select size="xs" label={t('Stage')} value={stage} allowDeselect={false} style={{ minWidth: 120 }}
            data={(Object.keys(STAGES) as DealStage[]).map((one) => ({ value: one, label: t(STAGES[one]) }))}
            onChange={(next) => setStage((next ?? 'lead') as DealStage)} />
          <NumberInput size="xs" label={t('Worth')} min={0} value={amount} style={{ minWidth: 120 }} allowDecimal {...numberSeparators()}
            onChange={(next) => setAmount(typeof next === 'number' ? next : '')} />
          <TextInput size="xs" label={t('Currency')} maxLength={3} value={currency} style={{ minWidth: 80 }}
            onChange={(event) => setCurrency(event.currentTarget.value.toUpperCase())} />
          <TextInput size="xs" type="date" label={t('Expected to close')} value={expectedOn} style={{ minWidth: 140 }}
            onChange={(event) => setExpectedOn(event.currentTarget.value)} />
        </Group>
        <Group justify="flex-end">
          <ActionButton size="xs" variant="filled" label={t('Open the deal')}
            run={async () => {
              await api('POST', `/api/companies/${companyId}/contacts/${contactId}/deals`, {
                title, stage,
                ...(amount !== '' ? { value: { amountCents: Math.round(amount * 100), currency } } : {}),
                ...(expectedOn ? { expectedOn } : {}),
              });
              setTitle(''); setAmount(''); setExpectedOn(''); setStage('lead');
            }} done={done} />
        </Group>
      </Stack>
    </Paper>
  );
}
