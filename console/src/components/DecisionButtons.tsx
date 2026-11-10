/**
 * The buttons a decision is made with, drawn the same wherever one is made:
 * in the inbox, and on an approval card in a room (F10.10, F19.7).
 *
 * "Approve" is the irreversible one, so it is not the easiest to hit: an
 * outline, never filled, after a plain "Deny". Nothing here answers a key,
 * and nothing gives either button the focus: a decision is a press, made
 * with the item in front of whoever makes it. One component, so a room's
 * card cannot drift from the inbox's friction.
 */
import type { ReactNode } from 'react';
import { Button, Group } from '@mantine/core';
import { IconCheck, IconX } from '@tabler/icons-react';
import { t } from '../i18n.ts';

export function DecisionButtons({ decide, busy, approveDisabled = false, approve, size = 'sm' }: {
  decide: (decision: 'approve' | 'deny') => void | Promise<void>;
  /** Which of the two is on its way, if either. */
  busy: string | null;
  /** A yes that cannot be given yet: a plan with no line chosen. */
  approveDisabled?: boolean;
  /** In place of the plain approve, the inbox's approve with its "for a while" menu, drawn the same way. */
  approve?: ReactNode;
  size?: 'xs' | 'sm';
}) {
  return (
    <Group gap="xs" wrap="nowrap">
      <Button size={size} variant="default" leftSection={<IconX size={16} />} loading={busy === 'deny'} onClick={() => void decide('deny')}>
        {t('Deny')}
      </Button>
      {approve ?? (
        <Button size={size} variant="outline" color="teal" leftSection={<IconCheck size={16} />} loading={busy === 'approve'} disabled={approveDisabled} onClick={() => void decide('approve')}>
          {t('Approve')}
        </Button>
      )}
    </Group>
  );
}
