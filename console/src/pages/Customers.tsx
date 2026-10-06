/**
 * Customers (0111, src/chats/): the company's conversations with the people
 * it serves, and the channels they write on.
 *
 * A channel is a Telegram bot or a WhatsApp Business number of the
 * company's own, which the owner connects here with their device: every
 * message to it starts work for the role they choose, or joins the work that
 * conversation already has waiting. A WhatsApp number's webhook is set in
 * its Meta app, so connecting one shows the address and a verify token to
 * paste there, once. What a customer writes is data to that work, and every reply
 * waits for the owner's yes, because the work began with a stranger's words
 * (F8.9) -- unless the owner, with their device, lets a channel answer on its
 * own from the documents they marked for customers (STATUS 2.137). The
 * conversations are read here, the latest first.
 */
import { useState } from 'react';
import {
  Alert, Anchor, Badge, Button, Code, CopyButton, Drawer, Group, NumberInput, Paper, PasswordInput, SegmentedControl, Select,
  Stack, Switch, Table, Text, Textarea, TextInput, ThemeIcon, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconAlertTriangle, IconBrandTelegram, IconBrandWhatsapp, IconExternalLink, IconMail, IconMessageCircle, IconUser } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import { relative, roleLabel } from '../format.ts';
import { openGoals } from '../goals.ts';
import { t } from '../i18n.ts';
import type { PageProps } from '../App.tsx';
import type { Chat, ChatChannel, ChatMessage, Structure } from '../types.ts';
import { EmptyState, LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';
import { ChatThread, attachmentSaid, channelSaid, customerSaid, handleSaid } from '../components/ChatThread.tsx';
import { EMPTY_MAILBOX, MailboxFields, mailboxFilled, mailboxSent, type Mailbox } from '../components/MailboxFields.tsx';
import { Contacts } from '../components/Contacts.tsx';

/** A transport by its mark, never by a picture drawn from a name. */
function KindIcon({ kind, size }: { kind: Chat['kind']; size: number }) {
  if (kind === 'email') return <IconMail size={size} />;
  return kind === 'whatsapp' ? <IconBrandWhatsapp size={size} /> : <IconBrandTelegram size={size} />;
}

/** Where customers find an open channel: a bot's link, or a number's. */
function shareSaid(channel: ChatChannel): string {
  if (channel.kind === 'email') return t('Customers can write to {address}', { address: channel.account });
  return channel.kind === 'whatsapp'
    ? t('Share the number with your customers: wa.me/{number}', { number: channel.account })
    : t('Share the bot\'s link with your customers: t.me/{account}', { account: channel.account });
}

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
      description={t('What customers write to the company, and what it answered. Each message starts work for the role you chose; a reply waits for your yes unless its channel answers on its own.')}
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
              ? shareSaid(channels.find((one) => one.enabled)!)
              : t('Connect a channel below, and what customers write on it comes here.')}
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
                      <Text size="xs" c="dimmed">{channelSaid(chat.kind, chat.account)} · {relative(chat.lastMessageAt)}</Text>
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

      <Contacts companyId={companyId} owner={owner} openChat={setOpened} />

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
        {chat.customerHandle && chat.customerName && <Text size="sm" c="dimmed">{handleSaid(chat.kind, chat.customerHandle)}</Text>}
        <Badge variant="outline" color="gray" leftSection={<KindIcon kind={chat.kind} size={12} />}>{channelSaid(chat.kind, chat.account)}</Badge>
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
  const [kind, setKind] = useState<Chat['kind']>('telegram');
  const [token, setToken] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [mailbox, setMailbox] = useState<Mailbox>(EMPTY_MAILBOX);
  const [roleId, setRoleId] = useState<string | null>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [maxPerHour, setMaxPerHour] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{
    channel: ChatChannel; webhook: string; callbackUrl?: string; verifyToken?: string;
  } | null>(null);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      let made: NonNullable<typeof outcome> | null = null;
      const done = await requireFactor(t('Let customers write to the company'), async (proof) => {
        made = await api('POST', `/api/companies/${companyId}/chat-channels`, {
          kind, token: token.trim(), roleId, goalId, instruction: instruction.trim(), maxPerHour, proof,
          ...(kind === 'whatsapp' ? { phoneNumberId: phoneNumberId.trim(), appSecret: appSecret.trim() } : {}),
          ...(kind === 'email' ? mailboxSent(mailbox) : {}),
        });
      });
      if (!done || !made) return;
      setOutcome(made);
      setToken('');
      setAppSecret('');
      setMailbox((was) => ({ ...was, password: '' }));
      changed();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  // On loosens a control, so the device; off tightens one, so the session.
  const answersAlone = async (channel: ChatChannel, on: boolean) => {
    const name = channelSaid(channel.kind, channel.account);
    try {
      if (on) {
        const done = await requireFactor(t('Let a channel answer customers on its own'), async (proof) => {
          await api('POST', `/api/companies/${companyId}/chat-channels/${channel.id}/answers-alone`, { on: true, proof });
        });
        if (!done) return;
      } else {
        await api('POST', `/api/companies/${companyId}/chat-channels/${channel.id}/answers-alone`, { on: false });
      }
      notifications.show({
        message: on
          ? t('{channel} answers on its own from documents marked for customers.', { channel: name })
          : t('Every reply on {channel} waits for your yes again.', { channel: name }),
      });
      changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const close = async (channel: ChatChannel) => {
    try {
      await api('POST', `/api/companies/${companyId}/chat-channels/${channel.id}/close`, {});
      notifications.show({ message: t('{channel} is closed. Nothing more is heard on it, and its token is forgotten.', { channel: channelSaid(channel.kind, channel.account) }) });
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
      description={t('A Telegram bot or a WhatsApp Business number of the company\'s own. Each message to it starts work for the role you choose.')}
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
                      <KindIcon kind={channel.kind} size={16} />
                      <Text size="sm" fw={600}>{channelSaid(channel.kind, channel.account)}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={2}>{channel.instruction}</Text>
                    {owner && channel.enabled ? (
                      <Switch
                        mt={6}
                        size="xs"
                        checked={channel.answersAlone}
                        onChange={(event) => void answersAlone(channel, event.currentTarget.checked)}
                        label={t('Answers on its own')}
                        description={t('From documents marked for customers, checked before it goes. Refunds, prices of its own, complaints and the law still come to you.')}
                      />
                    ) : channel.answersAlone && (
                      <Badge mt={6} size="xs" variant="light" color="teal">{t('Answers on its own')}</Badge>
                    )}
                    {channel.enabled && channel.failure && (
                      <Group gap={4} wrap="nowrap" mt={4}>
                        <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" style={{ flexShrink: 0 }} />
                        <Text size="xs" c="red" style={{ overflowWrap: 'anywhere' }}>{t('Could not read the mailbox: {reason}', { reason: channel.failure })}</Text>
                      </Group>
                    )}
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
          <Group justify="space-between" mb="sm" gap="sm">
            <Text fw={600}>{kind === 'email' ? t('Connect a mailbox') : kind === 'whatsapp' ? t('Connect a WhatsApp number') : t('Connect a Telegram bot')}</Text>
            <SegmentedControl
              size="xs"
              value={kind}
              onChange={(value) => { setKind(value as Chat['kind']); setOutcome(null); setError(null); }}
              data={[{ value: 'telegram', label: t('Telegram') }, { value: 'whatsapp', label: t('WhatsApp') }, { value: 'email', label: t('Email') }]}
            />
          </Group>
          <Stack gap="sm">
            {kind === 'telegram' ? (
              <>
                <Text size="sm" c="dimmed">{t('A Telegram bot of the company\'s own. Make one in @BotFather with /newbot, and paste the token it gives you here.')}</Text>
                <PasswordInput
                  label={t('The bot\'s token')}
                  description={t('From @BotFather. It is checked with Telegram, then kept sealed; nobody sees it again.')}
                  placeholder="7012345678:…"
                  value={token}
                  onChange={(event) => setToken(event.currentTarget.value)}
                  autoComplete="off"
                />
              </>
            ) : kind === 'email' ? (
              <MailboxFields value={mailbox} onChange={setMailbox} />
            ) : (
              <>
                <Text size="sm" c="dimmed">
                  {t('1. In Meta for Developers, make an app with WhatsApp, add your business number, and make a system user with a permanent token that may send for it.')}{' '}
                  <Anchor href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started" target="_blank" rel="noreferrer" size="sm">{t('Cloud API')} <IconExternalLink size={12} /></Anchor>
                </Text>
                <TextInput label={t('Phone number ID')} description={t('Under WhatsApp, API Setup. Not the number itself.')} value={phoneNumberId}
                  onChange={(event) => setPhoneNumberId(event.currentTarget.value)} inputMode="numeric" />
                <PasswordInput label={t('Access token')} value={token} onChange={(event) => setToken(event.currentTarget.value)} autoComplete="off" />
                <PasswordInput label={t('App secret')} description={t('App settings, Basic. It proves a delivery is from Meta.')} value={appSecret}
                  onChange={(event) => setAppSecret(event.currentTarget.value)} autoComplete="off" />
              </>
            )}
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
              outcome.webhook === 'polled' ? (
                <Alert color="teal" variant="light">{t('{address} is connected. It is read about once a minute, from now on; the mail it already holds is left alone.', { address: outcome.channel.account })}</Alert>
              ) : outcome.webhook === 'manual' && outcome.callbackUrl && outcome.verifyToken ? (
                // Shown once: the verify token is kept only as its hash.
                <Alert color="teal" variant="light">
                  <Stack gap="xs">
                    <Text size="sm">{t('{channel} is kept. In its Meta app, under WhatsApp, Configuration, set the webhook to these two and subscribe to messages. The verify token is shown only now.', { channel: channelSaid(outcome.channel.kind, outcome.channel.account) })}</Text>
                    {[{ label: t('Callback URL'), value: outcome.callbackUrl }, { label: t('Verify token'), value: outcome.verifyToken }].map((field) => (
                      <Group key={field.label} gap="xs" wrap="nowrap">
                        <Text size="xs" c="dimmed" w={96} style={{ flexShrink: 0 }}>{field.label}</Text>
                        <Code style={{ overflowWrap: 'anywhere', flex: 1 }}>{field.value}</Code>
                        <CopyButton value={field.value}>
                          {({ copied, copy }) => <Button size="compact-xs" variant="subtle" onClick={copy}>{copied ? t('Copied') : t('Copy')}</Button>}
                        </CopyButton>
                      </Group>
                    ))}
                  </Stack>
                </Alert>
              ) : outcome.webhook === 'set'
                ? <Alert color="teal" variant="light">{t('Customers can write to @{account} now: t.me/{account}', { account: outcome.channel.account })}</Alert>
                : outcome.webhook === 'no_public_address'
                  ? <Alert color="orange" variant="light">{t('@{account} is kept, but Telegram cannot reach this deployment: it has no public address. Set one (PALUGADA_APP_URL_PUBLIC) and connect the bot again.', { account: outcome.channel.account })}</Alert>
                  : <Alert color="orange" variant="light">{t('@{account} is kept, but Telegram refused to send its messages here: {reason}', { account: outcome.channel.account, reason: outcome.webhook })}</Alert>
            )}
            <Group>
              <Button
                leftSection={<KindIcon kind={kind} size={16} />}
                loading={busy}
                disabled={!roleId || !goalId || !instruction.trim()
                  || (kind === 'email'
                    ? !mailboxFilled(mailbox)
                    : !token.trim() || (kind === 'whatsapp' && (!phoneNumberId.trim() || !appSecret.trim())))}
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
