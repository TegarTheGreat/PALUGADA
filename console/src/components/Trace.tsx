/**
 * What happened behind a decision (F11.2): the runs that led to it, step by
 * step, with what each model call cost. A timeline a person reads, not the
 * JSON a program would.
 */
import { useState } from 'react';
import { Accordion, Badge, Button, Code, Group, Modal, Paper, Spoiler, Stack, Text, Timeline } from '@mantine/core';
import {
  IconBolt, IconBrain, IconCircleCheck, IconCircleX, IconFileDescription, IconFlag, IconHandStop, IconTool,
} from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { RunBriefing, Trace, TraceRun, TraceStep } from '../types.ts';
import { capabilitySaid, count, dateTime, goalKind, haltReason, money, stepSaid } from '../format.ts';
import { t } from '../i18n.ts';
import { LoadFailed, Loading, StatusBadge } from './ui.tsx';

const STEP_ICON: Record<string, typeof IconTool> = {
  tool_call: IconTool,
  tool_result: IconCircleCheck,
  hook: IconHandStop,
  model: IconBrain,
  denial: IconCircleX,
  lifecycle: IconFlag,
};

/**
 * One step as a sentence, with what it was asked and what it returned kept
 * behind a click: the owner reads "Called email.send, tier 2, approved by
 * you" and opens the message only when they want it.
 */
function describe(step: TraceStep): {
  title: string; badges: string[]; parts: Array<{ label: string; value: unknown }>; error: string | null;
  failed: boolean; outside: boolean;
} {
  const detail = step.detail;
  const capability = typeof detail.capability === 'string' ? capabilitySaid(detail.capability) : null;
  const badges: string[] = [];
  if (typeof detail.tier === 'number') badges.push(t('tier {tier}', { tier: detail.tier }));
  if (Array.isArray(detail.policies) && detail.policies.length > 0) badges.push(t('policies: {names}', { names: detail.policies.join(', ') }));
  if (typeof detail.approvedBy === 'string') badges.push(t('approved by {who}', { who: detail.approvedBy }));
  const error = typeof detail.error === 'string' ? detail.error : null;
  const parts: Array<{ label: string; value: unknown }> = [];
  if (step.name.startsWith('capability:')) {
    const name = capabilitySaid(step.name.slice('capability:'.length));
    const asked = (detail.input as { input?: unknown } | undefined)?.input ?? detail.input;
    if (asked !== undefined) parts.push({ label: t('What it was asked'), value: asked });
    if (detail.output !== undefined) parts.push({ label: t('What came back'), value: detail.output });
    return {
      // A step is started, committed or failed (src/engine/journal.ts); each
      // is a sentence, since a status code filled into one stays English.
      title: detail.status === 'committed' ? t('{capability} done', { capability: name })
        : detail.status === 'failed' ? t('{capability} failed', { capability: name })
          : t('{capability} started', { capability: name }),
      badges, parts, error, failed: detail.status === 'failed', outside: false,
    };
  }
  if (step.name === 'tool.called' && capability) return { title: t('Called {capability}', { capability }), badges, parts, error, failed: false, outside: false };
  if (step.name === 'tool.not_repeated' && capability) return { title: t('{capability} not done again: an earlier attempt had already done it', { capability }), badges: [], parts, error, failed: false, outside: false };
  if (step.name === 'tool.verified' && capability) return { title: t('{capability} read back and matched', { capability }), badges: [], parts, error, failed: false, outside: false };
  if (step.name === 'tool.verify_failed' && capability) return { title: t('{capability} read back differently', { capability }), badges: [], parts, error, failed: true, outside: false };
  if (step.name === 'content.read_outside' && capability) return { title: t('Read content from outside through {capability}', { capability }), badges: [], parts, error, failed: false, outside: true };
  if (step.name === 'model.call') {
    return {
      title: t('Model call: {model}', { model: String(detail.model ?? '') }),
      badges: [t('{count} tokens', { count: count(Number(detail.inputTokens ?? 0) + Number(detail.outputTokens ?? 0)) })],
      parts, error, failed: false, outside: false,
    };
  }
  const rest = Object.fromEntries(Object.entries(detail).filter(([key]) => !['actor', 'idempotencyKey', 'observedPolicies'].includes(key)));
  if (Object.keys(rest).length > 0) parts.push({ label: t('Details'), value: rest });
  return { title: stepSaid(step.name), badges, parts, error, failed: step.kind === 'denial', outside: false };
}

export function TraceView({ trace, companyId }: { trace: Trace; companyId: string }) {
  const [told, setTold] = useState<TraceRun | null>(null);
  if (trace.reason) return <Text size="sm" c="dimmed">{trace.reason}</Text>;
  if (trace.runs.length === 0) return <Text size="sm" c="dimmed">{t('No run has been recorded for this yet.')}</Text>;
  return (
    <Stack gap="lg">
      {trace.runs.map((run) => (
        <Paper key={run.agentRunId} withBorder radius="md" p="md">
          <Group justify="space-between" mb="sm" wrap="wrap" gap="xs">
            <Group gap="xs">
              <Text fw={700}>{run.roleSlug}</Text>
              <Text size="sm" c="dimmed">{t('attempt {attempt}', { attempt: run.attempt + 1 })}</Text>
              <StatusBadge status={run.status} />
            </Group>
            <Group gap="xs">
              <Button size="compact-xs" variant="subtle" leftSection={<IconFileDescription size={14} />} onClick={() => setTold(run)}>
                {t('What it was told')}
              </Button>
              <Badge variant="light" color="gray">{t('{count} tokens', { count: count(run.tokens.input + run.tokens.output) })}</Badge>
              <Badge variant="light" color="blue">{money(run.costCents)}</Badge>
            </Group>
          </Group>
          {run.haltReason && <Text size="sm" c="red" mb="sm">{t('Halted: {reason}', { reason: haltReason(run.haltReason) })}</Text>}
          {run.steps.length === 0 ? (
            <Text size="sm" c="dimmed">{t('No steps recorded.')}</Text>
          ) : (
            <Timeline bulletSize={24} lineWidth={2} active={run.steps.length}>
              {run.steps.map((step, index) => {
                const Icon = STEP_ICON[step.kind] ?? IconBolt;
                const said = describe(step);
                return (
                  <Timeline.Item
                    key={`${step.at}-${index}`}
                    bullet={<Icon size={13} />}
                    color={step.kind === 'denial' || said.failed ? 'red' : step.kind === 'hook' ? 'orange' : said.outside ? 'grape' : 'blue'}
                    title={<Group gap={6} wrap="wrap">
                      <Text size="sm" fw={600}>{said.title}</Text>
                      {said.badges.map((badge) => <Badge key={badge} size="sm" variant="light" color="gray" tt="none">{badge}</Badge>)}
                    </Group>}
                  >
                    <Text size="xs" c="dimmed">{dateTime(step.at)}</Text>
                    {said.error && <Text size="xs" c="red.7" mt={2} style={{ whiteSpace: 'pre-wrap' }}>{said.error}</Text>}
                    {said.parts.map((part) => (
                      <Spoiler key={part.label} maxHeight={0} showLabel={part.label} hideLabel={t('Hide')} mt={4}
                        styles={{ control: { fontSize: 'var(--mantine-font-size-xs)' } }}>
                        <Code block fz={11} style={{ maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(part.value, null, 2)}</Code>
                      </Spoiler>
                    ))}
                  </Timeline.Item>
                );
              })}
            </Timeline>
          )}
        </Paper>
      ))}
      <Modal opened={told !== null} onClose={() => setTold(null)} size="xl"
        title={<Text fw={700}>{told ? t('What {role} was told, attempt {attempt}', { role: told.roleSlug, attempt: told.attempt + 1 }) : ''}</Text>}>
        {told && <Briefing companyId={companyId} run={told} />}
      </Modal>
      {trace.calls.length > 0 && (
        <div>
          <Text fw={700} size="sm" mb="xs">{t('Model calls')}</Text>
          <Stack gap={6}>
            {trace.calls.map((call) => (
              <Group key={call.id} justify="space-between" wrap="nowrap" gap="xs">
                <Text size="sm" truncate>{call.kind === 'settlement' ? t('Run bill settled') : call.model}</Text>
                <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                  {call.kind === 'call' ? `${t('{count} tokens', { count: count(call.inputTokens + call.outputTokens) })} · ` : ''}{money(call.costCents)}
                </Text>
              </Group>
            ))}
          </Stack>
        </div>
      )}
    </Stack>
  );
}

/**
 * What one run was told (0076), section by section: the request its runtime
 * received, whatever the runtime -- so "why did it do that" starts from what
 * it was given.
 */
function Briefing({ companyId, run }: { companyId: string; run: TraceRun }) {
  const found = useLoad(async (): Promise<RunBriefing> =>
    api('GET', `/api/companies/${companyId}/tasks/${run.taskId}/runs/${run.agentRunId}/briefing`), [companyId, run.taskId, run.agentRunId]);
  if (found.error) return <LoadFailed message={found.error} retry={found.reload} />;
  if (!found.data) return <Loading rows={3} />;
  const { briefing, removed } = found.data;
  if (removed === 'retention') return <Text size="sm" c="dimmed">{t('What this run was told has gone with its prompts: they are kept for as long as Settings, Retention says.')}</Text>;
  if (!briefing || removed === 'never_kept') return <Text size="sm" c="dimmed">{t('This run started before PALUGADA kept what runs were told.')}</Text>;
  if (briefing.cut) {
    return (
      <Stack gap="xs">
        <Text size="sm" c="dimmed">{t('Too long to keep whole ({characters} characters); the start of it:', { characters: count(briefing.characters ?? 0) })}</Text>
        <Code block fz={11} style={{ maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{briefing.start}</Code>
      </Stack>
    );
  }
  const pack = briefing.contextPack;
  const text = (body: string) => <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{body}</Text>;
  return (
    <Stack gap="sm">
      <Group gap="xs">
        {briefing.modelRouting && <Badge variant="light" color="gray" tt="none">{[briefing.modelRouting.primary, ...briefing.modelRouting.fallback].join(' → ')}</Badge>}
        {briefing.limits && <Badge variant="light" color="gray" tt="none">{t('{count} tokens', { count: count(briefing.limits.tokens) })}</Badge>}
      </Group>
      <Accordion multiple defaultValue={['charter']} variant="separated">
        {pack && (
          <Accordion.Item value="charter">
            <Accordion.Control>{t('Charter and role')}</Accordion.Control>
            <Accordion.Panel>{text(pack.charter)}</Accordion.Panel>
          </Accordion.Item>
        )}
        {briefing.task && (
          <Accordion.Item value="task">
            <Accordion.Control>{t('The task')}</Accordion.Control>
            <Accordion.Panel><Code block fz={11}>{JSON.stringify(briefing.task.input, null, 2)}</Code></Accordion.Panel>
          </Accordion.Item>
        )}
        {pack?.goalAncestry.length ? (
          <Accordion.Item value="goals">
            <Accordion.Control>{t('Goals: {count}', { count: pack.goalAncestry.length })}</Accordion.Control>
            <Accordion.Panel><Stack gap={4}>{pack.goalAncestry.map((goal, index) => <Text key={index} size="sm"><b>{goalKind(goal.kind)}</b> · {goal.statement}</Text>)}</Stack></Accordion.Panel>
          </Accordion.Item>
        ) : null}
        {pack?.notes.map((note, index) => (
          <Accordion.Item key={`note-${index}`} value={`note-${index}`}>
            <Accordion.Control>{note.title}</Accordion.Control>
            <Accordion.Panel>{text(note.body)}</Accordion.Panel>
          </Accordion.Item>
        ))}
        {pack?.skills.length ? (
          <Accordion.Item value="skills">
            <Accordion.Control>{t('Skills: {count}', { count: pack.skills.length })}</Accordion.Control>
            <Accordion.Panel><Stack gap="sm">{pack.skills.map((skill, index) => <div key={index}>{text(skill)}</div>)}</Stack></Accordion.Panel>
          </Accordion.Item>
        ) : null}
        {pack?.memories.length ? (
          <Accordion.Item value="memories">
            <Accordion.Control>{t('What the company knows: {count}', { count: pack.memories.length })}</Accordion.Control>
            <Accordion.Panel><Stack gap="sm">{pack.memories.map((memory, index) => <div key={index}>{text(memory)}</div>)}</Stack></Accordion.Panel>
          </Accordion.Item>
        ) : null}
        {pack?.workingMemory.length ? (
          <Accordion.Item value="steps">
            <Accordion.Control>{t('Steps it had done: {count}', { count: pack.workingMemory.length })}</Accordion.Control>
            <Accordion.Panel><Code block fz={11} style={{ maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(pack.workingMemory, null, 2)}</Code></Accordion.Panel>
          </Accordion.Item>
        ) : null}
        {briefing.allowedTools?.length ? (
          <Accordion.Item value="tools">
            <Accordion.Control>{t('Tools: {count}', { count: briefing.allowedTools.length })}</Accordion.Control>
            <Accordion.Panel>
              <Group gap={6}>{briefing.allowedTools.map((tool) => <Badge key={tool.name} variant="light" color="gray" tt="none">{t('{name}, tier {tier}', { name: tool.name, tier: tool.tier })}</Badge>)}</Group>
            </Accordion.Panel>
          </Accordion.Item>
        ) : null}
      </Accordion>
    </Stack>
  );
}

