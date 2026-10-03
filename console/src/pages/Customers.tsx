/**
 * Customers (0111, src/chats/): the company's conversations with the people
 * it serves, and the channels they write on.
 *
 * A channel is a Telegram bot of the company's own, which the owner makes in
 * @BotFather and connects here with their device: every message to it starts
 * work for the role they choose, or joins the work that conversation already
 * has waiting. What a customer writes is data to that work, and every reply
 * waits for the owner's yes, because the work began with a stranger's words
 * (F8.9). The conversations are read here, the latest first.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Drawer, Group, NumberInput, Paper, PasswordInput, Select, Stack, Table, Text, Textarea,
  ThemeIcon, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrandTelegram, IconMessageCircle, IconUser } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { relative, roleLabel } from '../format.ts';
import { openGoals } from '../goals.ts';
import { t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import type { Chat, ChatChannel, ChatMessage, Structure } from '../types.ts';
import { EmptyState, LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';
import { ChatThread, attachmentSaid, customerSaid } from '../components/ChatThread.tsx';

export function Customers({ ctx, route }: PageProps) {
  const { companyId } = ctx;
  const owner = ctx.staff === null;
  const view = useLoad(async () => {
    const [chats, channels]: [{ chats: Chat[] }, { channels: ChatChannel[] }] = await Promise.all([
      api('GET', `/api/companies/${companyId}/chats`),
      api('GET', `/api/companies/${companyId}/chat-channels`),
    ]);
    return { chats: chats.chats, channels: channels.channels };
  }, [companyId], { every: 15_000 });
  const [opened, setOpened] = useState<string | null>(route.item);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Customers')}
      description={t('What customers write to the company, and what it answered. Each message starts work for the role you chose; every reply waits for your yes.')}
      live={view.updatedAt}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={4} /></>;
  const { chats, channels } = view.data;

  return (
    <Stack gap="lg">
      {header}
      <Section title={t('Conversations')} padding="lg">
        {chats.length === 0 ? (
          <EmptyState
            title={t('No customer has written yet')}
            description={channels.some((one) => one.enabled)
              ? t('Share the bot\'s link with your customers: t.me/{account}', { account: channels.find((one) => one.enabled)!.account })
              : t('Connect a Telegram bot below, and what customers write to it comes here.')}
          />
        ) : (
          <Stack gap={4}>
            {chats.map((chat) => (
              <UnstyledButton key={chat.id} onClick={() => setOpened(chat.id)} className="clickable-row" p="xs">
                <Group wrap="nowrap" gap="sm" align="flex-start">
                  <ThemeIcon variant="light" radius="xl" size={34} color={chat.unanswered ? 'blue' : 'gray'}>
                    <IconUser size={18} />
                  </ThemeIcon>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <Group gap={6} wrap="wrap">
                      <Text size="sm" fw={600}>{customerSaid(chat)}</Text>
                      <Text size="xs" c="dimmed">@{chat.account} · {relative(chat.lastMessageAt)}</Text>
                      {chat.unanswered && <Badge size="xs" variant="light">{t('Waiting for an answer')}</Badge>}
                    </Group>
                    {chat.lastMessage && (
                      <Text size="sm" c="dimmed" lineClamp={1} style={{ overflowWrap: 'anywhere' }}>
                        {chat.lastMessage.direction === 'out' ? `${t('The company')}: ` : ''}
                        {chat.lastMessage.body || (chat.lastMessage.attachment ? attachmentSaid(chat.lastMessage.attachment) : '')}
                      </Text>
                    )}
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </Section>

      <Channels companyId={companyId} channels={channels} owner={owner} changed={view.reload} />

      <Drawer opened={opened !== null} onClose={() => setOpened(null)} position="right" size="lg" title={t('Conversation')}>
        {opened && <Conversation companyId={companyId} chatId={opened} />}
      </Drawer>
    </Stack>
  );
}

function Conversation({ companyId, chatId }: { companyId: string; chatId: string }) {
  const view = useLoad<{ chat: Chat; messages: ChatMessage[] }>(
    () => api('GET', `/api/companies/${companyId}/chats/${chatId}`), [companyId, chatId], { every: 10_000 });
  if (view.error && !view.data) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={4} />;
  const { chat, messages } = view.data;
  return (
    <Stack gap="md">
      <Group gap="xs">
        <Text fw={700}>{customerSaid(chat)}</Text>
        {chat.customerHandle && chat.customerName && <Text size="sm" c="dimmed">@{chat.customerHandle}</Text>}
        <Badge variant="outline" color="gray" leftSection={<IconBrandTelegram size={12} />}>@{chat.account}</Badge>
      </Group>
      {!chat.open && <Alert color="gray" variant="light">{t('This channel is closed: nothing more is heard or sent on it.')}</Alert>}
      <ChatThread messages={messages} />
    </Stack>
  );
}

function Channels({ companyId, channels, owner, changed }: {
  companyId: string; channels: ChatChannel[]; owner: boolean; changed: () => void;
}) {
  const requireFactor = useFactor();
  const structure = useLoad<Structure>(() => api('GET', `/api/companies/${companyId}/structure`), [companyId]);
  const [token, setToken] = useState('');
  const [roleId, setRoleId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [maxPerHour, setMaxPerHour] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ account: string; webhook: string } | null>(null);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      let made: { channel: ChatChannel; webhook: string } | null = null;
      const done = await requireFactor(t('Let customers write to the company'), async (proof) => {
        made = await api('POST', `/api/companies/${companyId}/chat-channels`, {
          kind: 'telegram', token: token.trim(), roleId, goalId, instruction: instruction.trim(), maxPerHour, proof,
        });
      });
      if (!done || !made) return;
      const answer = made as { channel: ChatChannel; webhook: string };
      setOutcome({ account: answer.channel.account, webhook: answer.webhook });
      setToken('');
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  const close = async (channel: ChatChannel) => {
    try {
      await api('POST', `/api/companies/${companyId}/chat-channels/${channel.id}/close`, {});
      notifications.show({ message: t('@{account} is closed. Nothing more is heard on it, and its token is forgotten.', { account: channel.account }) });
      changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const roles = structure.data?.roles ?? [];
  const goals = structure.data ? openGoals(structure.data.goals) : [];
  return (
    <Section
      title={t('Channels')}
      description={t('A Telegram bot of the company\'s own. Make one in @BotFather with /newbot, and paste the token it gives you here.')}
      padding="lg"
    >
      {channels.length > 0 && (
        <Table.ScrollContainer minWidth={480}>
          <Table verticalSpacing="sm" mb={owner ? 'lg' : 0}>
            <Table.Tbody>
              {channels.map((channel) => (
                <Table.Tr key={channel.id}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <IconBrandTelegram size={16} />
                      <Text size="sm" fw={600}>@{channel.account}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={2}>{channel.instruction}</Text>
                  </Table.Td>
                  <Table.Td><Text size="sm">{channel.roleName}</Text></Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <IconMessageCircle size={14} />
                      <Text size="sm" className="tabular">{channel.chats}</Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {channel.enabled
                      ? <Badge color="teal" variant="light">{t('Open to customers')}</Badge>
                      : <Badge color="gray" variant="light">{t('Closed')}</Badge>}
                  </Table.Td>
                  <Table.Td ta="right">
                    {owner && channel.enabled && (
                      <Button size="xs" variant="subtle" color="red" onClick={() => void close(channel)}>{t('Close')}</Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      {owner && (
        <Paper withBorder radius="md" p="md">
          <Text fw={600} mb="sm">{t('Connect a Telegram bot')}</Text>
          <Stack gap="sm">
            <PasswordInput
              label={t('The bot\'s token')}
              description={t('From @BotFather. It is checked with Telegram, then kept sealed; nobody sees it again.')}
              placeholder="7012345678:…"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
              autoComplete="off"
            />
            <Group grow align="flex-start" wrap="wrap">
              <Select
                label={t('Who answers')}
                data={roles.map((role) => ({ value: role.id, label: roleLabel(role) }))}
                value={roleId}
                onChange={setRoleId}
                searchable
                style={{ minWidth: 200 }}
              />
              <Select
                label={t('Serves')}
                data={goals.map((goal) => ({ value: goal.id, label: goal.statement }))}
                value={goalId}
                onChange={setGoalId}
                style={{ minWidth: 200 }}
              />
            </Group>
            <Textarea
              label={t('What to do with each message')}
              placeholder={t('e.g. Answer questions about the menu, prices and orders. Take an order with the address, and hand a complaint to the owner.')}
              autosize
              minRows={2}
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
            />
            <NumberInput
              label={t('New conversations, at most, per hour')}
              min={1}
              max={3600}
              value={maxPerHour}
              onChange={(value) => setMaxPerHour(typeof value === 'number' ? value : 60)}
              maw={260}
            />
            <Text size="xs" c="dimmed">
              {t('The role is given what it needs to read a conversation and reply. Each reply waits for your yes, or an approver\'s, because the work began with a customer\'s words.')}
            </Text>
            {error && <Alert color="red" variant="light">{error}</Alert>}
            {outcome && (
              outcome.webhook === 'set'
                ? <Alert color="teal" variant="light">{t('Customers can write to @{account} now: t.me/{account}', { account: outcome.account })}</Alert>
                : outcome.webhook === 'no_public_address'
                  ? <Alert color="orange" variant="light">{t('@{account} is kept, but Telegram cannot reach this deployment: it has no public address. Set one (PALUGADA_APP_URL_PUBLIC) and connect the bot again.', { account: outcome.account })}</Alert>
                  : <Alert color="orange" variant="light">{t('@{account} is kept, but Telegram refused to send its messages here: {reason}', { account: outcome.account, reason: outcome.webhook })}</Alert>
            )}
            <Group>
              <Button
                leftSection={<IconBrandTelegram size={16} />}
                loading={busy}
                disabled={!token.trim() || !roleId || !goalId || !instruction.trim()}
                onClick={() => void connect()}
              >
                {t('Connect')}
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      {!owner && channels.length === 0 && <Text size="sm" c="dimmed">{t('No channel yet.')}</Text>}
    </Section>
  );
}
