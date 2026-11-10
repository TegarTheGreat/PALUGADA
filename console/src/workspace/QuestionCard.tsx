/**
 * A run's question, as a card in a room (F19.5, F19.6): the question in the
 * agent's words, through Prose, its options, and a box to answer in. An
 * answer goes by the inbox's own route (`/inbox/:itemId/answer`), so the
 * server decides who may answer exactly as the inbox does: the owner, the
 * person it was put to, or an approver when it was put to nobody (F19.8).
 * Another seat's question shows only whom it is for.
 */
import { useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconMessageQuestion } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { Prose } from '../components/Prose.tsx';
import { relative } from '../format.ts';
import { N, t } from '../i18n.ts';
import { nameOf, useScope } from './scope.ts';
import type { CardView } from './types.ts';

/** How an item ended, as a card says it (src/workspace/views.ts `itemState`). */
const ENDED: Record<string, string> = {
  open: N('Waiting for an answer'), answered: N('Answered'), approved: N('Approved'), denied: N('Denied'),
  asked: N('Asked back'), expired: N('Expired'), closed: N('Closed'), gone: N('No longer kept'),
};

export function itemStateSaid(state: string): string {
  const said = ENDED[state];
  return said ? t(said) : state;
}

export function QuestionCard({ card }: { card: CardView }) {
  const scope = useScope();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const question = card.question;
  if (!question) return null;

  const send = async (words: string) => {
    if (!card.itemId || !words.trim()) return;
    setBusy(words);
    try {
      await api('POST', `/api/companies/${scope.companyId}/inbox/${card.itemId}/answer`, { answer: words });
      notifications.show({ color: 'teal', message: t('Answer sent. The task carries on with it.') });
      setAnswer('');
      scope.changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Paper withBorder radius="md" p="sm" mt={6} maw={560} style={{ borderInlineStart: '3px solid var(--mantine-color-violet-5)' }}>
      <Stack gap={6}>
        {/* On a narrow column the state moves to its own line rather than being cut short. */}
        <Group gap="xs" justify="space-between" wrap="wrap" align="flex-start" style={{ rowGap: 4 }}>
          <Group gap={6} wrap="nowrap" align="flex-start" style={{ minWidth: 0, flex: '1 1 10rem' }}>
            <IconMessageQuestion size={16} color="var(--mantine-color-violet-6)" style={{ flexShrink: 0, marginTop: 2 }} />
            <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>
              {question.addressee ? t('A question for {name}', { name: nameOf(question.addressee) }) : t('A question from {role}', { role: card.role?.label ?? t('the role') })}
            </Text>
          </Group>
          <Badge size="sm" variant="light" color={card.state === 'open' ? 'violet' : 'gray'} radius="sm" style={{ flexShrink: 0 }}>{itemStateSaid(card.state)}</Badge>
        </Group>
        {!question.hidden && <Prose text={question.text} />}
        {question.endsAt && card.state === 'open' && (
          <Text size="xs" c="dimmed">{t('The meeting goes on without an answer {time}.', { time: relative(question.endsAt) })}</Text>
        )}
        {card.may.answer && card.state === 'open' && (
          <>
            {question.options.length > 0 && (
              <Group gap={6}>
                {question.options.map((option) => (
                  <Button key={option} size="compact-sm" variant="light" loading={busy === option} onClick={() => void send(option)}>{option}</Button>
                ))}
              </Group>
            )}
            <Group gap="xs" align="flex-end" wrap="nowrap">
              <Textarea style={{ flex: 1 }} size="xs" autosize minRows={1} maxRows={5} placeholder={t('Your answer')}
                value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} />
              <Button size="xs" variant="outline" disabled={!answer.trim()} loading={busy === answer} onClick={() => void send(answer)}>{t('Send the answer')}</Button>
            </Group>
          </>
        )}
      </Stack>
    </Paper>
  );
}
