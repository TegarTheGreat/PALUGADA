/**
 * The company's backlog (0070): work that is owed and not yet given to
 * anyone. The roles file tickets as they go -- the plan's build, the
 * customer who needs somebody else -- and the owner files their own; the CEO
 * hands them on, or the owner gives one to a role here. A ticket closes when
 * the work given it finishes, and opens again, saying why, when it does not.
 *
 * The same board is the issues list and the to-dos (F18.4, F18.5): an issue
 * is a problem the CEO solves -- a root cause, a decision, and to-dos that
 * each go to one seat, due in a week -- and its page shows all three. The
 * platform files one itself when work fails with a cause worth finding.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Group, Modal, Paper, SegmentedControl, Select, SimpleGrid, Stack, Switch, Text, TextInput, Textarea,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconPlus, IconRotateClockwise, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { day, hireDraft, relative, roleLabel } from '../format.ts';
import { t } from '../i18n.ts';
import { openGoals } from '../goals.ts';
import type { Structure, Ticket } from '../types.ts';
import { EmptyState, LoadFailed, Loading } from './ui.tsx';

const PRIORITY_COLOR = ['red', 'orange', 'blue', 'gray'];

/** Which part of the board is shown: all of it, the issues list, or the to-dos. */
type Shown = 'all' | 'issues' | 'todos';

/** A to-do: work that carries out an issue's decision, or has a seat and a date of its own. */
const isTodo = (ticket: Ticket) => ticket.kind === 'work' && (ticket.solvesTicketId !== null || ticket.dueOn !== null);

/** A due date is a day in the company's zone; read at noon, it is that day wherever the console is. */
const dueSaid = (dueOn: string) => t('Due {day}', { day: day(`${dueOn}T12:00:00`) });

function filedBy(ticket: Ticket): string {
  if (ticket.openedBy === 'owner') return t('filed by you');
  if (ticket.openedBy === 'platform') return t('filed by PALUGADA');
  return t('filed by a run');
}

export function Tickets({ companyId, openTask, talk }: {
  companyId: string;
  openTask: (id: string) => void;
  /** Opens the conversation with the CEO, with words waiting in the box: how a proposed hire is hired. */
  talk: (draft: string) => void;
}) {
  const [finished, setFinished] = useState(false);
  const [shown, setShown] = useState<Shown>('all');
  const [reading, setReading] = useState<string | null>(null);
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
  const { structure } = board.data;
  const tickets = board.data.tickets.filter((one) =>
    shown === 'all' ? true : shown === 'issues' ? one.kind === 'issue' : isTodo(one));
  const division = (id: string | null) => structure.divisions.find((one) => one.id === id)?.name ?? t('Whole company');
  const seat = (id: string | null) => {
    const role = structure.roles.find((one) => one.id === id);
    return role ? roleLabel(role) : null;
  };
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
          <SegmentedControl size="xs" value={shown} onChange={(value) => setShown(value as Shown)} data={[
            { value: 'all', label: t('All') }, { value: 'issues', label: t('Issues') }, { value: 'todos', label: t('To-dos') },
          ]} />
          <Switch size="sm" label={t('Show finished')} checked={finished} onChange={(event) => setFinished(event.currentTarget.checked)} />
          <Button size="sm" leftSection={<IconPlus size={16} />} onClick={() => setFiling(true)}>{t('New ticket')}</Button>
        </Group>
      </Group>

      {tickets.length === 0 && shown !== 'all' ? (
        <Paper withBorder radius="lg">
          <EmptyState
            title={shown === 'issues' ? t('No issues') : t('No to-dos')}
            description={shown === 'issues'
              ? t('A problem to solve rather than work to hand out. File one yourself; the platform files one when work fails with a cause worth finding.')
              : t('An issue is solved with to-dos: each goes to one seat and is due in a week.')}
          />
        </Paper>
      ) : tickets.length === 0 ? (
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
                    {ticket.kind === 'hire'
                      ? <Badge size="sm" variant="light" color="grape" style={{ flexShrink: 0 }}>{t('A hire')}</Badge>
                      : ticket.kind === 'issue'
                        ? <Badge size="sm" variant="light" color="yellow" style={{ flexShrink: 0 }}>{ticket.horizon === 'long_term' ? t('Long-term issue') : t('Issue')}</Badge>
                        : <Badge size="sm" variant="light" color={PRIORITY_COLOR[ticket.priority] ?? 'gray'} style={{ flexShrink: 0 }}>P{ticket.priority}</Badge>}
                  </Group>
                  {ticket.body && <Text size="xs" c="dimmed" mt={4} lineClamp={3} style={{ whiteSpace: 'pre-wrap' }}>{ticket.body}</Text>}
                  <Text size="xs" c="dimmed" mt={6}>
                    {division(ticket.divisionId)} · {filedBy(ticket)} · {relative(ticket.createdAt)}
                  </Text>
                  {isTodo(ticket) && (
                    <Text size="xs" mt={4}>
                      {[seat(ticket.assigneeRoleId) ?? t('No seat yet: the CEO hands it on'), ticket.dueOn ? dueSaid(ticket.dueOn) : null]
                        .filter(Boolean).join(' · ')}
                    </Text>
                  )}
                  {ticket.status === 'open' && ticket.closedReason && (
                    <Text size="xs" c="orange.8" mt={4}>{t('Open again: {why}', { why: ticket.closedReason })}</Text>
                  )}
                  {ticket.status === 'closed' && ticket.closedReason && <Text size="xs" c="dimmed" mt={4}>{ticket.closedReason}</Text>}
                  {ticket.kind === 'issue' && ticket.status === 'done' && ticket.closedReason && (
                    <Text size="xs" mt={4} lineClamp={2}>{t('Decided: {decision}', { decision: ticket.closedReason })}</Text>
                  )}
                  <Group gap={6} mt="xs">
                    {ticket.status === 'open' && (
                      <>
                        {ticket.kind === 'hire'
                          ? <Button size="compact-xs" leftSection={<IconArrowRight size={12} />} onClick={() => talk(hireDraft(ticket.title, ticket.body))}>{t('Hire it with the CEO')}</Button>
                          : ticket.kind === 'issue'
                            ? null
                            : <Button size="compact-xs" leftSection={<IconArrowRight size={12} />} onClick={() => setGiving(ticket)}>{t('Give to a role')}</Button>}
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
                    {(ticket.kind === 'issue' || ticket.solvesTicketId) && (
                      <Button size="compact-xs" variant="light" color="yellow" onClick={() => setReading(ticket.kind === 'issue' ? ticket.id : ticket.solvesTicketId)}>{t('See the issue')}</Button>
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
      <IssuePage companyId={companyId} structure={structure} issueId={reading} close={() => setReading(null)}
        openTask={(id) => { setReading(null); openTask(id); }} />
      <GiveTicket companyId={companyId} structure={structure} ticket={giving} close={() => setGiving(null)} done={board.reload} />
    </Stack>
  );
}

function FileTicket({ companyId, structure, opened, close, done }: {
  companyId: string; structure: Structure; opened: boolean; close: () => void; done: () => void;
}) {
  const [kind, setKind] = useState<'work' | 'issue'>('work');
  const [horizon, setHorizon] = useState<string | null>('now');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [priority, setPriority] = useState<string | null>('2');
  const [divisionId, setDivisionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/tickets`, {
        title, body, priority: Number(priority), divisionId, kind, ...(kind === 'issue' ? { horizon } : {}),
      });
      notifications.show({
        color: 'teal',
        message: kind === 'issue'
          ? t('Filed. The CEO solves it: a root cause, a decision, and to-dos.')
          : t('Filed. It waits until somebody is given it.'),
      });
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
        <SegmentedControl value={kind} onChange={(value) => setKind(value as 'work' | 'issue')} data={[
          { value: 'work', label: t('Work to hand out') }, { value: 'issue', label: t('An issue to solve') },
        ]} />
        {kind === 'issue'
          ? <TextInput label={t('The problem')} placeholder={t('e.g. Customers wait a day for an answer')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} required />
          : <TextInput label={t('What needs doing')} placeholder={t('e.g. Answer the wholesale enquiry')} value={title} onChange={(e) => setTitle(e.currentTarget.value)} maxLength={200} required />}
        <Textarea label={t('Detail')}
          description={kind === 'issue'
            ? t('What happened, what it costs, and what is known so far. Not the fix: the CEO finds the cause first.')
            : t('What whoever picks it up needs to know, and what done looks like.')}
          autosize minRows={3} value={body} onChange={(e) => setBody(e.currentTarget.value)} maxLength={8000} />
        {kind === 'issue' && (
          <Select label={t('List')} value={horizon} onChange={setHorizon} allowDeselect={false} data={[
            { value: 'now', label: t('This week: solved at the weekly meeting') },
            { value: 'long_term', label: t('Long term: read at quarterly planning') },
          ]} />
        )}
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
            data={structure.roles.map((role) => ({ value: role.id, label: roleLabel(role) }))} />
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

/**
 * An issue's own page: what it is, and once solved, why it happened, what was
 * decided, and the to-dos that carry the decision out, each with its seat
 * and its date.
 */
function IssuePage({ companyId, structure, issueId, close, openTask }: {
  companyId: string; structure: Structure; issueId: string | null; close: () => void; openTask: (id: string) => void;
}) {
  const page = useLoad(async () => {
    if (!issueId) return null;
    const read: { ticket: Ticket; todos: Ticket[] } = await api('GET', `/api/companies/${companyId}/tickets/${issueId}`);
    return read;
  }, [companyId, issueId]);
  const seat = (id: string | null) => {
    const role = structure.roles.find((one) => one.id === id);
    return role ? roleLabel(role) : t('No seat yet: the CEO hands it on');
  };
  const status = (ticket: Ticket) => ({
    open: t('Open'), in_progress: t('Being worked'), done: t('Done'), closed: t('Closed'),
  })[ticket.status];
  return (
    <Modal opened={issueId !== null} onClose={close} title={t('Issue')} centered size="lg">
      {page.error && !page.data ? <LoadFailed message={page.error} retry={page.reload} />
        : !page.data ? <Loading rows={3} />
          : (() => {
            const { ticket: issue, todos } = page.data;
            return (
              <Stack gap="sm">
                <Group justify="space-between" align="flex-start" wrap="nowrap">
                  <Text fw={700}>{issue.title}</Text>
                  <Badge variant="light" color={issue.status === 'done' ? 'teal' : issue.status === 'closed' ? 'gray' : 'yellow'} style={{ flexShrink: 0 }}>
                    {status(issue)}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {[issue.horizon === 'long_term' ? t('Long term: read at quarterly planning') : t('This week: solved at the weekly meeting'),
                    filedBy(issue), relative(issue.createdAt)].join(' · ')}
                </Text>
                {issue.body && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{issue.body}</Text>}
                {issue.status === 'done' ? (
                  <Paper withBorder radius="md" p="sm">
                    <Stack gap={6}>
                      <Text size="xs" fw={700} c="dimmed">{t('Root cause')}</Text>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{issue.rootCause}</Text>
                      <Text size="xs" fw={700} c="dimmed" mt={4}>{t('Decision')}</Text>
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{issue.closedReason}</Text>
                    </Stack>
                  </Paper>
                ) : issue.status === 'closed' ? (
                  <Alert variant="light" color="gray">{issue.closedReason ? t('Closed without being solved: {why}', { why: issue.closedReason }) : t('Closed without being solved.')}</Alert>
                ) : (
                  <Alert variant="light" color="yellow">
                    {t('Not solved yet. The CEO finds the root cause by asking why until the answer checks out against the record, decides once, and files a to-do for each seat that carries the decision out.')}
                  </Alert>
                )}
                <Text size="xs" fw={700} c="dimmed" mt={4}>{t('To-dos')}</Text>
                {todos.length === 0
                  ? <Text size="sm" c="dimmed">{t('No to-dos yet.')}</Text>
                  : todos.map((todo) => (
                    <Paper key={todo.id} withBorder radius="md" p="xs">
                      <Group justify="space-between" wrap="nowrap" gap="xs">
                        <Text size="sm" fw={600} lineClamp={2}>{todo.title}</Text>
                        <Badge size="sm" variant="light" color={todo.status === 'done' ? 'teal' : 'gray'} style={{ flexShrink: 0 }}>{status(todo)}</Badge>
                      </Group>
                      <Text size="xs" c="dimmed" mt={2}>
                        {[seat(todo.assigneeRoleId), todo.dueOn ? dueSaid(todo.dueOn) : null].filter(Boolean).join(' · ')}
                      </Text>
                      {todo.workingTaskId && (
                        <Button size="compact-xs" variant="subtle" mt={4} onClick={() => openTask(todo.workingTaskId!)}>{t('See the work')}</Button>
                      )}
                    </Paper>
                  ))}
                {issue.openedByTaskId && (
                  <Group>
                    <Button size="compact-xs" variant="subtle" color="gray" onClick={() => openTask(issue.openedByTaskId!)}>{t('Why it exists')}</Button>
                  </Group>
                )}
              </Stack>
            );
          })()}
    </Modal>
  );
}
