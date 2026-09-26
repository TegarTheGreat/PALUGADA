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
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Anchor, Badge, Box, Breadcrumbs, Button, Collapse, Divider, Grid, Group, Kbd, Paper,
  ScrollArea, SegmentedControl, SimpleGrid, Stack, Text, Textarea, Title, Tooltip,
} from '@mantine/core';
import { useHotkeys, useMediaQuery } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import {
  IconAlertTriangle, IconArrowLeft, IconCheck, IconClock, IconCoin, IconInbox, IconMessageQuestion,
  IconRoute, IconTarget, IconX,
} from '@tabler/icons-react';
import { api, ApiError } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Digest, InboxItem, Trace } from '../types.ts';
import { money, relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, KindBadge, LoadFailed, Loading, StatCard, TierBadge } from '../components/ui.tsx';
import { TraceView } from '../components/Trace.tsx';

type Filter = 'all' | 'approval' | 'incident' | 'escalation';

const KIND_COLOR: Record<string, string> = {
  approval: 'var(--mantine-color-orange-6)',
  incident: 'var(--mantine-color-red-6)',
  escalation: 'var(--mantine-color-violet-6)',
};

export function Decisions({ ctx, linkedItem, clearLinked }: PageProps) {
  const { companyId } = ctx;
  const queue = useLoad(async () => {
    const [{ items }, digest]: [{ items: InboxItem[] }, Digest] = await Promise.all([
      api('GET', `/api/companies/${companyId}/inbox`),
      api('GET', `/api/companies/${companyId}/digest`),
    ]);
    return { items, digest };
  }, [companyId]);
  const [filter, setFilter] = useState<Filter>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [missingLink, setMissingLink] = useState(false);
  const narrow = useMediaQuery('(max-width: 62em)');

  const items = useMemo(() => {
    const all = queue.data?.items ?? [];
    // Tier 3 first, then incidents, then oldest: what costs most to leave waiting.
    const weight = (item: InboxItem) => (item.tier === 3 ? 0 : item.kind === 'incident' ? 1 : 2);
    return all
      .filter((item) => filter === 'all' || item.kind === filter)
      .sort((a, b) => weight(a) - weight(b) || a.createdAt.localeCompare(b.createdAt));
  }, [queue.data, filter]);

  useEffect(() => {
    if (!queue.data) return;
    ctx.setOpenCount(queue.data.items.length);
    if (linkedItem) {
      // An item that has closed since the notification went out is not in
      // the queue any more, and the owner is told so rather than shown a
      // queue that silently lacks the thing they tapped on.
      if (queue.data.items.some((item) => item.id === linkedItem)) setSelected(linkedItem);
      else setMissingLink(true);
      clearLinked();
      return;
    }
    if (!narrow && (!selected || !items.some((item) => item.id === selected))) setSelected(items[0]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue.data, items]);

  const move = (step: number) => {
    const index = items.findIndex((item) => item.id === selected);
    const next = items[Math.min(Math.max(index + step, 0), items.length - 1)];
    if (next) setSelected(next.id);
  };
  useHotkeys([['ArrowDown', () => move(1)], ['j', () => move(1)], ['ArrowUp', () => move(-1)], ['k', () => move(-1)]]);

  if (queue.error) return <LoadFailed message={queue.error} retry={queue.reload} />;
  if (!queue.data) return <Loading rows={4} />;

  const { digest } = queue.data;
  const current = items.find((item) => item.id === selected) ?? null;
  const showList = !narrow || !current;
  const showDetail = !narrow || current;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <div>
          <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
          <Title order={2}>Decisions</Title>
        </div>
        <Group gap={6} visibleFrom="sm">
          <Text size="xs" c="dimmed">Move with</Text><Kbd size="xs">↑</Kbd><Kbd size="xs">↓</Kbd>
        </Group>
      </Group>

      {!(narrow && current) && (<>
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatCard label="Needs you" value={queue.data.items.length} icon={<IconInbox size={20} />} color="red"
          hint={digest.openIncidents > 0 ? `${digest.openIncidents} incident${digest.openIncidents === 1 ? '' : 's'}` : 'No incidents'} />
        <StatCard label="Done today" value={digest.tasksCompleted} icon={<IconCheck size={20} />} color="teal" />
        <StatCard label="Failed or halted" value={digest.tasksFailed + digest.tasksHalted}
          alert={digest.tasksFailed + digest.tasksHalted > 0} icon={<IconAlertTriangle size={20} />} color="orange" />
        <StatCard label="Spent today" value={money(digest.moneySpentCents)} icon={<IconCoin size={20} />} color="blue" />
      </SimpleGrid>

      {digest.highlights.length > 0 && (
        <Alert variant="light" color="blue" title="Today">
          <Stack gap={2}>{digest.highlights.map((line) => <Text key={line} size="sm">{line}</Text>)}</Stack>
        </Alert>
      )}
      </>)}
      {missingLink && (
        <Alert color="gray" variant="light" withCloseButton onClose={() => setMissingLink(false)}>
          The item you followed has already been decided or closed; it is in the history.
        </Alert>
      )}

      {queue.data.items.length === 0 ? (
        <Paper withBorder radius="md">
          <EmptyState
            image="/illustrations/inbox-zero.webp"
            title="Nothing needs you"
            description="Every approval, incident and question has been answered. New ones arrive here, and on your phone if a push channel is set."
          />
        </Paper>
      ) : (
        <Grid gap="lg" align="flex-start">
          {showList && (
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Paper withBorder radius="md" p="xs">
                <SegmentedControl
                  fullWidth
                  size="xs"
                  value={filter}
                  onChange={(value) => setFilter(value as Filter)}
                  data={[
                    { value: 'all', label: `All ${queue.data.items.length}` },
                    { value: 'approval', label: 'Approvals' },
                    { value: 'incident', label: 'Incidents' },
                    { value: 'escalation', label: 'Questions' },
                  ]}
                  mb="xs"
                />
                <ScrollArea.Autosize mah="calc(100vh - 360px)" type="auto">
                  <Stack gap={4}>
                    {items.length === 0 && <Text c="dimmed" size="sm" p="md" ta="center">Nothing of this kind.</Text>}
                    {items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="queue-row"
                        data-active={item.id === selected || undefined}
                        style={{ ['--kind-color' as string]: KIND_COLOR[item.kind] }}
                        onClick={() => setSelected(item.id)}
                      >
                        <Text fw={600} size="sm" lineClamp={2}>{item.title}</Text>
                        <Group gap={6} mt={6}>
                          <TierBadge tier={item.tier} />
                          <KindBadge kind={item.kind} />
                          <Text size="xs" c="dimmed">{relative(item.createdAt)}</Text>
                          {item.estimatedCostCents > 0 && <Text size="xs" c="dimmed">· {money(item.estimatedCostCents)}</Text>}
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
                  back={narrow ? () => setSelected(null) : undefined}
                  decided={() => { setSelected(null); queue.reload(); }}
                />
              ) : (
                <Paper withBorder radius="md" p="xl"><Text c="dimmed" ta="center">Choose an item.</Text></Paper>
              )}
            </Grid.Col>
          )}
        </Grid>
      )}
    </Stack>
  );
}

function Detail({
  item, companyId, back, decided,
}: { item: InboxItem; companyId: string; back: (() => void) | undefined; decided: () => void }) {
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
      setError('Write the question in the note first.');
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
        message: decision === 'approve' ? 'Approved.' : decision === 'deny' ? 'Denied.' : 'Question sent to the agent.',
      });
      decided();
    } catch (failure) {
      setError((failure as Error).message);
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
      setTrace({ reason: (failure as Error).message, runs: [], calls: [] });
    }
  };

  // F10.3's other direction: an agent asked something, and this is the answer
  // going back. It puts the task back on the queue rather than deciding it.
  const sendAnswer = async () => {
    setBusy('answer');
    setError(null);
    try {
      await api('POST', `/api/companies/${companyId}/inbox/${item.id}/answer`, { answer });
      notifications.show({ color: 'blue', message: 'Answer sent; the task is back in the queue.' });
      decided();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const expires = item.expiresAt ? new Date(item.expiresAt) : null;
  const soon = expires !== null && expires.getTime() - Date.now() < 6 * 3_600_000;

  return (
    <Paper withBorder radius="md" shadow="xs" style={{ overflow: 'hidden' }}>
      <Box p="lg" style={{ borderTop: `4px solid ${KIND_COLOR[item.kind] ?? 'var(--mantine-color-gray-4)'}` }}>
        {back && (
          <Button variant="subtle" size="xs" leftSection={<IconArrowLeft size={14} />} onClick={back} mb="sm" px={4}>
            All decisions
          </Button>
        )}
        <Group gap="xs" mb="xs">
          <TierBadge tier={item.tier} />
          <KindBadge kind={item.kind} />
          {expires && (
            <Tooltip label={`Unanswered, it is cancelled ${expires.toLocaleString()} -- silence never executes anything`}>
              <Badge color={soon ? 'red' : 'gray'} variant="light" leftSection={<IconClock size={12} />}>
                Expires {relative(item.expiresAt)}
              </Badge>
            </Tooltip>
          )}
        </Group>
        <Title order={3} fz={20} lh={1.3}>{item.title}</Title>
        <Text size="sm" c="dimmed" mt={6}>
          {item.roleSlug ? `Asked by ${item.roleSlug}` : 'Raised by the platform'}
          {item.divisionName ? ` in ${item.divisionName}` : ''} · {relative(item.createdAt)}
        </Text>
      </Box>
      <Divider />
      <Stack p="lg" gap="md">
        {item.actionSummary && item.actionSummary !== item.title && (
          <Block label="What will happen">{item.actionSummary}</Block>
        )}
        {item.rationale && <Block label="Why">{item.rationale}</Block>}
        {item.consequenceIfDenied && <Block label="If you refuse">{item.consequenceIfDenied}</Block>}

        {item.goalChain.length > 0 && (
          <div>
            <Group gap={6} mb={6}><IconTarget size={16} /><Text size="xs" fw={700} tt="uppercase" c="dimmed">Serves</Text></Group>
            <Breadcrumbs separator="→" separatorMargin={6} style={{ flexWrap: 'wrap' }}>
              {item.goalChain.map((goal) => (
                <Text key={goal.statement} size="sm"><Text span c="dimmed" size="xs">{goal.kind.replace('_', ' ')}: </Text>{goal.statement}</Text>
              ))}
            </Breadcrumbs>
          </div>
        )}

        <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="sm">
          {item.capabilityName && <Fact label="Capability" value={item.capabilityName} />}
          <Fact label="Estimated cost" value={item.estimatedCostCents > 0 ? money(item.estimatedCostCents) : 'None declared'} />
        </SimpleGrid>

        <div>
          <Anchor component="button" size="sm" onClick={() => void showTrace()}>
            <Group gap={6}><IconRoute size={16} />{traceOpen ? 'Hide what happened' : 'What happened'}</Group>
          </Anchor>
          <Collapse expanded={traceOpen}>
            <Box mt="sm">{trace ? <TraceView trace={trace} /> : <Text size="sm" c="dimmed">Loading…</Text>}</Box>
          </Collapse>
        </div>

        <Textarea
          label="Your note"
          description="Kept with the decision in your history. For “Ask”, this is the question."
          autosize
          minRows={2}
          value={note}
          onChange={(event) => setNote(event.currentTarget.value)}
        />

        {item.kind === 'escalation' && (
          <Paper withBorder radius="md" p="sm" bg="var(--mantine-color-default-hover)">
            <Textarea
              label="Answer the agent instead"
              description="Sends your answer and puts the task back on the queue, without deciding the item."
              autosize
              minRows={2}
              value={answer}
              onChange={(event) => setAnswer(event.currentTarget.value)}
            />
            <Group justify="flex-end" mt="xs">
              <Button size="xs" variant="light" disabled={!answer.trim()} loading={busy === 'answer'} onClick={() => void sendAnswer()}>
                Send answer
              </Button>
            </Group>
          </Paper>
        )}

        {error && <Alert color="red" variant="light">{error}</Alert>}
      </Stack>
      <Divider />
      <Group p="md" justify="space-between" wrap="wrap" gap="xs" bg="var(--mantine-color-default-hover)">
        <Button variant="subtle" leftSection={<IconMessageQuestion size={16} />} loading={busy === 'ask'} onClick={() => void decide('ask')}>
          Ask a question
        </Button>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconX size={16} />} loading={busy === 'deny'} onClick={() => void decide('deny')}>
            Deny
          </Button>
          <Button variant="outline" color="teal" leftSection={<IconCheck size={16} />} loading={busy === 'approve'} onClick={() => void decide('approve')}>
            Approve
          </Button>
        </Group>
      </Group>
    </Paper>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>{label}</Text>
      <Text size="sm">{children}</Text>
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
