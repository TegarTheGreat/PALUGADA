/**
 * An approval, as a card in a room (F19.7): the inbox's item, decided by
 * the inbox's route with the inbox's buttons (`DecisionButtons`), so a room
 * adds no easier way to say yes. A tier 3 approval is never decided here:
 * the owner is sent to the inbox, and anyone else told it waits for the
 * owner. A reaction on this card is refused by the server, and read by
 * nothing.
 */
import { useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconInbox } from '@tabler/icons-react';
import { api, ApiError, explain } from '../api.ts';
import { DecisionButtons } from '../components/DecisionButtons.tsx';
import { TierBadge } from '../components/ui.tsx';
import { useFactor } from '../factor.tsx';
import { t } from '../i18n.ts';
import { itemStateSaid } from './QuestionCard.tsx';
import { useScope } from './scope.ts';
import type { CardView } from './types.ts';

export function ApprovalCard({ card }: { card: CardView }) {
  const scope = useScope();
  const requireFactor = useFactor();
  const [busy, setBusy] = useState<string | null>(null);
  const approval = card.approval;
  if (!approval) return null;

  const decide = async (decision: 'approve' | 'deny') => {
    if (!card.itemId) return;
    setBusy(decision);
    const send = (proof?: unknown) => api('POST', `/api/companies/${scope.companyId}/inbox/${card.itemId}/decide`, {
      decision, note: '', ...(proof ? { proof } : {}),
    });
    try {
      // Tried without a factor first, as the inbox does: the server says when one is needed.
      try {
        await send();
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.code === 'approval.channel_forbidden')) throw failure;
        if (!(await requireFactor(approval.title, (proof) => send(proof)))) return;
      }
      notifications.show({ color: decision === 'approve' ? 'teal' : 'gray', message: decision === 'approve' ? t('Approved.') : t('Denied.') });
      scope.changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Paper withBorder radius="md" p="sm" mt={6} maw={560} style={{ borderInlineStart: '3px solid var(--mantine-color-orange-5)' }}>
      <Stack gap={6}>
        <Group gap="xs" justify="space-between" wrap="nowrap" align="flex-start">
          <Text size="sm" fw={600} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{approval.title}</Text>
          <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
            <TierBadge tier={approval.tier} />
            {card.state !== 'open' && <Badge size="sm" variant="light" color="gray" radius="sm">{itemStateSaid(card.state)}</Badge>}
          </Group>
        </Group>
        {/* A capability's approval often says the same thing twice: it is said once. */}
        {approval.summary.trim() !== approval.title.trim() && <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{approval.summary}</Text>}
        {approval.consequence && <Text size="xs" c="dimmed">{t('If denied: {consequence}', { consequence: approval.consequence })}</Text>}
        {card.state === 'open' && (card.inInbox ? (
          scope.kind === 'owner'
            ? <Group><Button size="xs" variant="light" leftSection={<IconInbox size={14} />} onClick={() => scope.ctx.open('inbox', { item: card.itemId })}>{t('Open in Inbox')}</Button></Group>
            : <Text size="xs" c="dimmed">{t('Waiting for the owner: tier 3 is decided in the inbox.')}</Text>
        ) : card.may.decide ? (
          <Group justify="flex-end"><DecisionButtons decide={decide} busy={busy} size="xs" /></Group>
        ) : (
          <Text size="xs" c="dimmed">{t('Waiting for an approver.')}</Text>
        ))}
      </Stack>
    </Paper>
  );
}
