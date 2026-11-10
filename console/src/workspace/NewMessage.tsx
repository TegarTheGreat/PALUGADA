/**
 * A direct conversation (F19.1): the reader and one to seven of the
 * company's people. The same people always find the same conversation; a
 * different set is a different one, with none of the other's history,
 * which is how "Add people" in a conversation works.
 */
import { useEffect, useState } from 'react';
import { Alert, Avatar, Button, Checkbox, Group, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { api, explain } from '../api.ts';
import { t, tp } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, useScope } from './scope.ts';
import type { Room } from './types.ts';

/** The most others a direct conversation holds, the reader making eight. */
const OTHERS_MAX = 7;

export function NewMessage({ opened, close, chosen: start, made }: {
  opened: boolean;
  close: () => void;
  /** Who is chosen when it opens: a conversation's people, for "Add people". */
  chosen: string[];
  made: (roomId: string) => void;
}) {
  const scope = useScope();
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (opened) setChosen(start.filter((principal) => principal !== scope.me));
    setError(null);
  }, [opened]);
  const others = scope.people.filter((person) => person.principal !== scope.me);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer: { room: Room; opened: boolean } = await api('POST', `/api/companies/${scope.companyId}/direct-rooms`, { principals: chosen });
      close();
      scope.changed();
      made(answer.room.id);
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal opened={opened} onClose={close} title={t('New message')} centered>
      <Stack>
        <Text size="sm" c="dimmed">{t('Choose one to seven people. The same people always find the same conversation.')}</Text>
        <ScrollArea.Autosize mah={320} type="auto">
          <Stack gap={6}>
            {others.map((person) => (
              <Checkbox
                key={person.principal}
                checked={chosen.includes(person.principal)}
                disabled={!chosen.includes(person.principal) && chosen.length >= OTHERS_MAX}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setChosen((now) => (on ? [...now, person.principal] : now.filter((one) => one !== person.principal)));
                }}
                label={(
                  <Group gap="xs" wrap="nowrap">
                    <Avatar size={24} radius="xl" src={personPicture(person.principal, person.picture)} alt="" />
                    <Text size="sm" fw={600}>{nameOf(person)}</Text>
                    {person.handle && <Text size="xs" c="dimmed">@{person.handle}</Text>}
                  </Group>
                )}
              />
            ))}
          </Stack>
        </ScrollArea.Autosize>
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button loading={busy} disabled={chosen.length === 0} onClick={() => void open()}>
            {chosen.length === 0 ? t('Open the conversation') : tp('Open the conversation with {count} person', 'Open the conversation with {count} people', chosen.length)}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
