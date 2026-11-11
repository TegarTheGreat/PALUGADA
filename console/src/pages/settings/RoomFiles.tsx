/**
 * How much the company's room files may take (F19.4; STATUS 2.217): what
 * they take now, and the limit the owner sets, ten gigabytes until they do.
 * A post that would pass it keeps nothing and says so; files already kept
 * stay when the limit is lowered.
 */
import { Button, Group, NumberInput, Progress, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { api, explain } from '../../api.ts';
import { useLoad } from '../../hooks.ts';
import { t } from '../../i18n.ts';
import { LoadFailed, Loading, Section } from '../../components/ui.tsx';

interface Limit {
  usedBytes: number;
  megabytes: number;
}

const MEGABYTE = 1024 * 1024;

export function RoomFilesLimit({ companyId }: { companyId: string }) {
  const view = useLoad(async (): Promise<Limit> => api('GET', `/api/companies/${companyId}/room-files/limit`), [companyId]);
  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading />;
  return (
    <Section title={t('Room files')} description={t('How much the files people attach in the rooms may take. A message whose files would go past it is refused, and says so.')}>
      <LimitForm companyId={companyId} limit={view.data} saved={view.reload} />
    </Section>
  );
}

function LimitForm({ companyId, limit, saved }: { companyId: string; limit: Limit; saved: () => void }) {
  const [value, setValue] = useState<string | number>(limit.megabytes);
  const [saving, setSaving] = useState(false);
  const used = limit.usedBytes / MEGABYTE;
  const save = async () => {
    setSaving(true);
    try {
      await api('POST', `/api/companies/${companyId}/room-files/limit`, { megabytes: Number(value) });
      notifications.show({ color: 'teal', message: t('Saved.') });
      saved();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Stack gap="sm">
      <Text size="sm">{t('{used} MB of {limit} MB kept', { used: used.toFixed(used < 10 ? 1 : 0), limit: limit.megabytes })}</Text>
      <Progress value={Math.min(100, (limit.usedBytes / (limit.megabytes * MEGABYTE)) * 100)} aria-label={t('Room files kept')} />
      <Group align="flex-end" gap="sm" wrap="wrap">
        <NumberInput
          label={t('Limit, megabytes')}
          description={t('From 1 to 1,048,576. Lowering it removes nothing already kept.')}
          value={value}
          onChange={setValue}
          min={1}
          max={1_048_576}
          allowDecimal={false}
          allowNegative={false}
          style={{ flex: 1, minWidth: 220 }}
        />
        <Button variant="light" loading={saving} disabled={value === '' || Number(value) === limit.megabytes} onClick={() => void save()}>{t('Save')}</Button>
      </Group>
    </Stack>
  );
}
