/**
 * The owner's conversations: with PALUGADA's assistant about the whole
 * deployment, and with each company's CEO about that company (0068). Say
 * what you want, and it reads what is there and puts cards in front of you.
 * A card changes nothing until you apply it -- with your authenticator where
 * the change takes it -- and a key goes into the sealed field on the card,
 * never into the conversation.
 */
import {
  ActionIcon, Alert, Anchor, Avatar, Badge, Button, Code, Drawer, Group, Loader, Paper, PasswordInput, ScrollArea, Stack, Text, Textarea, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowUp, IconCheck, IconKey, IconMicrophone, IconPlayerStopFilled, IconRefresh, IconSparkles, IconVolume, IconVolumeOff, IconX,
} from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { N, t } from '../i18n.ts';
import { go } from '../router.ts';
import { play, recordingSupported, useRecorder } from '../recorder.ts';
import { rolePicture } from '../images.ts';
import type { Company, RolePersona } from '../types.ts';

/** Whether applying a card takes the owner's device: always, only when its route says so, or never. */
type Factor = 'always' | 'sometimes' | 'never';

interface Proposal {
  id: string;
  summary: string;
  path: string;
  body: Record<string, unknown>;
  secrets: Record<string, string>;
  factor: Factor;
  status: 'open' | 'applied' | 'dismissed' | 'failed';
  outcome: string | null;
}

interface Message {
  id: string;
  role: 'owner' | 'assistant' | 'event';
  channel: 'console' | 'telegram';
  body: string;
  at: string;
  proposals: Proposal[];
}

/** A company's CEO, who answers in that company's conversation. */
interface Ceo {
  roleId: string;
  slug: string;
  displayName: string | null;
  title: string | null;
  persona: RolePersona | null;
}

interface Conversation {
  available: boolean;
  /** Whether a provider is chosen to hear the owner, and one to answer aloud. */
  voice: { listen: boolean; speak: boolean };
  messages: Message[];
  /** In a company's conversation, its CEO; null while it has none. */
  ceo?: Ceo | null;
}

const EXAMPLES = [
  N('What is left to set up?'),
  N('Use Claude for every role, and search the web with Brave.'),
  N('Start a company that sells coffee online, and let it run itself.'),
  N('What is waiting for me in the inbox?'),
];

/** What an owner asks the one who runs their company. */
const CEO_EXAMPLES = [
  N('How is the company doing this week?'),
  N('What is the team working on right now?'),
  N('Plan this month\'s promotion and hand it to the team.'),
  N('Who should we hire next, and why?'),
];

/** The labels the server gives a card's sealed fields, here so that they are translated. */
const SECRET_LABELS = [
  N('API key'), N('API key (left empty, the saved one)'), N('Access token, if the server needs one'),
  N('Incoming webhook address'), N('The server\'s token, if it needs one'),
];
void SECRET_LABELS;

export function Assistant({ opened, onClose, company = null }: { opened: boolean; onClose: () => void; company?: Company | null }) {
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [text, setText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [aloud, setAloud] = useState(false);
  const [hearing, setHearing] = useState(false);
  const recorder = useRecorder();
  const bottom = useRef<HTMLDivElement>(null);
  const voice = conversation?.voice ?? { listen: false, speak: false };

  const companyId = company?.id ?? null;
  const ceo = conversation?.ceo ?? null;
  const ceoName = ceo ? ceo.displayName ?? ceo.slug : null;

  const load = async () => {
    try {
      setConversation(companyId
        ? await api('GET', `/api/companies/${companyId}/conversation`)
        : await api('GET', '/api/assistant'));
      setProblem(null);
    } catch (failure) {
      setProblem(explain(failure));
    }
  };

  useEffect(() => {
    if (opened) void load();
    else setConversation(null);
  }, [opened, companyId]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [conversation, thinking]);

  const send = async (said: string) => {
    const words = said.trim();
    if (!words || thinking) return;
    setThinking(true);
    setText('');
    // The owner's words at once, as a chat shows them; the server's copy replaces it.
    setConversation((now) => now && {
      ...now,
      messages: [...now.messages, { id: 'pending', role: 'owner', channel: 'console', body: words, at: new Date().toISOString(), proposals: [] }],
    });
    try {
      const answer: { messages: Message[] } = companyId
        ? await api('POST', `/api/companies/${companyId}/conversation/messages`, { text: words })
        : await api('POST', '/api/assistant/messages', { text: words });
      await load();
      const reply = answer.messages.at(-1);
      if (aloud && voice.speak && reply?.role === 'assistant') void speakOut(reply.body);
    } catch (failure) {
      setProblem(explain(failure));
      setText(words);
      await load();
    } finally {
      setThinking(false);
    }
  };

  /** An answer said aloud; failing to, it is still on the page. */
  const speakOut = async (words: string) => {
    try {
      const spoken: { dataUrl: string } = await api('POST', '/api/assistant/speak', { text: words });
      play(spoken.dataUrl);
    } catch (failure) {
      setProblem(explain(failure));
    }
  };

  /** Tap to speak, tap again to send what was said. */
  const talk = async () => {
    if (!recorder.recording) {
      try {
        await recorder.start();
      } catch {
        setProblem(t('The microphone could not be used. Allow it for this page in the browser, and try again.'));
      }
      return;
    }
    const clip = await recorder.stop();
    if (!clip) return;
    setHearing(true);
    try {
      const heard: { text: string } = await api('POST', '/api/assistant/listen', { audio: clip.audio, mime: clip.mime });
      if (heard.text.trim()) await send(heard.text);
      else setProblem(t('Nothing was heard in that recording.'));
    } catch (failure) {
      setProblem(explain(failure));
    } finally {
      setHearing(false);
    }
  };

  const clear = async () => {
    if (companyId) await api('POST', `/api/companies/${companyId}/conversation/clear`, {});
    else await api('POST', '/api/assistant/clear', {});
    await load();
  };

  const title = company
    ? (
      <Group gap={10} wrap="nowrap">
        <Avatar size={36} radius="xl" src={ceo ? rolePicture(ceo.slug, ceo.title) : undefined} alt="" />
        <div style={{ minWidth: 0 }}>
          <Text fw={700} truncate>{ceoName ?? t('No CEO yet')}</Text>
          <Text size="xs" c="dimmed" truncate>{t('CEO of {company}', { company: company.name })}</Text>
        </div>
      </Group>
    )
    : <Group gap={8}><IconSparkles size={20} /><Text fw={700}>{t('Ask PALUGADA')}</Text></Group>;
  const examples = company ? CEO_EXAMPLES : EXAMPLES;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="lg"
      title={title}
      styles={{ body: { display: 'flex', flexDirection: 'column', height: 'calc(100% - 60px)' } }}
    >
      {conversation && !conversation.available && (
        <Alert color="yellow" variant="light" mb="sm" title={t('Choose a model first')}>
          <Text size="sm">
            {ceoName
              ? t('{name} thinks with this deployment\'s own model, and none is set up yet.', { name: ceoName })
              : t('The assistant thinks with this deployment\'s own model, and none is set up yet.')}
          </Text>
          <Button size="compact-sm" mt="xs" variant="light" onClick={() => { onClose(); go({ kind: 'deployment', section: 'model' }); }}>
            {t('Choose a model')}
          </Button>
        </Alert>
      )}
      <ScrollArea style={{ flex: 1 }} offsetScrollbars>
        <Stack gap="sm" pb="sm">
          {company && conversation && !ceo && (
            <Alert color="yellow" variant="light" title={t('This company has no CEO yet')}>
              <Text size="sm">{t('The CEO is who you talk to about a company. Hire its first role on Team; it becomes the CEO.')}</Text>
            </Alert>
          )}
          {conversation?.messages.length === 0 && (!company || ceo) && (
            <Paper withBorder radius="lg" p="md">
              <Text size="sm">
                {company
                  ? t('I am {name}, the CEO of {company}. Tell me what you want the company to do, or ask how it is going. I hand the work to the team, and put what needs your say in front of you as cards: nothing changes until you apply one.', { name: ceoName ?? '', company: company.name })
                  : t('Tell me what you want, in your own words. I look at what is there and put the changes in front of you as cards; nothing changes until you apply one, and keys go in the sealed field on the card, never here.')}
              </Text>
              <Stack gap={6} mt="sm">
                {examples.map((example) => (
                  <Button key={example} variant="light" size="compact-sm" justify="flex-start" onClick={() => void send(t(example))} disabled={thinking}>
                    {t(example)}
                  </Button>
                ))}
              </Stack>
            </Paper>
          )}
          {conversation?.messages.map((message) => (
            <Line key={message.id} message={message} reload={load} speaker={company && ceo ? { name: ceoName!, picture: rolePicture(ceo.slug, ceo.title) } : null} />
          ))}
          {hearing && <Group gap="xs"><Loader size="xs" type="dots" /><Text size="sm" c="dimmed">{t('Listening…')}</Text></Group>}
          {thinking && <Group gap="xs"><Loader size="xs" type="dots" /><Text size="sm" c="dimmed">{t('Looking…')}</Text></Group>}
          <div ref={bottom} />
        </Stack>
      </ScrollArea>
      {problem && <Alert color="red" variant="light" mb="xs" withCloseButton onClose={() => setProblem(null)}>{problem}</Alert>}
      <Group align="flex-end" gap="xs" wrap="nowrap">
        <Textarea
          style={{ flex: 1 }}
          autosize
          minRows={1}
          maxRows={6}
          placeholder={ceoName ? t('Tell {name} what you want…', { name: ceoName }) : t('Say what you want…')}
          disabled={Boolean(company) && conversation !== null && !ceo}
          value={text}
          onChange={(event) => setText(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send(text);
            }
          }}
        />
        {recordingSupported() && (
          <Tooltip label={voice.listen
            ? (recorder.recording ? t('Stop, and send what you said') : t('Speak'))
            : t('Choose what hears you under This deployment, Tools, Listening')}>
            <ActionIcon
              size="lg"
              radius="xl"
              variant={recorder.recording ? 'filled' : 'light'}
              color={recorder.recording ? 'red' : undefined}
              onClick={() => void talk()}
              disabled={!voice.listen || thinking || hearing}
              aria-label={recorder.recording ? t('Stop, and send what you said') : t('Speak')}
            >
              {recorder.recording ? <IconPlayerStopFilled size={16} /> : <IconMicrophone size={18} />}
            </ActionIcon>
          </Tooltip>
        )}
        <ActionIcon size="lg" radius="xl" onClick={() => void send(text)} disabled={!text.trim() || thinking} aria-label={t('Send')}>
          <IconArrowUp size={18} />
        </ActionIcon>
        {voice.speak && (
          <Tooltip label={aloud ? t('Stop reading answers aloud') : t('Read answers aloud')}>
            <ActionIcon size="lg" variant={aloud ? 'light' : 'subtle'} color={aloud ? undefined : 'gray'} onClick={() => setAloud((now) => !now)}
              aria-label={aloud ? t('Stop reading answers aloud') : t('Read answers aloud')}>
              {aloud ? <IconVolume size={18} /> : <IconVolumeOff size={18} />}
            </ActionIcon>
          </Tooltip>
        )}
        <Tooltip label={t('Start again')}>
          <ActionIcon size="lg" variant="subtle" color="gray" onClick={() => void clear()} aria-label={t('Start again')}>
            <IconRefresh size={18} />
          </ActionIcon>
        </Tooltip>
      </Group>
    </Drawer>
  );
}

function Line({ message, reload, speaker }: {
  message: Message;
  reload: () => Promise<void>;
  /** Who answers, in a company's conversation: its CEO, drawn beside what it says. */
  speaker: { name: string; picture: string } | null;
}) {
  if (message.role === 'event') {
    return <Text size="xs" c="dimmed" ta="center">{message.body}</Text>;
  }
  const mine = message.role === 'owner';
  return (
    <Stack gap={6} align={mine ? 'flex-end' : 'flex-start'}>
      {!mine && speaker && (
        <Group gap={6}>
          <Avatar size={20} radius="xl" src={speaker.picture} alt="" />
          <Text size="xs" fw={600} c="dimmed">{speaker.name}</Text>
        </Group>
      )}
      <Paper
        radius="lg"
        px="md"
        py="xs"
        maw="88%"
        bg={mine ? 'var(--mantine-primary-color-light)' : 'var(--mantine-color-default)'}
        withBorder={!mine}
      >
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{message.body}</Text>
        {message.channel === 'telegram' && <Text size="xs" c="dimmed" mt={2}>{t('via Telegram')}</Text>}
      </Paper>
      {message.proposals.map((proposal) => <Card key={proposal.id} proposal={proposal} reload={reload} />)}
    </Stack>
  );
}

function Card({ proposal, reload }: { proposal: Proposal; reload: () => Promise<void> }) {
  const requireFactor = useFactor();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const open = proposal.status === 'open';
  const fields = Object.entries(proposal.body);
  // What the owner reads on the card: the fields in words, not the ids the route needs.
  const said = fields.filter(([, value]) => !(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)));
  const [detailed, setDetailed] = useState(false);

  const apply = async () => {
    setBusy(true);
    const payload = { secrets: typed };
    try {
      // A change that takes the device asks for it first; one that may take it
      // is tried, and asked for it when the route says so.
      if (proposal.factor === 'always') {
        const done = await requireFactor(proposal.summary, (proof) =>
          api('POST', `/api/assistant/proposals/${proposal.id}/apply`, { ...payload, proof }));
        if (!done) return;
      } else {
        try {
          await api('POST', `/api/assistant/proposals/${proposal.id}/apply`, payload);
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.code === 'approval.channel_forbidden')) throw failure;
          const done = await requireFactor(proposal.summary, (proof) =>
            api('POST', `/api/assistant/proposals/${proposal.id}/apply`, { ...payload, proof }));
          if (!done) return;
        }
      }
      notifications.show({ color: 'teal', message: t('Done: {what}', { what: proposal.summary }) });
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
      await reload();
    }
  };

  const dismiss = async () => {
    await api('POST', `/api/assistant/proposals/${proposal.id}/dismiss`, {});
    await reload();
  };

  return (
    <Paper withBorder radius="md" p="sm" w="88%" style={open ? undefined : { opacity: 0.7 }}>
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Text size="sm" fw={600}>{proposal.summary}</Text>
          {!open && (
            <Badge size="sm" variant="light" color={proposal.status === 'applied' ? 'teal' : proposal.status === 'failed' ? 'red' : 'gray'}>
              {proposal.status === 'applied' ? t('applied') : proposal.status === 'failed' ? t('failed') : t('dismissed')}
            </Badge>
          )}
        </Group>
        {said.length > 0 && (
          <Stack gap={0}>
            {said.map(([name, value]) => (
              <Text key={name} size="xs" c="dimmed"><b>{name}</b>: {typeof value === 'string' ? value : JSON.stringify(value)}</Text>
            ))}
          </Stack>
        )}
        {/* Exactly what pressing it sends, for anyone who wants to check: the route and every field, ids included. */}
        <Anchor component="button" type="button" size="xs" c="dimmed" ta="left" onClick={() => setDetailed((now) => !now)}>
          {detailed ? t('Hide what it sends') : t('Show what it sends')}
        </Anchor>
        {detailed && (
          <Stack gap={2}>
            <Code>{`POST ${proposal.path}`}</Code>
            {fields.map(([name, value]) => (
              <Text key={name} size="xs" c="dimmed" ff="monospace"><b>{name}</b>: {typeof value === 'string' ? value : JSON.stringify(value)}</Text>
            ))}
          </Stack>
        )}
        {open && Object.entries(proposal.secrets).map(([name, label]) => (
          <PasswordInput
            key={name}
            size="xs"
            label={t(label)}
            description={t('Sealed where it is sent; the assistant never sees it.')}
            leftSection={<IconKey size={14} />}
            value={typed[name] ?? ''}
            onChange={(event) => { const value = event.currentTarget.value; setTyped((all) => ({ ...all, [name]: value })); }}
            autoComplete="off"
          />
        ))}
        {!open && proposal.outcome && proposal.status === 'failed' && <Text size="xs" c="red">{proposal.outcome}</Text>}
        {open && (
          <Group justify="flex-end" gap="xs">
            <Button size="compact-sm" variant="subtle" color="gray" leftSection={<IconX size={14} />} onClick={() => void dismiss()} disabled={busy}>{t('Dismiss')}</Button>
            <Button size="compact-sm" leftSection={<IconCheck size={14} />} loading={busy} onClick={() => void apply()}>
              {proposal.factor === 'always' ? t('Apply with a code') : t('Apply')}
            </Button>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
