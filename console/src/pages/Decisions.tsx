/**
 * The queue (F10.1-F10.4): one list of what is waiting on the owner, and the
 * one they are looking at, with everything a judgement needs (F10.2) -- what,
 * why, the goal it serves, the tier, the cost, what happens if it is refused,
 * and the trace behind it.
 *
 * "Approve" is the irreversible one, so it is not the easiest to hit: an
 * outline, never filled, at the end of the row. "Deny" is the quiet default
 * beside it. A console that made approving the prettiest button would be a
 * console that got approvals it did not mean. There is no keyboard shortcut
 * for approving, for the same reason; the arrows only move between items.
 *
 * After a decision the next item opens by itself, so a morning's queue is
 * read top to bottom without going back to the list each time.
 *
 * "Choose several" is for the drafts the owner has already read: approve or
 * deny a selection in one press, each decided exactly as it would be alone.
 * A tier 3 action, a run's question and an incident are never approved that
 * way -- the confirmation says which of the chosen stay, and the server
 * leaves them whatever the page sends.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Anchor, Badge, Box, Button, Checkbox, Collapse, Divider, Grid, Group, Kbd, Modal, Paper,
  ScrollArea, SegmentedControl, SimpleGrid, Stack, Text, Textarea, Title, Tooltip,
} from '@mantine/core';
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft, IconCheck, IconClock, IconMessageQuestion, IconRoute, IconTarget, IconX,
} from '@tabler/icons-react';
import { api, ApiError, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { go } from '../router.ts';
import type { Digest, InboxItem, Trace } from '../types.ts';
import { dateTime, goalKind, money, relative } from '../format.ts';
import { t, tp } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, KindBadge, KpiStrip, LoadFailed, Loading, PageHeader, TierBadge } from '../components/ui.tsx';
import { TraceView } from '../components/Trace.tsx';

type Filter = 'all' | 'approval' | 'incident' | 'escalation';

const KIND_COLOR: Record<string, string> = {
  approval: 'var(--mantine-color-orange-6)',
  incident: 'var(--mantine-color-red-6)',
  escalation: 'var(--mantine-color-violet-6)',
};

/** Whether a batch may approve it: the server holds the same rule and has the last word. */
const batchApprovable = (item: InboxItem) => item.tier !== 3 && !item.question && item.kind !== 'incident';

/** Tier 3 first, then incidents, then oldest: what costs most to leave waiting. */
function urgency(item: InboxItem): number {
  return item.tier === 3 ? 0 : item.kind === 'incident' ? 1 : 2;
}

export function Decisions({ ctx, route }: PageProps) {
  const { companyId } = ctx;
  const queue = useLoad(async () => {
    const [{ items }, digest]: [{ items: InboxItem[] }, Digest] = await Promise.all([
      api('GET', `/api/companies/${companyId}/inbox`),
      api('GET', `/api/companies/${companyId}/digest`),
    ]);
    return { items, digest };
  }, [companyId], { every: 15_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [missingLink, setMissingLink] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<'approve' | 'deny' | null>(null);
  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const stopChoosing = () => { setChoosing(false); setChosen(new Set()); };
  const narrow = useMediaQuery('(max-width: 62em)') ?? false;
  const selected = route.item;
  const select = (id: string | null) => go({ ...route, item: id }, { replace: true });

  const items = useMemo(() => (queue.data?.items ?? [])
    .filter((item) => filter === 'all' || item.kind === filter)
    .sort((a, b) => urgency(a) - urgency(b) || a.createdAt.localeCompare(b.createdAt)), [queue.data, filter]);

  useEffect(() => {
    if (!queue.data) return;
    ctx.setOpenCount(queue.data.items.length);
    if (selected && !queue.data.items.some((item) => item.id === selected)) {
      // An item that has closed since the link went out -- decided on the
      // phone, expired -- is said to be gone rather than silently missing.
      setMissingLink(true);
      select(null);
      return;
    }
    if (!narrow && !selected && items[0]) select(items[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data, items, narrow]);

  const move = (step: number) => {
    const index = items.findIndex((item) => item.id === selected);
    const next = items[Math.min(Math.max(index + step, 0), items.length - 1)];
    if (next) select(next.id);
  };
  useHotkeys([['ArrowDown', () => move(1)], ['j', () => move(1)], ['ArrowUp', () => move(-1)], ['k', () => move(-1)]]);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Inbox')}
      description={t('Everything waiting on you, most urgent first. Nothing here runs until you say so, and silence never approves.')}
      live={queue.updatedAt}
      actions={(
        <Group gap={6} visibleFrom="md">
          <Text size="xs" c="dimmed">{t('Move with')}</Text><Kbd size="xs">↑</Kbd><Kbd size="xs">↓</Kbd>
        </Group>
      )}
    />
  );

  if (queue.error && !queue.data) return <>{header}<LoadFailed message={queue.error} retry={queue.reload} /></>;
  if (!queue.data) return <>{header}<Loading rows={4} /></>;

  const { digest } = queue.data;
  const current = items.find((item) => item.id === selected) ?? null;
  const showList = !narrow || !current;
  const showDetail = !narrow || current !== null;

  // After a decision: the next item in the list, or none.
  const decided = (id: string) => {
    const index = items.findIndex((item) => item.id === id);
    const next = items[index + 1] ?? items[index - 1] ?? null;
    select(next && next.id !== id ? next.id : null);
    queue.reload();
  };

  return (
    <Stack gap="lg">
      {header}

      {!(narrow && current) && (
        <KpiStrip items={[
          {
            label: t('Needs you'),
            value: queue.data.items.length,
            hint: digest.openIncidents > 0 ? tp('{count} incident', '{count} incidents', digest.openIncidents) : t('No incidents'),
            alert: digest.openIncidents > 0,
          },
          { label: t('Done today'), value: digest.tasksCompleted, onClick: () => ctx.open('work') },
          {
            label: t('Failed or halted'),
            value: digest.tasksFailed + digest.tasksHalted,
            alert: digest.tasksFailed + digest.tasksHalted > 0,
            onClick: () => ctx.open('work'),
          },
          { label: t('Spent today'), value: money(digest.moneySpentCents), onClick: () => ctx.open('money') },
        ]} />
      )}

      {missingLink && (
        <Alert color="gray" variant="light" withCloseButton onClose={() => setMissingLink(false)}>
          {t('The item you followed has already been decided or closed. It is in the history.')}
          {' '}<Anchor size="sm" onClick={() => ctx.open('history')}>{t('Open the history')}</Anchor>
        </Alert>
      )}

      {queue.data.items.length === 0 ? (
        <Paper withBorder radius="lg">
          <EmptyState
            image="/illustrations/inbox-zero.webp"
            title={t('Nothing needs you')}
            description={t('Every approval, incident and question has been answered. New ones arrive here, and on your phone if a push channel is set.')}
            action={<Button variant="light" onClick={() => ctx.open('work')}>{t('See the work in progress')}</Button>}
          />
        </Paper>
      ) : (
        <Grid gap="lg" align="flex-start">
          {showList && (
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Paper withBorder radius="lg" p="xs">
                <Group gap={6} mb="xs" wrap="nowrap">
                  <SegmentedControl
                    style={{ flex: 1 }}
                    size="xs"
                    value={filter}
                    onChange={(value) => setFilter(value as Filter)}
                    data={[
                      { value: 'all', label: t('All {count}', { count: queue.data.items.length }) },
                      { value: 'approval', label: t('Approvals') },
                      { value: 'incident', label: t('Incidents') },
                      { value: 'escalation', label: t('Questions') },
                    ]}
                  />
                  <Button size="compact-sm" variant={choosing ? 'light' : 'subtle'} onClick={() => (choosing ? stopChoosing() : setChoosing(true))}>
                    {choosing ? t('Done') : t('Choose several')}
                  </Button>
                </Group>
                {choosing && (
                  <Group justify="space-between" gap={6} mb="xs" px={4} wrap="nowrap">
                    <Anchor size="xs" onClick={() => setChosen(chosen.size === items.length ? new Set() : new Set(items.map((item) => item.id)))}>
                      {chosen.size === items.length ? t('Choose none') : t('Choose all shown')}
                    </Anchor>
                    <Group gap={6} wrap="nowrap">
                      <Text size="xs" c="dimmed">{tp('{count} chosen', '{count} chosen', chosen.size)}</Text>
                      <Button size="compact-sm" variant="default" disabled={chosen.size === 0} onClick={() => setConfirm('deny')}>{t('Deny')}</Button>
                      <Button
                        size="compact-sm"
                        variant="outline"
                        color="teal"
                        disabled={!items.some((item) => chosen.has(item.id) && batchApprovable(item))}
                        onClick={() => setConfirm('approve')}
                      >{t('Approve')}</Button>
                    </Group>
                  </Group>
                )}
                <ScrollArea.Autosize mah="calc(100vh - 330px)" type="auto">
                  <Stack gap={4}>
                    {items.length === 0 && <Text c="dimmed" size="sm" p="md" ta="center">{t('Nothing of this kind.')}</Text>}
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="queue-row"
                        data-active={(choosing ? chosen.has(item.id) : item.id === selected) || undefined}
                        aria-pressed={choosing ? chosen.has(item.id) : undefined}
                        style={{ ['--kind-color' as string]: KIND_COLOR[item.kind] }}
                        onClick={() => (choosing ? toggle(item.id) : select(item.id))}
                      >
                        <Group gap="sm" wrap="nowrap" align="flex-start">
                          {choosing && (
                            <Checkbox checked={chosen.has(item.id)} readOnly tabIndex={-1} mt={2} style={{ pointerEvents: 'none' }} />
                          )}
                          <Box style={{ flex: 1, minWidth: 0 }}>
                            <Text fw={600} size="sm" lineClamp={2}>{item.title}</Text>
                            <Group gap={6} mt={6}>
                              <TierBadge tier={item.tier} />
                              <KindBadge kind={item.kind} />
                              <Text size="xs" c="dimmed">{relative(item.createdAt)}</Text>
                              {item.estimatedCostCents > 0 && <Text size="xs" c="dimmed">· {money(item.estimatedCostCents)}</Text>}
                            </Group>
                          </Box>
                        </Group>
                      </button>
                    ))}
                  </Stack>
                </ScrollArea.Autosize>
              </Paper>
            </Grid.Col>
          )}
          {showDetail && (
            <Grid.Col span={{ base: 12, md: 7 }}>
              {current ? (
                <Detail
                  key={current.id}
                  item={current}
                  companyId={companyId}
                  position={t('{index} of {total}', { index: items.indexOf(current) + 1, total: items.length })}
                  back={narrow ? () => select(null) : undefined}
                  decided={() => decided(current.id)}
                  openTask={() => ctx.open('work', { item: current.taskId })}
                />
              ) : (
                <Paper withBorder radius="lg" p="xl"><Text c="dimmed" ta="center">{t('Choose an item.')}</Text></Paper>
              )}
            </Grid.Col>
          )}
        </Grid>
      )}

      <BatchConfirm
        companyId={companyId}
        decision={confirm}
        items={items.filter((item) => chosen.has(item.id))}
        close={() => setConfirm(null)}
        done={() => { setConfirm(null); stopChoosing(); queue.reload(); }}
      />
    </Stack>
  );
}

/**
 * What a batch is about to do, before it does it: which items, what they cost
 * together, and which of the chosen will stay because they are decided alone.
 */
function BatchConfirm({ companyId, decision, items, close, done }: {
  companyId: string;
  decision: 'approve' | 'deny' | null;
  items: InboxItem[];
  close: () => void;
  done: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const approving = decision === 'approve';
  const targets = approving ? items.filter(batchApprovable) : items;
  const staying = items.length - targets.length;
  const cost = targets.reduce((sum, item) => sum + item.estimatedCostCents, 0);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result: { decided: string[]; skipped: Array<{ itemId: string; reason: string }> } = await api(
        'POST', `/api/companies/${companyId}/inbox/batch`, { itemIds: targets.map((item) => item.id), decision, note },
      );
      notifications.show({
        color: approving ? 'teal' : 'gray',
        message: [
          approving ? tp('{count} approved.', '{count} approved.', result.decided.length)
            : tp('{count} denied.', '{count} denied.', result.decided.length),
          result.skipped.length
            ? tp('{count} was left for you: {reason}', '{count} were left for you, the first because {reason}', result.skipped.length, { reason: result.skipped[0]!.reason })
            : '',
        ].filter(Boolean).join(' '),
      });
      setNote('');
      done();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      opened={decision !== null}
      onClose={close}
      centered
      title={approving
        ? tp('Approve {count} item?', 'Approve {count} items?', targets.length)
        : tp('Deny {count} item?', 'Deny {count} items?', targets.length)}
    >
      <Stack>
        {approving && staying > 0 && (
          <Alert color="gray" variant="light">
            {tp('{count} of those chosen is decided alone -- a tier 3 action, a question or an incident -- and stays in the inbox.',
              '{count} of those chosen are decided alone -- tier 3 actions, questions or incidents -- and stay in the inbox.', staying)}
          </Alert>
        )}
        <ScrollArea.Autosize mah={220} type="auto">
          <Stack gap={6}>
            {targets.map((item) => (
              <Group key={item.id} justify="space-between" wrap="nowrap" gap="sm">
                <Text size="sm" lineClamp={1}>{item.title}</Text>
                <TierBadge tier={item.tier} />
              </Group>
            ))}
          </Stack>
        </ScrollArea.Autosize>
        {approving && cost > 0 && <Text size="sm">{t('Estimated cost together: {amount}', { amount: money(cost) })}</Text>}
        <Textarea label={t('Note, kept with each decision')} value={note} onChange={(event) => setNote(event.currentTarget.value)} autosize minRows={2} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button
            variant={approving ? 'outline' : 'filled'}
            color={approving ? 'teal' : 'red'}
            loading={busy}
            disabled={targets.length === 0}
            onClick={run}
          >
            {approving ? tp('Approve {count}', 'Approve {count}', targets.length) : tp('Deny {count}', 'Deny {count}', targets.length)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function Detail({
  item, companyId, position, back, decided, openTask,
}: {
  item: InboxItem;
  companyId: string;
  position: string;
  back: (() => void) | undefined;
  decided: () => void;
  openTask: () => void;
}) {
  const requireFactor = useFactor();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [traceOpen, setTraceOpen] = useState(false);
  const [answer, setAnswer] = useState('');

  const send = (decision: string, proof?: { totp: string }) =>
    api('POST', `/api/companies/${companyId}/inbox/${item.id}/decide`, {
      decision, note, ...(proof ? { proof } : {}),
    });

  const decide = async (decision: 'approve' | 'deny' | 'ask') => {
    if (decision === 'ask' && !note.trim()) {
      setError(t('Write the question in the note first.'));
      return;
    }
    setBusy(decision);
    setError(null);
    try {
      // Tried without a factor first, deliberately. The page does not read the
      // tier to decide whether one is needed -- `decide` decides, and asking it
      // is how the console stays out of the business of implementing F10.10.
      try {
        await send(decision);
      } catch (failure) {
        if (failure instanceof ApiError && failure.code === 'approval.channel_forbidden') {
          const done = await requireFactor(item.title, (proof) => send(decision, proof));
          if (!done) return;
        } else {
          throw failure;
        }
      }
      notifications.show({
        color: decision === 'approve' ? 'teal' : decision === 'deny' ? 'gray' : 'blue',
        message: decision === 'approve'
          ? item.question ? t('Answer sent. The task carries on with it.') : t('Approved.')
          : decision === 'deny' ? t('Denied.') : t('Question sent to the agent.'),
      });
      decided();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(null);
    }
  };

  // One of the answers the agent offered, pressed: the answer is its text,
  // on a yes, exactly as if it had been typed.
  const choose = async (option: string) => {
    setBusy(`choose:${option}`);
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/inbox/${item.id}/decide`, { decision: 'approve', note: option });
      notifications.show({ color: 'teal', message: t('Answer sent. The task carries on with it.') });
      decided();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(null);
    }
  };

  const showTrace = async () => {
    setTraceOpen((open) => !open);
    if (trace) return;
    try {
      setTrace(await api('GET', `/api/companies/${companyId}/inbox/${item.id}/trace`));
    } catch (failure) {
      setTrace({ reason: explain(failure), runs: [], calls: [] });
    }
  };

  // F10.3's other direction: an agent asked something, and this is the answer
  // going back. It puts the task back on the queue rather than deciding it.
  const sendAnswer = async () => {
    setBusy('answer');
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/inbox/${item.id}/answer`, { answer });
      notifications.show({ color: 'blue', message: t('Answer sent; the task is back in the queue.') });
      decided();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(null);
    }
  };

  const expires = item.expiresAt ? new Date(item.expiresAt) : null;
  const soon = expires !== null && expires.getTime() - Date.now() < 6 * 3_600_000;
  const asker = item.roleSlug
    ? item.divisionName ? t('Asked by {role} in {division}', { role: item.roleSlug, division: item.divisionName }) : t('Asked by {role}', { role: item.roleSlug })
    : t('Raised by the platform');

  return (
    <Paper withBorder radius="lg" shadow="xs" style={{ overflow: 'hidden' }}>
      <Box p="lg" style={{ borderTop: `4px solid ${KIND_COLOR[item.kind] ?? 'var(--mantine-color-gray-4)'}` }}>
        <Group justify="space-between" mb="sm">
          {back ? (
            <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={14} />} onClick={back} px={4}>
              {t('All decisions')}
            </Button>
          ) : <span />}
          <Text size="xs" c="dimmed">{position}</Text>
        </Group>
        <Group gap="xs" mb="xs">
          <TierBadge tier={item.tier} />
          <KindBadge kind={item.kind} />
          {expires && (
            <Tooltip label={t('Unanswered, it is cancelled {when}. Silence never executes anything.', { when: dateTime(item.expiresAt) })}>
              <Badge color={soon ? 'red' : 'gray'} variant="light" leftSection={<IconClock size={12} />}>
                {t('Expires {when}', { when: relative(item.expiresAt) })}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Title order={3} fz={20} lh={1.3}>{item.title}</Title>
        <Text size="sm" c="dimmed" mt={6}>{asker} · {relative(item.createdAt)}</Text>
      </Box>
      <Divider />
      <Stack p="lg" gap="md">
        {item.actionSummary && item.actionSummary !== item.title && (
          <Block label={t('What will happen')}>{item.actionSummary}</Block>
        )}
        {item.rationale && <Block label={t('Why')}>{item.rationale}</Block>}
        {item.consequenceIfDenied && <Block label={t('If you refuse')}>{item.consequenceIfDenied}</Block>}

        {item.goalChain.length > 0 && (
          <div>
            <Group gap={6} mb={6}><IconTarget size={16} /><Text size="xs" fw={700} tt="uppercase" c="dimmed">{t('Serves')}</Text></Group>
            {/* Top of the ladder first, one rung a line: a chain of long
                statements side by side ran off a phone's screen. */}
            <Stack gap={4}>
              {item.goalChain.map((goal, index) => (
                <Text key={goal.statement} size="sm" pl={index * 14} style={{ overflowWrap: 'anywhere' }}>
                  {index > 0 && <Text span c="dimmed">↳ </Text>}
                  <Text span c="dimmed" size="xs">{goalKind(goal.kind)}: </Text>{goal.statement}
                </Text>
              ))}
            </Stack>
          </div>
        )}

        {!item.question && (
          <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
            {item.capabilityName && <Fact label={t('Capability')} value={item.capabilityName} />}
            <Fact label={t('Estimated cost')} value={item.estimatedCostCents > 0 ? money(item.estimatedCostCents) : t('None declared')} />
          </SimpleGrid>
        )}

        <Group gap="lg">
          <Anchor component="button" size="sm" onClick={() => void showTrace()}>
            <Group gap={6}><IconRoute size={16} />{traceOpen ? t('Hide what happened') : t('What happened')}</Group>
          </Anchor>
          {item.taskId && <Anchor component="button" size="sm" onClick={openTask}>{t('Open the task')}</Anchor>}
        </Group>
        <Collapse expanded={traceOpen}>
          <Box>{trace ? <TraceView trace={trace} /> : <Text size="sm" c="dimmed">{t('Loading…')}</Text>}</Box>
        </Collapse>

        {item.question ? (
          // An agent asked with `owner.ask` and its task is parked on the
          // answer. The answer is the note on a yes; "stop" is a no, which
          // cancels the task, as it does for any escalation about live work.
          <Paper withBorder radius="md" p="md" bg="var(--mantine-color-blue-light)">
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>{t('The agent asks')}</Text>
            <Text size="sm" fw={600} mb="sm" style={{ whiteSpace: 'pre-wrap' }}>{item.question}</Text>
            {item.options && item.options.length > 0 && (
              <Stack gap={6} mb="sm">
                {item.options.map((option) => (
                  <Button key={option} variant="default" justify="flex-start" loading={busy === `choose:${option}`}
                    onClick={() => void choose(option)} styles={{ label: { whiteSpace: 'normal', textAlign: 'left' } }}>
                    {option}
                  </Button>
                ))}
              </Stack>
            )}
            <Textarea
              label={item.options && item.options.length > 0 ? t('Or answer in words') : t('Your answer')}
              description={t('The task waits for it, then carries on with it.')}
              autosize
              minRows={2}
              value={note}
              onChange={(event) => setNote(event.currentTarget.value)}
            />
          </Paper>
        ) : (
          <Textarea
            label={t('Your note')}
            description={t('Kept with the decision in your history. For “Ask”, this is the question.')}
            autosize
            minRows={2}
            value={note}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        )}

        {item.kind === 'escalation' && !item.question && (
          <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-default-hover)">
            <Textarea
              label={t('Answer the agent instead')}
              description={t('Sends your answer and puts the task back on the queue, without deciding the item.')}
              autosize
              minRows={2}
              value={answer}
              onChange={(event) => setAnswer(event.currentTarget.value)}
            />
            <Group justify="flex-end" mt="xs">
              <Button size="xs" variant="light" disabled={!answer.trim()} loading={busy === 'answer'} onClick={() => void sendAnswer()}>
                {t('Send answer')}
              </Button>
            </Group>
          </Paper>
        )}

        {error && <Alert color="red" variant="light">{error}</Alert>}
      </Stack>
      <Divider />
      {item.question ? (
        <Group p="md" justify="flex-end" wrap="wrap" gap="xs" bg="var(--mantine-color-default-hover)">
          <Button variant="default" leftSection={<IconX size={16} />} loading={busy === 'deny'} onClick={() => void decide('deny')}>
            {t('Stop the task')}
          </Button>
          <Button variant="outline" color="teal" leftSection={<IconCheck size={16} />} disabled={!note.trim()} loading={busy === 'approve'} onClick={() => void decide('approve')}>
            {t('Send the answer')}
          </Button>
        </Group>
      ) : (
      <Group p="md" justify="space-between" wrap="wrap" gap="xs" bg="var(--mantine-color-default-hover)">
        <Button variant="subtle" leftSection={<IconMessageQuestion size={16} />} loading={busy === 'ask'} onClick={() => void decide('ask')}>
          {t('Ask a question')}
        </Button>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconX size={16} />} loading={busy === 'deny'} onClick={() => void decide('deny')}>
            {t('Deny')}
          </Button>
          <Button variant="outline" color="teal" leftSection={<IconCheck size={16} />} loading={busy === 'approve'} onClick={() => void decide('approve')}>
            {t('Approve')}
          </Button>
        </Group>
      </Group>
      )}
    </Paper>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>{label}</Text>
      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{children}</Text>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" px="sm" py={8}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" fw={600} truncate>{value}</Text>
    </Paper>
  );
}
