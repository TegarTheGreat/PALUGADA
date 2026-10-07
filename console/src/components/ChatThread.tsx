/**
 * A customer's conversation, as the owner reads it (0111): the customer on
 * one side, the company on the other, and what each message did -- started
 * work, joined it, or waited out the channel's hour.
 *
 * Shown on Customers, and on a card asking to send a reply, beside the reply:
 * what the customer asked is half of whether the answer is right.
 */
import { Badge, Box, Group, Paper, Stack, Text } from '@mantine/core';
import { IconDownload, IconFile } from '@tabler/icons-react';
import { api } from '../api.ts';
import { saveCompanyFile } from '../files.ts';
import { useLoad } from '../hooks.ts';
import { dateTime, fileSize, relative } from '../format.ts';
import { t } from '../i18n.ts';
import type { Chat, ChatMessage } from '../types.ts';
import { ActionButton } from './ActionForm.tsx';

/** What arrived that is not text, in words. */
export function attachmentSaid(kind: string): string {
  switch (kind) {
    case 'photo': return t('Sent a picture');
    case 'voice': case 'audio': case 'video_note': return t('Sent a voice message');
    case 'document': return t('Sent a file');
    default: return t('Sent something that is not text');
  }
}

/** What a file a customer sent is, in a word. */
function fileKindSaid(kind: string): string {
  switch (kind) {
    case 'pdf': return t('PDF');
    case 'word': return t('Word document');
    case 'excel': return t('Excel workbook');
    case 'photo': return t('Picture');
    case 'voice': return t('Recording');
    case 'text': return t('Text file');
    default: return t('File');
  }
}

/** Why a file was left, in the owner's language; the server's own sentence is for the run that is told. */
function notKeptSaid(why: ChatMessage['files'][number]['why']): string {
  switch (why) {
    case 'too_big': return t('It was too big to keep.');
    case 'kind': return t('It is a kind of file that is not kept.');
    case 'room': return t('There was no room for it: remove files you no longer need.');
    case 'no_files': return t('This deployment keeps no files, so nothing was kept.');
    case 'failed': return t('It could not be fetched or written.');
    default: return t('It was not kept.');
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
/** The customer by the name on their record, which the owner may have changed, else as they named themselves. */
export function customerSaid(chat: Pick<Chat, 'customerName' | 'customerHandle' | 'kind'> & { contactName?: string | null }): string {
  return chat.contactName ?? chat.customerName ?? (chat.customerHandle ? handleSaid(chat.kind, chat.customerHandle) : t('A customer'));
}

/**
 * `owner` and the company are given where the person reading may take a
 * file out: a customer's file is theirs, from outside, and a seat does not
 * download it.
 */
export function ChatThread({ messages, companyId, owner = false }: { messages: ChatMessage[]; companyId?: string; owner?: boolean }) {
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
              {message.attachment && message.files.length === 0 && <Text size="sm" c="dimmed" fs="italic">{attachmentSaid(message.attachment)}</Text>}
              {message.files.length > 0 && (
                <Stack gap={4} mt={4}>
                  {message.files.map((file, at) => (
                    <Group key={`${at}-${file.path ?? file.name ?? ''}`} gap="xs" wrap="wrap" align="center">
                      <IconFile size={16} style={{ flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{file.name ?? fileKindSaid(file.kind)}</Text>
                        <Text size="xs" c="dimmed">
                          {fileKindSaid(file.kind)}{file.bytes > 0 ? ` · ${fileSize(file.bytes)}` : ''}{file.path ? '' : ` · ${notKeptSaid(file.why)}`}
                        </Text>
                      </div>
                      {file.path && owner && companyId && (
                        <ActionButton size="xs" variant="light" label={t('Download')} leftSection={<IconDownload size={14} />}
                          run={() => saveCompanyFile(companyId, file.path!)} />
                      )}
                    </Group>
                  ))}
                  <Text size="xs" c="dimmed">{t('This came from outside the company. Open it only if you trust the sender.')}</Text>
                </Stack>
              )}
              <Group gap={6} mt={2} justify={theirs ? 'flex-start' : 'flex-end'}>
                <Text size="xs" c="dimmed" title={dateTime(message.at)}>{relative(message.at)}</Text>
                {message.outcome === 'limited' && (
                  <Badge size="xs" color="orange" variant="light">{t('Past the hour\'s limit: no work started')}</Badge>
                )}
                {!message.sent && <Badge size="xs" color="red" variant="light">{t('Not sent')}</Badge>}
              </Group>
              {message.answeredAlone && (
                <Text size="xs" c="dimmed" ta="right" style={{ overflowWrap: 'anywhere' }}>
                  {t('Sent on its own, from {documents}', { documents: message.answeredAlone.from.join(', ') })}
                </Text>
              )}
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
