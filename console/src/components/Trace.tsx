/**
 * What happened behind a decision (F11.2): the runs that led to it, step by
 * step, with what each model call cost. A timeline a person reads, not the
 * JSON a program would.
 */
import { Badge, Code, Group, Paper, Spoiler, Stack, Text, Timeline } from '@mantine/core';
import {
  IconBolt, IconBrain, IconCircleCheck, IconCircleX, IconFlag, IconHandStop, IconTool,
} from '@tabler/icons-react';
import type { Trace, TraceStep } from '../types.ts';
import { count, dateTime, haltReason, humanize, money } from '../format.ts';
import { t } from '../i18n.ts';
import { StatusBadge } from './ui.tsx';

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
  const capability = typeof detail.capability === 'string' ? detail.capability : null;
  const badges: string[] = [];
  if (typeof detail.tier === 'number') badges.push(t('tier {tier}', { tier: detail.tier }));
  if (Array.isArray(detail.policies) && detail.policies.length > 0) badges.push(t('policies: {names}', { names: detail.policies.join(', ') }));
  if (typeof detail.approvedBy === 'string') badges.push(t('approved by {who}', { who: detail.approvedBy }));
  const error = typeof detail.error === 'string' ? detail.error : null;
  const parts: Array<{ label: string; value: unknown }> = [];
  if (step.name.startsWith('capability:')) {
    const name = step.name.slice('capability:'.length);
    const asked = (detail.input as { input?: unknown } | undefined)?.input ?? detail.input;
    if (asked !== undefined) parts.push({ label: t('What it was asked'), value: asked });
    if (detail.output !== undefined) parts.push({ label: t('What came back'), value: detail.output });
    return {
      title: detail.status === 'committed' ? t('{capability} done', { capability: name }) : t('{capability}: {status}', { capability: name, status: humanize(String(detail.status ?? '')) }),
      badges, parts, error, failed: detail.status === 'failed', outside: false,
    };
  }
  if (step.name === 'tool.called' && capability) return { title: t('Called {capability}', { capability }), badges, parts, error, failed: false, outside: false };
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
  return { title: humanize(step.name), badges, parts, error, failed: step.kind === 'denial', outside: false };
}

export function TraceView({ trace }: { trace: Trace }) {
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
