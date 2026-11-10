/**
 * Choosing an emoji: to react to a message, or to write one in the composer
 * (F19.4). The emoji are Unicode characters in groups (`emoji.ts`), drawn
 * as text; nothing is fetched.
 */
import { useState, type ReactNode } from 'react';
import { Popover, ScrollArea, SegmentedControl, SimpleGrid, UnstyledButton } from '@mantine/core';
import { t } from '../i18n.ts';
import { EMOJI_GROUPS } from './emoji.ts';

export function EmojiPicker({ target, pick, opened, setOpened }: {
  /** What opens it: a button, which the popover is drawn beside. */
  target: ReactNode;
  pick: (emoji: string) => void;
  opened: boolean;
  setOpened: (opened: boolean) => void;
}) {
  const [group, setGroup] = useState(EMOJI_GROUPS[0]!.name);
  const shown = EMOJI_GROUPS.find((one) => one.name === group) ?? EMOJI_GROUPS[0]!;
  return (
    <Popover opened={opened} onChange={setOpened} position="top-end" shadow="md" withinPortal trapFocus>
      <Popover.Target>{target}</Popover.Target>
      <Popover.Dropdown p="xs" maw="min(320px, calc(100vw - 32px))">
        {/* The groups are wider than the popover: a scrollbar shows there are more of them, and reaches them. */}
        <ScrollArea type="auto" scrollbarSize={6} offsetScrollbars="x" mb={6}>
          <SegmentedControl
            size="xs"
            value={group}
            onChange={setGroup}
            data={EMOJI_GROUPS.map((one) => ({ value: one.name, label: t(one.name) }))}
          />
        </ScrollArea>
        <ScrollArea.Autosize mah={220} type="auto">
          <SimpleGrid cols={8} spacing={2} verticalSpacing={2}>
            {shown.emoji.map((emoji) => (
              <UnstyledButton
                key={emoji}
                className="emoji-choice"
                aria-label={emoji}
                onClick={() => { pick(emoji); setOpened(false); }}
              >
                {emoji}
              </UnstyledButton>
            ))}
          </SimpleGrid>
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}
