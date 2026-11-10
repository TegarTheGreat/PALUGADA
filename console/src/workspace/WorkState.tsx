/**
 * The work a message asked for, drawn under it, and a work card in a
 * division room (F19.5, F19.6). Read live from the task every time the room
 * is read (the card holds no words of its own): who does it, drawn as its
 * role and marked as an agent, who asked and what, where it is, and once it
 * is done what the agent wrote, through Prose and said to be the role's.
 */
import { useState } from 'react';
import { Anchor, Avatar, Badge, Button, Group, Paper, Popover, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerStop } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { STATUS_COLORS, statusLabel, whyStopped } from '../format.ts';
import { t } from '../i18n.ts';
import { rolePicture } from '../images.ts';
import { nameOf, useScope } from './scope.ts';
import type { CardView, MessageView } from './types.ts';

export function WorkState({ card, message }: { card: CardView; message: MessageView }) {
  const scope = useScope();
  const [progress, setProgress] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const stopped = card.whyStopped ? whyStopped(card.whyStopped, null).said : null;

  // The owner stops any work by its task, as everywhere; a member or an
  // approver only work it asked for, by its message (F19.8).
  const stop = async () => {
    setBusy(true);
    try {
      if (scope.kind === 'owner' && card.taskId) {
        await api('POST', `/api/companies/${scope.companyId}/tasks/${card.taskId}/cancel`, {});
      } else {
        await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/stop`, {});
      }
      notifications.show({ color: 'teal', message: t('Cancelled, with everything it started.') });
      setStopping(false);
      scope.changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder radius="md" p="sm" mt={6} className="work-card" maw={560}>
      <Stack gap={6}>
        {/* Which agent, that it is an agent, and who asked are what the card is for: on a narrow column they wrap,
            and the state moves to its own line, rather than any of them being cut to a letter. */}
        <Group gap="xs" wrap="wrap" justify="space-between" align="flex-start" style={{ rowGap: 4 }}>
          <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 10rem' }}>
            <Avatar size={28} radius="xl" src={rolePicture(card.role?.picture ?? 'agent')} alt="" style={{ flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <Group gap={6} wrap="wrap" style={{ rowGap: 2 }}>
                <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{card.role ? card.role.label : t('The company')}</Text>
                <Badge size="xs" variant="light" color="grape" radius="sm" style={{ flexShrink: 0 }}>{t('agent')}</Badge>
              </Group>
              {card.askedBy && <Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>{t('asked by {name}', { name: nameOf(card.askedBy) })}</Text>}
            </div>
          </Group>
          <Badge data-work-state={card.state} variant="light" color={STATUS_COLORS[card.state] ?? 'gray'} radius="sm" style={{ flexShrink: 0 }}>
            {statusLabel(card.state)}
          </Badge>
        </Group>
        {/* What was asked, when it is not the message above it: a person's words, drawn as theirs. */}
        {card.goal && card.goal.trim() !== (message.body ?? '').trim() && (
          <div>
            <Text size="xs" c="dimmed">{card.askedBy ? t('{name} asked for', { name: nameOf(card.askedBy) }) : t('Asked for')}</Text>
            <Prose text={card.goal} size="sm" />
          </div>
        )}
        {stopped && <Text size="xs" c="dimmed">{stopped}</Text>}
        {card.lastLine && card.state !== 'completed' && (
          <div>
            <Anchor component="button" type="button" size="xs" onClick={() => setProgress((now) => !now)}>
              {progress ? t('Hide progress') : t('Show progress')}
            </Anchor>
            {progress && <Prose text={card.lastLine} size="xs" />}
          </div>
        )}
        {card.result && (
          <div>
            <Prose text={card.result} />
            {card.role && <Text size="xs" c="dimmed" mt={2}>{t('written by {role}', { role: card.role.label })}</Text>}
          </div>
        )}
        {card.deliverables.length > 0 && (
          <Group gap={6}>
            {card.deliverables.map((one) => <Badge key={one.id} variant="outline" color="gray" radius="sm" tt="none">{one.title}</Badge>)}
          </Group>
        )}
        <Group gap="xs">
          {card.taskId && (
            <Button size="compact-xs" variant="subtle" onClick={() => scope.ctx.open('work', { item: card.taskId })}>{t('Open in Work')}</Button>
          )}
          {card.may.stop && (
            <Popover opened={stopping} onChange={setStopping} position="bottom-start" withArrow shadow="md">
              <Popover.Target>
                <Button size="compact-xs" variant="subtle" color="red" leftSection={<IconPlayerStop size={12} />} onClick={() => setStopping((open) => !open)}>
                  {t('Stop')}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs" maw={240}>
                  <Text size="sm">{t('Cancel this task and everything it started?')}</Text>
                  <Button size="xs" color="red" loading={busy} onClick={() => void stop()}>{t('Cancel this task')}</Button>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
      </Stack>
    </Paper>
  );
}
