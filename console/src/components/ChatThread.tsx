/**
 * A customer's conversation, as the owner reads it (0111): the customer on
 * one side, the company on the other, and what each message did -- started
 * work, joined it, or waited out the channel's hour.
 *
 * Shown on Customers, and on a card asking to send a reply, beside the reply:
 * what the customer asked is half of whether the answer is right.
 */
import { Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { dateTime, relative } from '../format.ts';
import { t } from '../i18n.ts';
import type { Chat, ChatMessage } from '../types.ts';

/** What arrived that is not text, in words. */
export function attachmentSaid(kind: string): string {
  switch (kind) {
    case 'photo': return t('Sent a picture');
    case 'voice': case 'audio': case 'video_note': return t('Sent a voice message');
    case 'document': return t('Sent a file');
    default: return t('Sent something that is not text');
  }
}

/** A channel as customers find it: a bot's username, a number to dial, an address. */
export function channelSaid(kind: Chat['kind'], account: string): string {
  return kind === 'whatsapp' ? `+${account}` : kind === 'email' ? account : `@${account}`;
}

/** How the customer is reached: their username, their number, their address. */
export function handleSaid(kind: Chat['kind'], handle: string): string {
  return kind === 'whatsapp' ? `+${handle}` : kind === 'email' ? handle : `@${handle}`;
}

/** Who the customer is, as they named themselves. */
export function customerSaid(chat: Pick<Chat, 'customerName' | 'customerHandle' | 'kind'>): string {
  return chat.customerName ?? (chat.customerHandle ? handleSaid(chat.kind, chat.customerHandle) : t('A customer'));
}

export function ChatThread({ messages }: { messages: ChatMessage[] }) {
  return (
    <Stack gap="xs">
      {messages.map((message) => {
        const theirs = message.direction === 'in';
        return (
          <Group key={message.id} justify={theirs ? 'flex-start' : 'flex-end'} wrap="nowrap">
            <Paper
              radius="lg"
              px="sm"
              py={6}
              maw="85%"
              withBorder={theirs}
              bg={theirs ? undefined : 'var(--mantine-color-blue-light)'}
            >
              {message.subject && <Text size="xs" fw={600} style={{ overflowWrap: 'anywhere' }}>{message.subject}</Text>}
              {message.body && <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.body}</Text>}
              {message.attachment && <Text size="sm" c="dimmed" fs="italic">{attachmentSaid(message.attachment)}</Text>}
              <Group gap={6} mt={2} justify={theirs ? 'flex-start' : 'flex-end'}>
                <Text size="xs" c="dimmed" title={dateTime(message.at)}>{relative(message.at)}</Text>
                {message.outcome === 'limited' && (
                  <Badge size="xs" color="orange" variant="light">{t('Past the hour\'s limit: no work started')}</Badge>
                )}
                {!message.sent && <Badge size="xs" color="red" variant="light">{t('Not sent')}</Badge>}
              </Group>
            </Paper>
          </Group>
        );
      })}
    </Stack>
  );
}

/**
 * The conversation a piece of work answers, its last few messages: on a card
 * asking to send a reply. Nothing at all when the work answers no customer.
 */
export function ConversationOfTask({ companyId, taskId }: { companyId: string; taskId: string }) {
  const view = useLoad(async () => {
    const found: { chats: Chat[] } = await api('GET', `/api/companies/${companyId}/chats?task=${taskId}`);
    const chat = found.chats[0];
    if (!chat) return null;
    const opened: { chat: Chat; messages: ChatMessage[] } = await api('GET', `/api/companies/${companyId}/chats/${chat.id}`);
    return opened;
  }, [companyId, taskId]);
  if (!view.data) return null;
  const { chat, messages } = view.data;
  return (
    <Box>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>
        {t('The conversation with {customer}, on {channel}', { customer: customerSaid(chat), channel: channelSaid(chat.kind, chat.account) })}
      </Text>
      <ChatThread messages={messages.slice(-6)} />
    </Box>
  );
}
