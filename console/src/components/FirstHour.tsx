/**
 * The owner's first hour with a new company (src/owner/first-hour.ts): four
 * steps, each ticked off by what the owner has actually done, each with the
 * button that does it, until every one is done or the owner closes the list.
 */
import { ActionIcon, Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLivePulse, useLoad } from '../hooks.ts';
import { t } from '../i18n.ts';
import type { ConsoleContext } from '../App.tsx';
import { notifications } from '@mantine/notifications';

interface FirstHour {
  open: boolean;
  steps: Array<{ step: 'talk' | 'budget' | 'work' | 'result'; done: boolean }>;
}

export function FirstHourCard({ ctx }: { ctx: ConsoleContext }) {
  const pulse = useLivePulse(ctx.companyId);
  const view = useLoad<FirstHour>(() => api('GET', `/api/companies/${ctx.companyId}/first-hour`), [ctx.companyId], { every: 15_000, pulse });
  if (!view.data?.open) return null;
  const ceo = ctx.company.ceo?.displayName ?? t('the CEO');

  const said: Record<FirstHour['steps'][number]['step'], { text: string; action: string; press: () => void }> = {
    talk: { text: t('Tell {ceo} what the company sells, and to whom', { ceo }), action: t('Talk to {ceo}', { ceo }), press: ctx.talk },
    budget: { text: t('Set how much it may spend in a month'), action: t('Open Money'), press: () => ctx.open('money') },
    work: { text: t('Give it its first piece of work'), action: t('Give work'), press: ctx.giveWork },
    result: { text: t('Read its first result'), action: t('Open Work'), press: () => ctx.open('work') },
  };
  const close = async () => {
    try {
      await api('POST', `/api/companies/${ctx.companyId}/first-hour/close`, {});
      view.reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };
  // The first step not yet done is the one to do now; it is the one with a filled button.
  const next = view.data.steps.find((one) => !one.done)?.step;

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" align="flex-start" wrap="nowrap" mb="sm">
        <div>
          <Text fw={700}>{t('Your first hour with {company}', { company: ctx.company.name })}</Text>
          <Text size="sm" c="dimmed">{t('Four steps to a company that is working on something real.')}</Text>
        </div>
        <ActionIcon variant="subtle" color="gray" aria-label={t('Close the first hour')} onClick={() => void close()}>
          <IconX size={16} />
        </ActionIcon>
      </Group>
      <Stack gap="xs">
        {view.data.steps.map((one) => (
          <Group key={one.step} justify="space-between" gap="xs" wrap="wrap">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              <ThemeIcon size="sm" radius="xl" variant={one.done ? 'filled' : 'light'} color={one.done ? 'teal' : 'gray'}>
                {one.done ? <IconCheck size={12} /> : null}
              </ThemeIcon>
              <Text size="sm" td={one.done ? 'line-through' : undefined} c={one.done ? 'dimmed' : undefined}>{said[one.step].text}</Text>
            </Group>
            {!one.done && (
              <Button size="xs" variant={one.step === next ? 'filled' : 'default'} onClick={said[one.step].press}>
                {said[one.step].action}
              </Button>
            )}
          </Group>
        ))}
      </Stack>
    </Paper>
  );
}
