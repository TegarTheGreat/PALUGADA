/**
 * The company's documents (0075): a price list, a contract, the brand guide.
 * Kept whole and found by passage: every role that can search what the
 * company knows finds the paragraphs its question points at, and every run
 * is told which documents exist.
 *
 * A file is read here, in the browser, and its text is sent; nothing is kept
 * in the browser, and the server never parses a file. Text and Markdown are
 * read as they are, a Word document by docx.ts and a PDF by pdf.ts, each
 * loaded only when one is chosen; for anything else, paste the text.
 */
import { useState } from 'react';
import {
  Badge, Button, Code, Drawer, FileButton, Group, Modal, Paper, ScrollArea, Select, Stack, Text, Textarea, TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArchive, IconArchiveOff, IconFileText, IconPlus, IconUpload } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Structure } from '../types.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton } from './ActionForm.tsx';
import { EmptyState, LoadFailed, Loading } from './ui.tsx';

interface DocumentSummary {
  id: string;
  title: string;
  divisionId: string | null;
  divisionName: string | null;
  fileName: string | null;
  characters: number;
  passages: number;
  createdAt: string;
  archivedAt: string | null;
}

export function Documents({ companyId, structure }: { companyId: string; structure: Structure | null }) {
  const list = useLoad(async (): Promise<DocumentSummary[]> =>
    (await api('GET', `/api/companies/${companyId}/documents`) as { documents: DocumentSummary[] }).documents, [companyId]);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  if (list.error) return <LoadFailed message={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap">
        <Text size="sm" c="dimmed" maw={640}>
          {t('Documents the company keeps. Runs are told which exist and find the passages their question points at when they search what the company knows.')}
        </Text>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>{t('Add a document')}</Button>
      </Group>
      {list.data.length === 0 ? (
        <Paper withBorder radius="md">
          <EmptyState title={t('No documents yet')} description={t('A price list, a contract or the brand guide: anything longer than a fact.')} />
        </Paper>
      ) : list.data.map((document) => (
        <Paper key={document.id} withBorder radius="md" p="md" className="company-card" style={{ cursor: 'pointer', opacity: document.archivedAt ? 0.65 : 1 }}
          onClick={() => setOpen(document.id)}>
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
              <IconFileText size={20} style={{ flexShrink: 0, marginTop: 2 }} />
              <div style={{ minWidth: 0 }}>
                <Text fw={600} size="sm">{document.title}</Text>
                <Text size="xs" c="dimmed">
                  {t('Passages: {passages} · characters: {characters} · added {when}', {
                    passages: document.passages, characters: document.characters.toLocaleString(), when: relative(document.createdAt),
                  })}
                </Text>
              </div>
            </Group>
            <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
              <Badge variant="outline" color="gray">{document.divisionName ?? t('This company')}</Badge>
              {document.archivedAt && <Badge variant="light" color="gray">{t('Archived')}</Badge>}
            </Group>
          </Group>
        </Paper>
      ))}

      <AddDocument companyId={companyId} structure={structure} opened={adding} close={() => setAdding(false)} done={() => { setAdding(false); list.reload(); }} />
      {open && <DocumentDrawer companyId={companyId} documentId={open} close={() => setOpen(null)} changed={list.reload} />}
    </Stack>
  );
}

/** What the file button offers: Word, PDF, text and Markdown. */
const ACCEPTED = '.docx,.pdf,.txt,.md,.markdown,.csv,text/plain,text/markdown,text/csv,application/pdf,'
  + 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A larger file is not a document to read in a browser tab; the text limit is a million characters anyway. */
const FILE_MAX_BYTES = 30 * 1024 * 1024;

/** The text of a chosen file: as it is, or read out of a Word document or a PDF. */
async function textOfFile(file: File): Promise<string> {
  if (file.size > FILE_MAX_BYTES) throw new Error(t('That file is over 30 MB. Split it, or paste the part the company needs.'));
  const name = file.name.toLowerCase();
  if (name.endsWith('.docx')) {
    const { DocxUnreadable, textOfDocx } = await import('../docx.ts');
    try {
      return await textOfDocx(new Uint8Array(await file.arrayBuffer()));
    } catch (failure) {
      if (!(failure instanceof DocxUnreadable)) throw failure;
      throw new Error(failure.reason === 'packing'
        ? t('This Word document is packed in a way the console cannot read. Save it again, or paste its text.')
        : t('That file is not a Word document (.docx).'));
    }
  }
  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    return (await import('../pdf.ts')).textOfPdf(new Uint8Array(await file.arrayBuffer()));
  }
  if (name.endsWith('.doc')) throw new Error(t('An old Word file (.doc): save it as .docx in Word, or paste its text.'));
  return file.text();
}

function AddDocument({ companyId, structure, opened, close, done }: {
  companyId: string; structure: Structure | null; opened: boolean; close: () => void; done: () => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [division, setDivision] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const read = async (file: File | null) => {
    if (!file) return;
    setReading(true);
    try {
      setText(await textOfFile(file));
      setFileName(file.name);
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    } catch (failure) {
      notifications.show({ color: 'red', message: (failure as Error).message });
    } finally {
      setReading(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      const answer: { passages: number } = await api('POST', `/api/companies/${companyId}/documents`, {
        title, text, ...(division ? { divisionId: division } : {}), ...(fileName ? { fileName } : {}),
      });
      notifications.show({ color: 'teal', message: t('Added. Passages: {count}', { count: answer.passages }) });
      setTitle(''); setText(''); setFileName(null); setDivision(null);
      done();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={opened} onClose={close} title={t('Add a document')} centered size="lg">
      <Stack gap="sm">
        <Group gap="sm">
          <FileButton onChange={(file) => void read(file)} accept={ACCEPTED}>
            {(props) => <Button {...props} variant="default" loading={reading} leftSection={<IconUpload size={16} />}>{t('Read a file')}</Button>}
          </FileButton>
          {fileName ? <Text size="sm" c="dimmed">{fileName}</Text> : <Text size="xs" c="dimmed">{t('Word (.docx), PDF, text or Markdown')}</Text>}
        </Group>
        <TextInput label={t('Document title')} required value={title} onChange={(event) => setTitle(event.currentTarget.value)} />
        <Select label={t('Who may read it')} placeholder={t('The whole company')} clearable value={division} onChange={setDivision}
          data={(structure?.divisions ?? []).map((one) => ({ value: one.id, label: one.name }))} />
        <Textarea label={t('Text')} required autosize minRows={6} maxRows={16} value={text}
          description={t('Or paste it. Headings (# Payment) keep each passage with what it is about.')}
          onChange={(event) => setText(event.currentTarget.value)} />
        <Group justify="flex-end">
          <Button loading={busy} disabled={!title.trim() || !text.trim()} onClick={() => void save()}>{t('Add it')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}

function DocumentDrawer({ companyId, documentId, close, changed }: {
  companyId: string; documentId: string; close: () => void; changed: () => void;
}) {
  const document = useLoad(async (): Promise<DocumentSummary & { body: string }> =>
    api('GET', `/api/companies/${companyId}/documents/${documentId}`), [companyId, documentId]);
  const reload = () => { document.reload(); changed(); };
  const data = document.data;
  return (
    <Drawer opened onClose={close} position="right" size="xl" title={<Text fw={700}>{data?.title ?? ''}</Text>}>
      {document.error ? <LoadFailed message={document.error} retry={document.reload} /> : !data ? <Loading /> : (
        <Stack gap="md">
          <Group gap="xs">
            <Badge variant="outline" color="gray">{data.divisionName ?? t('This company')}</Badge>
            <Badge variant="light" color="gray">{t('Passages: {count}', { count: data.passages })}</Badge>
            {data.archivedAt && <Badge variant="light" color="gray">{t('Archived')}</Badge>}
          </Group>
          <Group gap="xs">
            {data.archivedAt ? (
              <ActionButton size="xs" variant="light" label={t('Put it back')} leftSection={<IconArchiveOff size={14} />}
                run={() => api('POST', `/api/companies/${companyId}/documents/${documentId}/archive`, { archived: false })} done={reload} />
            ) : (
              <ActionButton size="xs" variant="light" color="gray" label={t('Archive')} leftSection={<IconArchive size={14} />}
                run={() => api('POST', `/api/companies/${companyId}/documents/${documentId}/archive`, { archived: true })} done={reload} />
            )}
          </Group>
          <Text size="xs" c="dimmed">{t('Archived documents leave every search. Their text is kept.')}</Text>
          <ScrollArea.Autosize mah="70vh">
            <Code block style={{ whiteSpace: 'pre-wrap' }}>{data.body}</Code>
          </ScrollArea.Autosize>
        </Stack>
      )}
    </Drawer>
  );
}
