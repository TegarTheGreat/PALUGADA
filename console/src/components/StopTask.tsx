/**
 * Stop, on what is running now (the analysis of 3 October, §9 P1 item 11):
 * the owner watching work go wrong stops it where they see it, asked once
 * first, since everything it started stops with it.
 */
import { useState } from 'react';
import { ActionIcon, Button, Popover, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconPlayerStop } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';

export function StopTask({ companyId, taskId, stopped }: { companyId: string; taskId: string; stopped: () => void }) {
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/tasks/${taskId}/cancel`, {});
      notifications.show({ color: 'teal', message: t('Cancelled, with everything it started.') });
      setOpened(false);
      stopped();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover opened={opened} onChange={setOpened} position="bottom-end" withArrow shadow="md">
      <Popover.Target>
        <ActionIcon variant="subtle" color="red" aria-label={t('Cancel this task')}
          onClick={(event) => { event.stopPropagation(); setOpened((open) => !open); }}>
          <IconPlayerStop size={16} />
        </ActionIcon>
      </Popover.Target>
      {/* Pressing inside it is not pressing the row it sits on. */}
      <Popover.Dropdown onClick={(event) => event.stopPropagation()}>
        <Stack gap="xs" maw={240}>
          <Text size="sm">{t('Cancel this task and everything it started?')}</Text>
          <Button size="xs" color="red" loading={busy} onClick={() => void stop()}>{t('Cancel this task')}</Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}
