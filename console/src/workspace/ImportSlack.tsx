/**
 * Bringing a Slack workspace's history in, and linking its people to seats
 * (F19.23; STATUS section 2.214). Drawn in Settings › People, and from the
 * owner's Rooms page while the company has no topic room yet.
 *
 * The owner chooses the ZIP Slack's export gives them. It is sent in parts of
 * 16 MB, in order, held in the page's memory only while it is sent, and read
 * by the worker: each channel becomes a room, private ones staying private;
 * each thread a thread; each person an author of the old workspace, whom the
 * owner may link to a seat here. Direct conversations are counted and left
 * out. The report says what came in, and each thing that did not, in words.
 *
 * Linking a person is shown first: the private rooms the seat would join are
 * listed before the owner confirms, and unlinking takes back what the link
 * gave. Nothing here is kept in the browser.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Badge, Button, FileButton, Group, List, Modal, Paper, Progress, Select, Stack, Table, Text, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrandSlack, IconFileZip } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { t, tp } from '../i18n.ts';

/** What one part carries, and how many parts an export may be, as the server holds them. */
const PART_BYTES = 16 * 1024 * 1024;
const PARTS_MOST = 64;
/** How often a report is read again while the worker reads the export. */
const EVERY_MS = 2000;

interface Problem {
  code: string;
  entry?: string;
  count?: number;
  name?: string;
}

interface ImportView {
  id: string;
  status: 'receiving' | 'reading' | 'done' | 'failed';
  parts: number;
  received: number;
  counts: Record<string, number>;
  problems: Problem[];
  createdAt: string;
  finishedAt: string | null;
  partsGone: boolean;
}

interface FormerPerson {
  former: string;
  name: string;
  seat: { id: string; name: string } | null;
  linkedAt: string | null;
  rooms: number;
}

interface LinkedRoom {
  id: string;
  name: string;
  archived: boolean;
}

/** A seat the owner may link someone to: joined, and not ended. */
export interface LinkableSeat {
  id: string;
  name: string;
  joined: boolean;
}

/** A part's bytes in base64, a slice at a time so no string of arguments grows past what a call takes. */
async function base64Of(part: Blob): Promise<string> {
  const bytes = new Uint8Array(await part.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** One line of a report, in words. */
function problemSaid(problem: Problem): string {
  const entry = problem.entry ?? '';
  const count = problem.count ?? 0;
  switch (problem.code) {
    case 'unreadable': return t('{entry} could not be read: it is damaged.', { entry });
    case 'not_json': return t('{entry} is not a list PALUGADA can read.', { entry });
    case 'message_skipped':
      return tp('{entry}: {count} message had no time or author, and was left out.',
        '{entry}: {count} messages had no time or author, and were left out.', count, { entry });
    case 'unknown_folder': return t('{entry} is no channel of the export, so it was left out.', { entry });
    case 'renamed': return t('#{entry} became {name}: a room here already had its name.', { entry, name: problem.name ?? '' });
    case 'direct_skipped':
      return tp('{count} direct conversation was left out: direct messages need every person linked first, and are not imported in v1.',
        '{count} direct conversations were left out: direct messages need every person linked first, and are not imported in v1.', count);
    case 'too_large':
      return problem.entry ? t('{entry} unpacks to more than PALUGADA reads at once, so nothing was imported.', { entry })
        : t('That export unpacks to more than PALUGADA reads at once.');
    case 'not_a_zip': case 'not_slack': return t('That file is not a Slack export PALUGADA can read.');
    case 'parts_expired': return t('The export was not finished within seven days, so its parts were deleted. Upload it again.');
    case 'part_missing': return t('The parts of the export were gone before it was read. Upload it again.');
    case 'more': return tp('And {count} more.', 'And {count} more.', count);
    default: return t('Reading the export stopped. Upload it again.');
  }
}

/** What an import says of itself: how far it is, then what came in and what did not. */
function Report({ report }: { report: ImportView }) {
  const counts = report.counts;
  const said = (key: string) => counts[key] ?? 0;
  return (
    <Stack gap="xs">
      <Group gap="xs">
        <Badge variant="light" color={report.status === 'done' ? 'teal' : report.status === 'failed' ? 'red' : 'blue'}>
          {report.status === 'receiving' ? t('Uploading') : report.status === 'reading' ? t('Reading')
            : report.status === 'done' ? t('Imported') : t('The import failed')}
        </Badge>
        <Text size="xs" c="dimmed">{relative(report.finishedAt ?? report.createdAt)}</Text>
      </Group>
      {report.status === 'receiving' && (
        <>
          <Progress value={(report.received / report.parts) * 100} size="sm" radius="xl" />
          <Text size="xs" c="dimmed">{t('Part {received} of {parts}', { received: report.received, parts: report.parts })}</Text>
        </>
      )}
      {report.status === 'reading' && <Text size="sm" c="dimmed">{t('Reading the export. Rooms appear as each channel is in.')}</Text>}
      {report.status === 'done' && (
        <List size="sm" spacing={2}>
          <List.Item>{tp('{count} room made', '{count} rooms made', said('rooms'))}</List.Item>
          <List.Item>{tp('{count} message brought in', '{count} messages brought in', said('messages'))}</List.Item>
          <List.Item>{tp('{count} reaction', '{count} reactions', said('reactions'))}</List.Item>
          {said('files') > 0 && <List.Item>{tp('{count} file, as its name: the files stay in Slack', '{count} files, as their names: the files stay in Slack', said('files'))}</List.Item>}
          {said('already') > 0 && <List.Item>{tp('{count} message was here already', '{count} messages were here already', said('already'))}</List.Item>}
          {said('skipped') > 0 && <List.Item>{tp("{count} of Slack's own notices left out", "{count} of Slack's own notices left out", said('skipped'))}</List.Item>}
        </List>
      )}
      {report.problems.length > 0 && (
        <Alert color={report.status === 'failed' ? 'red' : 'yellow'} variant="light">
          <Stack gap={4}>
            {report.problems.map((problem, index) => <Text key={index} size="sm">{problemSaid(problem)}</Text>)}
          </Stack>
        </Alert>
      )}
    </Stack>
  );
}

/**
 * Choosing an export and sending it, then its report as the worker reads it;
 * and the last import's report when there is one.
 */
export function ImportSlack({ companyId, imported }: { companyId: string; imported?: () => void }) {
  const imports = useLoad<{ imports: ImportView[] }>(() => api('GET', `/api/companies/${companyId}/room-imports`), [companyId]);
  const [current, setCurrent] = useState<ImportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const shown = current ?? imports.data?.imports[0] ?? null;

  // While the worker reads it, the report is read again, until it is done or failed.
  useEffect(() => {
    if (!shown || shown.status !== 'reading') return;
    const timer = window.setTimeout(() => {
      void api('GET', `/api/companies/${companyId}/room-imports/${shown.id}`).then((answer: { import: ImportView }) => {
        setCurrent(answer.import);
        if (answer.import.status === 'done') imported?.();
      }, (failure) => setError(explain(failure)));
    }, EVERY_MS);
    return () => window.clearTimeout(timer);
  }, [companyId, shown]);

  const send = async (file: File | null) => {
    if (!file) return;
    setError(null);
    const parts = Math.max(1, Math.ceil(file.size / PART_BYTES));
    if (parts > PARTS_MOST) {
      setError(t('That file is larger than 1 GB. Export fewer channels, or a shorter time, from Slack.'));
      return;
    }
    setSending(true);
    try {
      let view: ImportView = (await api('POST', `/api/companies/${companyId}/room-imports`, { source: 'slack', parts })).import;
      setCurrent(view);
      for (let index = 0; index < parts; index += 1) {
        const base64 = await base64Of(file.slice(index * PART_BYTES, (index + 1) * PART_BYTES));
        view = (await api('POST', `/api/companies/${companyId}/room-imports/${view.id}/parts`, { index, base64 })).import;
        setCurrent(view);
      }
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <Stack gap="sm">
      <Text size="sm" c="dimmed">
        {t("In Slack, a workspace's admin exports its data (Settings & administration, then Workspace settings, then Import/Export data). Choose the ZIP that export gives you: its channels become rooms here, private ones staying private, with their threads, reactions and people. Up to 1 GB.")}
      </Text>
      <Group>
        <FileButton onChange={(file) => void send(file)} accept="application/zip,.zip" disabled={sending}>
          {(props) => <Button {...props} loading={sending} leftSection={<IconFileZip size={16} />}>{t('Choose the export')}</Button>}
        </FileButton>
      </Group>
      {error && <Alert color="red" variant="light">{error}</Alert>}
      {shown && <Report report={shown} />}
    </Stack>
  );
}

/**
 * The old workspace's people, each linked to a seat or not. A link is shown
 * before it is made: the private rooms the seat would join.
 */
export function FormerPeople({ companyId, seats }: { companyId: string; seats: readonly LinkableSeat[] }) {
  const people = useLoad<{ people: FormerPerson[] }>(() => api('GET', `/api/companies/${companyId}/former-people`), [companyId]);
  const [chosen, setChosen] = useState<Record<string, string | null>>({});
  const [asking, setAsking] = useState<{ person: FormerPerson; seat: LinkableSeat; rooms: LinkedRoom[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const failed = (failure: unknown) => notifications.show({ color: 'red', message: explain(failure) });
  const linkable = seats.filter((seat) => seat.joined);

  const ask = async (person: FormerPerson) => {
    const seat = linkable.find((one) => one.id === chosen[person.former]);
    if (!seat) return;
    try {
      const answer: { rooms: LinkedRoom[] } = await api('POST', `/api/companies/${companyId}/former-people/link`,
        { former: person.former, seatId: seat.id });
      setAsking({ person, seat, rooms: answer.rooms });
    } catch (failure) {
      failed(failure);
    }
  };
  const link = async () => {
    if (!asking) return;
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/former-people/link`,
        { former: asking.person.former, seatId: asking.seat.id, confirm: true });
      notifications.show({ color: 'teal', message: t('{name} is linked to {seat}.', { name: asking.person.name, seat: asking.seat.name }) });
      setAsking(null);
      people.reload();
    } catch (failure) {
      failed(failure);
    } finally {
      setBusy(false);
    }
  };
  const unlink = async (person: FormerPerson) => {
    try {
      const answer: { rooms: LinkedRoom[] } = await api('POST', `/api/companies/${companyId}/former-people/unlink`, { former: person.former });
      notifications.show({ color: 'teal', message: tp('{name} is unlinked, and {count} private room the link gave is taken back.',
        '{name} is unlinked, and {count} private rooms the link gave are taken back.', answer.rooms.length, { name: person.name }) });
      people.reload();
    } catch (failure) {
      failed(failure);
    }
  };

  const list = people.data?.people ?? [];
  if (list.length === 0) return null;
  return (
    <Paper withBorder radius="lg" p="lg">
      <Title order={4} mb={4}>{t('People from Slack')}</Title>
      <Text size="sm" c="dimmed" mb="md">
        {t('Link each to the seat they have here: what they said is shown under that seat\'s name, and the seat joins the private channels they were in.')}
      </Text>
      <Table.ScrollContainer minWidth={560}>
        <Table verticalSpacing="sm">
          <Table.Tbody>
            {list.map((person) => (
              <Table.Tr key={person.former}>
                <Table.Td>
                  <Text size="sm" fw={600}>{person.name}</Text>
                  {person.rooms > 0 && (
                    <Text size="xs" c="dimmed">{tp('In {count} private room', 'In {count} private rooms', person.rooms)}</Text>
                  )}
                </Table.Td>
                <Table.Td>
                  {person.seat ? (
                    <Badge variant="light" color="teal">{t('Linked to {seat}', { seat: person.seat.name })}</Badge>
                  ) : (
                    <Select size="xs" placeholder={t('Choose a seat')} data={linkable.map((seat) => ({ value: seat.id, label: seat.name }))}
                      value={chosen[person.former] ?? null} onChange={(value) => setChosen({ ...chosen, [person.former]: value })}
                      aria-label={t('The seat {name} has here', { name: person.name })} />
                  )}
                </Table.Td>
                <Table.Td ta="right">
                  {person.seat
                    ? <Button size="xs" variant="subtle" color="red" onClick={() => void unlink(person)}>{t('Unlink')}</Button>
                    : <Button size="xs" variant="light" disabled={!chosen[person.former]} onClick={() => void ask(person)}>{t('Link to the seat')}</Button>}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      <Modal opened={asking !== null} onClose={() => setAsking(null)} centered
        title={asking ? t('Link {name} to {seat}', { name: asking.person.name, seat: asking.seat.name }) : ''}>
        {asking && (
          <Stack gap="sm">
            <Text size="sm">{t('What {name} said in Slack is shown under {seat}\'s name.', { name: asking.person.name, seat: asking.seat.name })}</Text>
            {asking.rooms.length === 0 ? (
              <Text size="sm">{t('{seat} joins no private room by it.', { seat: asking.seat.name })}</Text>
            ) : (
              <>
                <Text size="sm">{tp('{seat} joins {count} private room, and can read all of it:', '{seat} joins {count} private rooms, and can read all of them:',
                  asking.rooms.length, { seat: asking.seat.name })}</Text>
                <List size="sm">{asking.rooms.map((room) => <List.Item key={room.id}>#{room.name}</List.Item>)}</List>
              </>
            )}
            <Group justify="flex-end">
              <Button variant="subtle" color="gray" onClick={() => setAsking(null)}>{t('Cancel')}</Button>
              <Button loading={busy} onClick={() => void link()}>{t('Link to the seat')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Paper>
  );
}

/** The owner's invitation on the Rooms page while the company has no topic room: bring Slack's in. */
export function SlackInvite({ companyId, imported }: { companyId: string; imported: () => void }) {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <Alert color="blue" variant="light" mx={{ base: 'xs', sm: 'md' }} mt="xs" icon={<IconBrandSlack size={18} />}>
        <Group justify="space-between" gap="xs">
          <Text size="sm">{t('Moving from Slack? Bring its channels, threads and people in.')}</Text>
          <Button size="xs" variant="light" onClick={() => setOpened(true)}>{t('Import from Slack')}</Button>
        </Group>
      </Alert>
      <Modal opened={opened} onClose={() => setOpened(false)} title={t('Import from Slack')} centered size="lg">
        <ImportSlack companyId={companyId} imported={imported} />
      </Modal>
    </>
  );
}
