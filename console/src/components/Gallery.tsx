/**
 * Everything the company produced for a person to read, newest first: every
 * document and email its tasks committed (the analysis of 3 October, §9 P1
 * item 12). It was reachable only by opening the task that made it.
 */
import { useState } from 'react';
import {
  Avatar, Button, CopyButton, Group, Modal, Paper, ScrollArea, SimpleGrid, Stack, Text, ThemeIcon, UnstyledButton,
} from '@mantine/core';
import { IconCopy, IconFileText, IconMail } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { rolePicture } from '../images.ts';
import { t } from '../i18n.ts';
import type { GalleryItem, TaskDetail } from '../types.ts';
import { EmptyState, LoadFailed, Loading } from './ui.tsx';
import { Prose } from './Prose.tsx';

export function Gallery({ companyId, openTask }: { companyId: string; openTask: (id: string) => void }) {
  const [older, setOlder] = useState<{ items: GalleryItem[]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [reading, setReading] = useState<GalleryItem | null>(null);
  const first = useLoad(async (): Promise<{ items: GalleryItem[]; next: string | null }> =>
    api('GET', `/api/companies/${companyId}/gallery`), [companyId], { every: 30_000 });

  if (first.error && !first.data) return <LoadFailed message={first.error} retry={first.reload} />;
  if (!first.data) return <Loading rows={3} />;
  const items = [...first.data.items, ...(older?.items ?? [])];
  const next = older ? older.next : first.data.next;

  const loadOlder = async () => {
    if (!next) return;
    setBusy(true);
    try {
      const page: { items: GalleryItem[]; next: string | null } =
        await api('GET', `/api/companies/${companyId}/gallery?before=${encodeURIComponent(next)}`);
      setOlder({ items: [...(older?.items ?? []), ...page.items], next: page.next });
    } catch (failure) {
      setFailed(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  if (items.length === 0) {
    return <EmptyState title={t('Nothing yet. What the task produces appears here when it has something.')} />;
  }
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        {items.map((item) => (
          <UnstyledButton key={`${item.taskId}:${item.step}`} onClick={() => setReading(item)} style={{ display: 'flex' }}>
            <Paper withBorder radius="md" p="md" className="clickable-row" style={{ flex: 1, minWidth: 0 }}>
              <Stack gap={8}>
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <ThemeIcon variant="light" radius="md" style={{ flexShrink: 0 }}>
                    {item.to ? <IconMail size={16} /> : <IconFileText size={16} />}
                  </ThemeIcon>
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" fw={600} lineClamp={2}>{item.title}</Text>
                    <Text size="xs" c="dimmed" lineClamp={1}>
                      {item.to ? t('Email to {to}', { to: item.to }) : item.path}
                      {item.words !== null ? ` · ${t('{words} words', { words: item.words })}` : ''}
                    </Text>
                  </div>
                </Group>
                {item.excerpt && <Text size="sm" c="dimmed" lineClamp={3}>{item.excerpt}</Text>}
                <Group gap={6} wrap="nowrap">
                  <Avatar size={20} radius="xl" src={rolePicture(item.roleSlug)} alt="" />
                  <Text size="xs" c="dimmed" lineClamp={1}>{item.roleName ?? item.roleSlug} · {relative(item.at)}</Text>
                </Group>
              </Stack>
            </Paper>
          </UnstyledButton>
        ))}
      </SimpleGrid>
      {failed && <Text size="sm" c="red">{failed}</Text>}
      {next && (
        <Group justify="center">
          <Button variant="subtle" loading={busy} onClick={() => void loadOlder()}>{t('Show older')}</Button>
        </Group>
      )}
      <Reading companyId={companyId} item={reading} close={() => setReading(null)} openTask={openTask} />
    </Stack>
  );
}

/** The whole of one piece, read from its task, and the way to that task. */
function Reading({ companyId, item, close, openTask }: {
  companyId: string; item: GalleryItem | null; close: () => void; openTask: (id: string) => void;
}) {
  const detail = useLoad(async (): Promise<TaskDetail | null> => (item
    ? ((await api('GET', `/api/companies/${companyId}/tasks/${item.taskId}`)) as { task: TaskDetail }).task
    : null), [companyId, item?.taskId]);
  const whole = item ? detail.data?.deliverables.find((one) => one.step === item.step) ?? null : null;
  return (
    <Modal opened={item !== null} onClose={close} size="xl" title={<Text fw={700}>{item?.title}</Text>}>
      {item && (
        <Stack>
          <Text size="sm" c="dimmed">{item.task}</Text>
          {item.to && <Text size="sm" c="dimmed">{t('To: {to}', { to: item.to })}</Text>}
          {detail.error ? <LoadFailed message={detail.error} retry={detail.reload} /> : !whole ? <Loading rows={2} /> : (
            <ScrollArea.Autosize mah="60vh">
              <Prose text={whole.text} />
            </ScrollArea.Autosize>
          )}
          <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={() => { close(); openTask(item.taskId); }}>{t('Open the task')}</Button>
            {whole && (
              <CopyButton value={whole.text}>
                {({ copied, copy }) => (
                  <Button variant="light" color={copied ? 'teal' : undefined} leftSection={<IconCopy size={14} />} onClick={copy}>
                    {copied ? t('Copied') : t('Copy the text')}
                  </Button>
                )}
              </CopyButton>
            )}
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
