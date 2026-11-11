/**
 * Who an `@` names (F19.4, F19.21): the company's people, and only people.
 * A role or an agent is never offered, since a mention starts nothing and an
 * agent reads no room; the picker says how to ask an agent instead. The
 * people of the room come first; each is drawn with their picture and, for
 * a seat, the handle beside the name, so two people of one name are told
 * apart by what is typed. The list is the composer's (its combobox): the
 * composer keeps the focus and names the option the arrows are on by its id
 * (`optionId`), so the options themselves are never focused.
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

/**
 * How well a person matches what is typed, best first, or null when they do
 * not (STATUS 2.218): their handle exactly, then a handle that begins so,
 * then a name whose first word does (and the owner's `owner`), then one
 * whose later word does. Enter takes the first choice, so `@sa` offers Sari
 * of `@sari` before Budi Santoso.
 */
function rankOf(person: Person, query: string): number | null {
  const wanted = folded(query);
  const handle = folded(person.principal === 'owner' ? 'owner' : person.handle ?? '');
  const words = nameOf(person).split(/\s+/).map(folded).filter(Boolean);
  if (!wanted) return 2;
  if (handle && handle === wanted) return 0;
  if (handle.startsWith(wanted)) return 1;
  if (words[0]?.startsWith(wanted)) return 2;
  if (words.slice(1).some((word) => word.startsWith(wanted))) return 3;
  return null;
}

/** The id of a choice in the list `listId`, which the composer names as the one the arrows are on. */
export function optionId(listId: string, index: number): string {
  return `${listId}-${index}`;
}

/**
 * The choices for what is typed: the best matches first (`rankOf`), and
 * within each, the room's people before everyone else of the company, then by
 * name.
 */
export function mentionChoices(people: Person[], query: string, members: readonly string[], everyone: boolean): MentionChoice[] {
  const found = people.flatMap((person) => {
    const rank = rankOf(person, query);
    return rank === null ? [] : [{ person, rank, member: members.includes(person.principal) ? 0 : 1 }];
  })
    .sort((one, other) => one.rank - other.rank || one.member - other.member || nameOf(one.person).localeCompare(nameOf(other.person)))
    .slice(0, 8)
    .map(({ person }): MentionChoice => ({ person, token: tokenOf(person) }));
  return everyone && 'room'.startsWith(folded(query)) ? [...found, { room: true, token: '@room' }] : found;
}

export function MentionPicker({ id, choices, active, pick }: {
  /** The list's id, which the composer's `aria-controls` names. */
  id: string;
  choices: MentionChoice[];
  active: number;
  pick: (choice: MentionChoice) => void;
}) {
  return (
    <Paper withBorder shadow="md" radius="md" p={4} className="mention-picker">
      <Stack gap={0} id={id} role="listbox" aria-label={t('People to mention')}>
        {choices.map((choice, index) => (
          'room' in choice ? (
            <UnstyledButton key="@room" id={optionId(id, index)} tabIndex={-1} role="option" aria-selected={index === active} data-active={index === active || undefined}
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
            <UnstyledButton key={choice.person.principal} id={optionId(id, index)} tabIndex={-1} role="option" aria-selected={index === active} data-active={index === active || undefined}
              data-mention={choice.person.principal} className="mention-choice" onMouseDown={(event) => { event.preventDefault(); pick(choice); }}>
              <Group gap="xs" wrap="nowrap">
                <Avatar size={24} radius="xl" src={personPicture(choice.person.principal, choice.person.picture)} alt="" />
                <div style={{ minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} truncate>{nameOf(choice.person)}</Text>
                    {choice.person.handle && <Text size="xs" c="dimmed" dir="ltr">@{choice.person.handle}</Text>}
                  </Group>
                  {!choice.person.linked && <Text size="xs" c="dimmed">{t('not told outside PALUGADA')}</Text>}
                </div>
              </Group>
            </UnstyledButton>
          )
        ))}
      </Stack>
      <Text size="xs" c="dimmed" px="xs" py={4} data-mention-hint>{t('To ask an agent, use Ask the team.')}</Text>
    </Paper>
  );
}
