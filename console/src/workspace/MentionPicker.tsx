/**
 * Who an `@` names (F19.4, F19.21): the company's people, and only people.
 * A role or an agent is never offered, since a mention starts nothing and an
 * agent reads no room; the picker says how to ask an agent instead. The
 * people of the room come first; each is drawn with their picture and, for
 * a seat, the handle beside the name, so two people of one name are told
 * apart by what is typed.
 */
import { Avatar, Group, Paper, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconUsersGroup } from '@tabler/icons-react';
import { t } from '../i18n.ts';
import { personPicture } from '../images.ts';
import { nameOf, tokenOf } from './scope.ts';
import type { Person } from './types.ts';

/** One choice: a person, or the whole room (`@room`), for the owner and approvers. */
export type MentionChoice = { person: Person; token: string } | { room: true; token: '@room' };

/** The `@` being typed at the caret, and where it starts; null when the caret is not in one. */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2]!.length - 1, query: match[2]! } : null;
}

/** Letters as they are compared: lower case, without their marks, so "rina" finds "Rína". */
function folded(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Whether a person is what is being typed: by a prefix of the handle, or of any word of the name. */
function matches(person: Person, query: string): boolean {
  const wanted = folded(query);
  if (!wanted) return true;
  const words = [person.handle ?? '', ...nameOf(person).split(/\s+/), ...(person.principal === 'owner' ? ['owner'] : [])];
  return words.some((word) => folded(word).startsWith(wanted));
}

/** The choices for what is typed: the room's people first, then everyone else of the company. */
export function mentionChoices(people: Person[], query: string, members: readonly string[], everyone: boolean): MentionChoice[] {
  const found = people.filter((person) => matches(person, query))
    .sort((one, other) => Number(!members.includes(one.principal)) - Number(!members.includes(other.principal)))
    .slice(0, 8)
    .map((person): MentionChoice => ({ person, token: tokenOf(person) }));
  return everyone && 'room'.startsWith(folded(query)) ? [...found, { room: true, token: '@room' }] : found;
}

export function MentionPicker({ choices, active, pick }: {
  choices: MentionChoice[];
  active: number;
  pick: (choice: MentionChoice) => void;
}) {
  return (
    <Paper withBorder shadow="md" radius="md" p={4} className="mention-picker" role="listbox" aria-label={t('People to mention')}>
      <Stack gap={0}>
        {choices.map((choice, index) => (
          'room' in choice ? (
            <UnstyledButton key="@room" role="option" aria-selected={index === active} data-active={index === active || undefined}
              data-mention-room className="mention-choice" onMouseDown={(event) => { event.preventDefault(); pick(choice); }}>
              <Group gap="xs" wrap="nowrap">
                <IconUsersGroup size={22} />
                <div>
                  <Text size="sm" fw={600}>@room</Text>
                  <Text size="xs" c="dimmed">{t('Everyone in this room')}</Text>
                </div>
              </Group>
            </UnstyledButton>
          ) : (
            <UnstyledButton key={choice.person.principal} role="option" aria-selected={index === active} data-active={index === active || undefined}
              data-mention={choice.person.principal} className="mention-choice" onMouseDown={(event) => { event.preventDefault(); pick(choice); }}>
              <Group gap="xs" wrap="nowrap">
                <Avatar size={24} radius="xl" src={personPicture(choice.person.principal, choice.person.picture)} alt="" />
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} truncate>{nameOf(choice.person)}</Text>
                    {choice.person.handle && <Text size="xs" c="dimmed">@{choice.person.handle}</Text>}
                  </Group>
                  {!choice.person.linked && <Text size="xs" c="dimmed">{t('not told outside PALUGADA')}</Text>}
                </div>
              </Group>
            </UnstyledButton>
          )
        ))}
        <Text size="xs" c="dimmed" px="xs" py={4} data-mention-hint>{t('To ask an agent, use Ask the team.')}</Text>
      </Stack>
    </Paper>
  );
}
