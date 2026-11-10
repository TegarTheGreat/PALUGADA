/**
 * A topic room, made by anyone (F19.1): a name, what it is for, whether it
 * is private, and who is in it from the start. Whoever makes it runs it. A
 * private room is read by its members and the owner, and the form says so
 * before it is made.
 */
import { useState } from 'react';
import { Alert, Avatar, Button, Group, Modal, MultiSelect, Stack, Switch, Text, TextInput, Textarea } from '@mantine/core';
import { api, explain } from '../api.ts';
import { t } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, useScope } from './scope.ts';
import type { Room } from './types.ts';

export function NewRoom({ opened, close, made }: { opened: boolean; close: () => void; made: (roomId: string) => void }) {
  const scope = useScope();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [secret, setSecret] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = scope.people.filter((person) => person.principal !== scope.me);
  const byPrincipal = new Map(others.map((person) => [person.principal, person]));

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer: { room: Room } = await api('POST', `/api/companies/${scope.companyId}/rooms`, {
        name: name.trim(), private: secret, members, ...(about.trim() ? { about: about.trim() } : {}),
      });
      setName('');
      setAbout('');
      setSecret(false);
      setMembers([]);
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
    <Modal opened={opened} onClose={close} title={t('New room')} centered>
      <Stack>
        <TextInput label={t('Name')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={80} required data-autofocus />
        <Textarea label={t('What it is for')} value={about} onChange={(event) => setAbout(event.currentTarget.value)} autosize minRows={1} maxLength={500} />
        <Switch label={t('Private')} description={t('Its members and the owner can read it. Anyone else in the company cannot see it.')}
          checked={secret} onChange={(event) => setSecret(event.currentTarget.checked)} />
        <MultiSelect
          label={t('People')}
          data={others.map((person) => ({ value: person.principal, label: person.handle ? `${nameOf(person)} @${person.handle}` : nameOf(person) }))}
          renderOption={({ option }) => {
            const person = byPrincipal.get(option.value);
            return (
              <Group gap="xs" wrap="nowrap">
                {person && <Avatar size={20} radius="xl" src={personPicture(person.principal, person.picture)} alt="" />}
                <Text size="sm">{option.label}</Text>
              </Group>
            );
          }}
          value={members}
          onChange={setMembers}
          searchable
        />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>{t('Cancel')}</Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void make()}>{t('Make the room')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
