/**
 * A line the platform writes in a room (F19.5, F19.6): a coded notice, said
 * here in the reader's language with the values it carries. The platform
 * writes no words of its own into a room; every ask that did not become
 * work ends in one of these, saying why, so no ask is ever silent.
 */
import { Group, Text } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { N, t } from '../i18n.ts';

/** What each notice says, by its code (src/workspace/cards.ts). */
const NOTICES: Record<string, string> = {
  held_paused: N('Not started: the company has reached its spending ceiling for the month. Ask again when the month turns or the ceiling is raised.'),
  refused_frozen: N('Not started: {role} is frozen.'),
  refused_incomplete: N('Not started: {role} is not set up to take work yet.'),
  refused_budget: N('Not started: there is not enough money in {role}\'s budget to hold for it.'),
  refused_goal: N('Not started: the goal it would serve is closed.'),
  refused_project: N('Not started: that project cannot take this work.'),
  recorded: N('Recorded. It reads this when its next run starts.'),
  queued: N('Still queued: the role is busy with other work, and starts this when it is free.'),
};

export function noticeSaid(notice: { code: string; values: Record<string, unknown> }): string {
  const sentence = NOTICES[notice.code];
  if (!sentence) return t('A notice from PALUGADA.');
  const role = typeof notice.values.role === 'string' && notice.values.role ? notice.values.role : t('the role');
  return t(sentence, { role });
}

export function NoticeRow({ notice }: { notice: { code: string; values: Record<string, unknown> } }) {
  return (
    <Group gap={6} wrap="nowrap" align="flex-start" py={2}>
      <IconInfoCircle size={16} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0, marginTop: 2 }} />
      <Text size="sm" c="dimmed">{noticeSaid(notice)}</Text>
    </Group>
  );
}
