/**
 * The company's files, a folder at a time: what the owner hands it, and what
 * its roles made.
 *
 * The owner puts a file in (a contract, a price list, a photo) and it is kept
 * as it is, in the folder of uploads, under a plain name; takes any file out,
 * and removes what they put in. What a role drafted, made or computed is
 * listed and can be taken, never removed from here. Nothing is kept in the
 * browser, and a file is never opened in it: it is saved, or it is not.
 */
import { useRef, useState } from 'react';
import { Anchor, Breadcrumbs, Button, CopyButton, FileButton, Group, Paper, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconDownload, IconFile, IconFolder, IconUpload } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { saveCompanyFile } from '../files.ts';
import { useLoad } from '../hooks.ts';
import { fileSize, relative } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton } from './ActionForm.tsx';
import { EmptyState, LoadFailed, Loading } from './ui.tsx';

interface Entry { name: string; kind: 'file' | 'directory' | 'other'; bytes: number; modifiedAt: string }
type Listing = { available: false } | { available: true; path: string; entries: Entry[]; truncated: boolean };

/** What the page sends in one file: the API's own ceiling (10 MB), checked before the file is read. */
const UPLOAD_MAX_MB = 10;
/** The folder of what the owner hands over: the only one a file is removed from here. */
const UPLOADS = 'uploads';

export function Files({ companyId, owner }: { companyId: string; owner: boolean }) {
  const [path, setPath] = useState('.');
  const [kept, setKept] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The button keeps the file it was given until it is told to forget it, and a browser says nothing when the same one is chosen again.
  const forget = useRef<() => void>(null);
  const list = useLoad(async (): Promise<Listing> =>
    await api('GET', `/api/companies/${companyId}/files?path=${encodeURIComponent(path)}`) as Listing, [companyId, path]);

  if (list.error) return <LoadFailed message={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  if (!list.data.available) {
    return (
      <Paper withBorder radius="md">
        <EmptyState title={t('No files here')}
          description={t('This deployment keeps no files. Whoever runs it sets PALUGADA_FILES_ROOT; the Compose install sets one.')} />
      </Paper>
    );
  }
  const here = list.data.path === '.' ? [] : list.data.path.split('/');
  const join = (name: string) => (list.data && list.data.available && list.data.path !== '.' ? `${list.data.path}/${name}` : name);

  const upload = async (file: File | null) => {
    forget.current?.();
    if (!file) return;
    if (file.size > UPLOAD_MAX_MB * 1_048_576) {
      notifications.show({ color: 'red', message: t('That file is {size} MB; at most {max} MB can be uploaded.', { size: (file.size / 1_048_576).toFixed(1), max: UPLOAD_MAX_MB }) });
      return;
    }
    setBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
        reader.readAsDataURL(file);
      });
      const saved = await api('POST', `/api/companies/${companyId}/files`, { name: file.name, data }) as { path: string };
      setKept(saved.path);
      setPath(UPLOADS);
      list.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" align="flex-start">
        <Text size="sm" c="dimmed" maw={640}>
          {t('What you upload is kept in the folder uploads. A role that may read files can read it; what the company makes is kept in the other folders.')}
        </Text>
        {owner && (
          <FileButton resetRef={forget} onChange={(file) => void upload(file)}>
            {(props) => <Button {...props} leftSection={<IconUpload size={16} />} loading={busy}>{t('Upload a file')}</Button>}
          </FileButton>
        )}
      </Group>

      {kept && (
        <Group gap="xs" wrap="wrap">
          <Text size="sm" style={{ overflowWrap: 'anywhere' }}>{kept}</Text>
          <CopyButton value={kept}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="light" leftSection={copied ? <IconCheck size={12} /> : <IconCopy size={12} />} onClick={copy}>
                {copied ? t('Copied') : t('Copy as text')}
              </Button>
            )}
          </CopyButton>
        </Group>
      )}

      {here.length > 0 && (
        <Breadcrumbs>
          <Anchor component="button" type="button" size="sm" onClick={() => setPath('.')}>{t('Files')}</Anchor>
          {here.map((part, at) => (
            <Anchor key={`${at}-${part}`} component="button" type="button" size="sm" style={{ overflowWrap: 'anywhere' }}
              onClick={() => setPath(here.slice(0, at + 1).join('/'))}>{part}</Anchor>
          ))}
        </Breadcrumbs>
      )}

      {list.data.entries.length === 0 ? (
        <Paper withBorder radius="md"><EmptyState title={t('This folder is empty.')} description="" /></Paper>
      ) : list.data.entries.map((entry) => (
        <Paper key={entry.name} withBorder radius="md" p="sm">
          <Group justify="space-between" wrap="wrap" align="center" gap="xs">
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              {entry.kind === 'directory' ? <IconFolder size={18} style={{ flexShrink: 0 }} /> : <IconFile size={18} style={{ flexShrink: 0 }} />}
              <div style={{ minWidth: 0 }}>
                {entry.kind === 'directory'
                  ? <Anchor component="button" type="button" size="sm" fw={600} style={{ overflowWrap: 'anywhere', textAlign: 'left' }} onClick={() => setPath(join(entry.name))}>{entry.name}</Anchor>
                  : <Text size="sm" fw={600} style={{ overflowWrap: 'anywhere' }}>{entry.name}</Text>}
                {entry.kind === 'file' && <Text size="xs" c="dimmed">{fileSize(entry.bytes)} · {relative(entry.modifiedAt)}</Text>}
              </div>
            </Group>
            {owner && entry.kind === 'file' && (
              <Group gap={6} wrap="nowrap">
                <ActionButton size="xs" variant="light" label={t('Download')} leftSection={<IconDownload size={14} />}
                  run={() => saveCompanyFile(companyId, join(entry.name))} />
                {list.data && list.data.available && list.data.path === UPLOADS && (
                  <ActionButton size="xs" variant="light" color="gray" label={t('Remove')}
                    run={() => api('POST', `/api/companies/${companyId}/files/delete`, { path: join(entry.name) })} done={list.reload} />
                )}
              </Group>
            )}
          </Group>
        </Paper>
      ))}
      {list.data.truncated && <Text size="xs" c="dimmed">{t('Only the first 500 are shown.')}</Text>}
    </Stack>
  );
}
