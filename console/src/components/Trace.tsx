/**
 * What happened behind a decision (F11.2): the runs that led to it, step by
 * step, with what each model call cost. A timeline a person reads, not the
 * JSON a program would.
 */
import { Badge, Code, Group, Paper, Stack, Text, Timeline } from '@mantine/core';
import {
  IconBolt, IconBrain, IconCircleCheck, IconCircleX, IconFlag, IconHandStop, IconTool,
} from '@tabler/icons-react';
import type { Trace } from '../types.ts';
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
              <Text size="sm" c="dimmed">{t('attempt {attempt}', { attempt: run.attempt })}</Text>
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
                return (
                  <Timeline.Item
                    key={`${step.at}-${index}`}
                    bullet={<Icon size={13} />}
                    color={step.kind === 'denial' ? 'red' : step.kind === 'hook' ? 'orange' : 'blue'}
                    title={<Text size="sm" fw={600}>{humanize(step.name)}</Text>}
                  >
                    <Text size="xs" c="dimmed">{dateTime(step.at)} · {humanize(step.kind)}</Text>
                    {Object.keys(step.detail).length > 0 && (
                      <Code block mt={6} fz={11} style={{ maxHeight: 160, overflow: 'auto' }}>
                        {JSON.stringify(step.detail, null, 2)}
                      </Code>
                    )}
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
