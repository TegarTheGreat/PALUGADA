/**
 * The company's backlog (0070): work that is owed and not yet given to
 * anyone. The roles file tickets as they go -- the plan's build, the
 * customer who needs somebody else -- and the owner files their own; the CEO
 * hands them on, or the owner gives one to a role here. A ticket closes when
 * the work given it finishes, and opens again, saying why, when it does not.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Group, Modal, Paper, Select, SimpleGrid, Stack, Switch, Text, TextInput, Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconPlus, IconRotateClockwise, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import { openGoals } from '../goals.ts';
import type { Structure, Ticket } from '../types.ts';
import { EmptyState, LoadFailed, Loading } from './ui.tsx';

const PRIORITY_COLOR = ['red', 'orange', 'blue', 'gray'];

export function Tickets({ companyId, openTask }: { companyId: string; openTask: (id: string) => void }) {
  const [finished, setFinished] = useState(false);
  const [filing, setFiling] = useState(false);
  const [giving, setGiving] = useState<Ticket | null>(null);
  const [closing, setClosing] = useState<Ticket | null>(null);
  const [reason, setReason] = useState('');
  const board = useLoad(async () => {
    const [tickets, structure]: [{ tickets: Ticket[] }, Structure] = await Promise.all([
      finished
        ? api('GET', `/api/companies/${companyId}/tickets?status=all`)
        : api('GET', `/api/companies/${companyId}/tickets`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { tickets: tickets.tickets, structure };
  }, [companyId, finished], { every: 15_000 });

  if (board.error && !board.data) return <LoadFailed message={board.error} retry={board.reload} />;
  if (!board.data) return <Loading rows={3} />;
  const { tickets, structure } = board.data;
  const division = (id: string | null) => structure.divisions.find((one) => one.id === id)?.name ?? t('Whole company');
  const columns: Array<{ key: string; title: string; items: Ticket[] }> = [
    { key: 'open', title: t('Open'), items: tickets.filter((one) => one.status === 'open') },
    { key: 'in_progress', title: t('Being worked'), items: tickets.filter((one) => one.status === 'in_progress') },
  ];
  if (finished) columns.push({ key: 'finished', title: t('Finished'), items: tickets.filter((one) => one.status === 'done' || one.status === 'closed') });

  const setStatus = async (ticket: Ticket, status: 'open' | 'closed', reason: string | null = null) => {
    try {
      await api('POST', `/api/companies/${companyId}/tickets/${ticket.id}`, { status, reason });
      notifications.show({ color: 'teal', message: status === 'closed' ? t('Closed.') : t('Open again.') });
      board.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed" maw={640}>
          {t('What is owed and not yet anyone\'s. The roles file tickets as they work; the CEO hands them on, or give one to a role yourself. A ticket closes when its work is done.')}
        </Text>
        <Group gap="sm">
          <Switch size="sm" label={t('Show finished')} checked={finished} onChange={(event) => setFinished(event.currentTarget.checked)} />
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setFiling(true)}>{t('New ticket')}</Button>
        </Group>
      </Group>

      {tickets.length === 0 ? (
        <Paper withBorder radius="lg">
          <EmptyState
            title={t('Nothing owed')}
            description={t('When a role leaves something for later, or you file something, it waits here until somebody is given it.')}
            action={<Button variant="light" onClick={() => setFiling(true)}>{t('File a ticket')}</Button>}
          />
        </Paper>
      ) : (
        <SimpleGrid cols={{ base: 1, md: columns.length }} spacing="md">
          {columns.map((column) => (
            <Stack key={column.key} gap="xs">
              <Group gap={6}>
                <Text fw={700} size="sm">{column.title}</Text>
                <Badge size="sm" variant="light" color="gray">{column.items.length}</Badge>
              </Group>
              {column.items.map((ticket) => (
                <Paper key={ticket.id} withBorder radius="md" p="sm">
                  <Group justify="space-between" wrap="nowrap" align="flex-start" gap="xs">
                    <Text size="sm" fw={600} lineClamp={2}>{ticket.title}</Text>
                    <Badge size="sm" variant="light" color={PRIORITY_COLOR[ticket.priority] ?? 'gray'} style={{ flexShrink: 0 }}>P{ticket.priority}</Badge>
                  </Group>
                  {ticket.body && <Text size="xs" c="dimmed" mt={4} lineClamp={3} style={{ whiteSpace: 'pre-wrap' }}>{ticket.body}</Text>}
                  <Text size="xs" c="dimmed" mt={6}>
                    {division(ticket.divisionId)} · {ticket.openedBy === 'owner' ? t('filed by you') : t('filed by a run')} · {relative(ticket.createdAt)}
                  </Text>
                  {ticket.status === 'open' && ticket.closedReason && (
                    <Text size="xs" c="orange.8" mt={4}>{t('Open again: {why}', { why: ticket.closedReason })}</Text>
                  )}
                  {ticket.status === 'closed' && ticket.closedReason && <Text size="xs" c="dimmed" mt={4}>{ticket.closedReason}</Text>}
                  <Group gap={6} mt="xs">
                    {ticket.status === 'open' && (
                      <>
                        <Button size="compact-xs" leftSection={<IconArrowRight size={12} />} onClick={() => setGiving(ticket)}>{t('Give to a role')}</Button>
                        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconX size={12} />} onClick={() => setClosing(ticket)}>{t('Close')}</Button>
                      </>
                    )}
                    {ticket.status === 'in_progress' && ticket.workingTaskId && (
                      <Button size="compact-xs" variant="light" onClick={() => openTask(ticket.workingTaskId!)}>{t('See the work')}</Button>
                    )}
                    {(ticket.status === 'done' || ticket.status === 'closed') && (
                      <>
                        {ticket.workingTaskId && <Button size="compact-xs" variant="subtle" onClick={() => openTask(ticket.workingTaskId!)}>{t('See the work')}</Button>}
                        <Button size="compact-xs" variant="subtle" color="gray" leftSection={<IconRotateClockwise size={12} />} onClick={() => void setStatus(ticket, 'open')}>{t('Open again')}</Button>
                      </>
                    )}
                    {ticket.openedByTaskId && (
                      <Button size="compact-xs" variant="subtle" color="gray" onClick={() => openTask(ticket.openedByTaskId!)}>{t('Why it exists')}</Button>
                    )}
                  </Group>
                </Paper>
              ))}
            </Stack>
          ))}
        </SimpleGrid>
      )}

      <Modal opened={closing !== null} onClose={() => setClosing(null)} title={t('Close the ticket')} centered>
        {closing && (
          <Stack>
            <Text size="sm" fw={600}>{closing.title}</Text>
            <Textarea label={t('Why it is not needed')} description={t('Optional; kept with the ticket.')} autosize minRows={2}
              value={reason} onChange={(event) => setReason(event.currentTarget.value)} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setClosing(null)}>{t('Cancel')}</Button>
              <Button color="red" onClick={() => { void setStatus(closing, 'closed', reason.trim() || null); setClosing(null); setReason(''); }}>{t('Close it')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <FileTicket companyId={companyId} structure={structure} opened={filing} close={() => setFiling(false)} done={board.reload} />
      <GiveTicket companyId={companyId} structure={structure} ticket={giving} close={() => setGiving(null)} done={board.reload} />
    </Stack>
  );
}

function FileTicket({ companyId, structure, opened, close, done }: {
  companyId: string; structure: Structure; opened: boolean; close: () => void; done: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<string | null>('2');
  const [divisionId, setDivisionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/tickets`, { title, body, priority: Number(priority), divisionId });
      notifications.show({ color: 'teal', message: t('Filed. It waits until somebody is given it.') });
      setTitle('');
      setBody('');
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('New ticket')} centered size="lg">
      <Stack>
        <TextInput label={t('What needs doing')} placeholder={t('e.g. Answer the wholesale enquiry')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} required />
        <Textarea label={t('Detail')} description={t('What whoever picks it up needs to know, and what done looks like.')} autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={8000} />
        <SimpleGrid cols={2}>
          <Select label={t('Priority')} value={priority} onChange={setPriority} allowDeselect={false} data={[
            { value: '0', label: t('P0 · first') }, { value: '1', label: t('P1 · soon') }, { value: '2', label: t('P2 · normal') }, { value: '3', label: t('P3 · when there is time') },
          ]} />
          <Select label={t('Belongs to')} placeholder={t('Whole company')} clearable value={divisionId} onChange={setDivisionId}
            data={structure.divisions.map((division) => ({ value: division.id, label: division.name }))} />
        </SimpleGrid>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button disabled={!title.trim()} onClick={() => void submit()}>{t('File it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function GiveTicket({ companyId, structure, ticket, close, done }: {
  companyId: string; structure: Structure; ticket: Ticket | null; close: () => void; done: () => void;
}) {
  const ceo = structure.roles.find((role) => role.title === 'CEO');
  const [roleId, setRoleId] = useState<string | null>(null);
  const goals = openGoals(structure.goals);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosenRole = roleId ?? ceo?.id ?? null;
  const chosenGoal = goalId ?? goals.find((goal) => goal.kind !== 'mission')?.id ?? goals[0]?.id ?? null;
  const submit = async () => {
    if (!ticket || !chosenRole || !chosenGoal) return;
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/tickets/${ticket.id}/assign`, { roleId: chosenRole, goalId: chosenGoal });
      notifications.show({ color: 'teal', message: t('Given. The ticket closes when the work is done.') });
      close();
      done();
    } catch (failure) {
      setError(explain(failure));
    }
  };
  return (
    <Modal opened={ticket !== null} onClose={close} title={t('Give to a role')} centered>
      {ticket && (
        <Stack>
          <Text size="sm" fw={600}>{ticket.title}</Text>
          <Select label={t('Role')} value={chosenRole} onChange={setRoleId} allowDeselect={false} searchable
            description={chosenRole === ceo?.id ? t('The CEO hands it to whoever should do it') : undefined}
            data={structure.roles.map((role) => ({ value: role.id, label: [role.displayName ?? role.slug, role.title].filter(Boolean).join(' · ') }))} />
          <Select label={t('Serves')} value={chosenGoal} onChange={setGoalId} allowDeselect={false}
            data={goals.map((goal) => ({ value: goal.id, label: goal.statement }))} />
          {error && <Alert color="red" variant="light">{error}</Alert>}
          <Group justify="flex-end">
            <Button variant="default" onClick={close}>{t('Cancel')}</Button>
            <Button disabled={!chosenRole || !chosenGoal} onClick={() => void submit()}>{t('Give it')}</Button>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
