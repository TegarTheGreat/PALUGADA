/**
 * "Ask the team" (F19.6, F19.8): a message becomes work only here, by a
 * press, through the door a room's message has (`…/messages/:id/work`).
 *
 * Who does it is the company, which means its CEO decides, or a role; what
 * it serves is the mission unless the asker says otherwise; what it is, is
 * the message's words, which the asker may say again more exactly. The
 * money is held from that role's budget before anything starts, and the
 * drawer says whose. In a private room or a direct conversation it says too
 * that the words become company work, which everyone in the company and its
 * agents can read. Refused, the message stays a message and its thread says
 * why.
 */
import { useEffect, useState } from 'react';
import { Alert, Box, Button, Drawer, Group, Select, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import { AssignFields, startingAssignment, type Assignment } from '../components/AssignWork.tsx';
import { t } from '../i18n.ts';
import type { Structure } from '../types.ts';
import { useScope } from './scope.ts';
import type { MessageView } from './types.ts';

export function AskWork({ message, close }: { message: MessageView | null; close: () => void }) {
  const scope = useScope();
  const [structure, setStructure] = useState<Structure | null>(null);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [priority, setPriority] = useState<string | null>('2');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!message) return;
    setError(null);
    setPriority('2');
    void api('GET', `/api/companies/${scope.companyId}/structure`).then((read: Structure) => {
      setStructure(read);
      // The company first: its CEO decides who does it, as an owner who does not know whose it is would want.
      setAssignment(startingAssignment(read, { roleId: scope.ctx.company.ceo ? 'company' : undefined, goal: message.body ?? '', serves: 'mission' }));
    }, (failure: unknown) => setError(explain(failure)));
  }, [message?.id]);

  // Whose budget holds the money: the CEO's when the company is asked, the role's otherwise.
  const ceo = scope.ctx.company.ceo;
  const chosen = structure?.roles.find((one) => one.id === assignment?.roleId);
  const roleName = assignment?.roleId === 'company' ? (ceo ? ceo.displayName ?? ceo.slug : null)
    : chosen ? chosen.displayName ?? chosen.slug : null;
  const quietRoom = scope.room !== null && (scope.room.private || scope.room.kind === 'direct');

  const ask = async () => {
    if (!message || !assignment?.roleId || !assignment.goalId || !assignment.goal.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/api/companies/${scope.companyId}/rooms/${message.roomId}/messages/${message.id}/work`, {
        target: assignment.roleId, goal: assignment.goal.trim(), goalId: assignment.goalId,
        ...(priority === null ? {} : { priority: Number(priority) }),
      });
      notifications.show({ color: 'teal', message: t('Asked. The work shows under the message, and moves as it moves.') });
      close();
      scope.changed();
    } catch (failure) {
      // The thread now says why too (a notice the server posted), so it is read again.
      setError(explain(failure));
      scope.changed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer opened={message !== null} onClose={close} position="right" size="md" title={t('Ask the team')}>
      <Box data-askwork>
        {!structure || !assignment ? (
          error ? <Alert color="red" variant="light">{error}</Alert> : <Text size="sm" c="dimmed">{t('Loading…')}</Text>
        ) : (
          <Stack>
            <AssignFields structure={structure} value={assignment} onChange={setAssignment} theCompany={Boolean(scope.ctx.company.ceo)} project={false} />
            <Select label={t('Priority')} value={priority} onChange={setPriority} allowDeselect={false} data={[
              { value: '0', label: t('P0 · first') }, { value: '1', label: t('P1 · soon') }, { value: '2', label: t('P2 · normal') }, { value: '3', label: t('P3 · when there is time') },
            ]} />
            {roleName && <Text size="sm" c="dimmed">{t("Reserves money from {role}'s budget before it starts", { role: roleName })}</Text>}
            {quietRoom && (
              <Alert variant="light" color="yellow">
                <Text size="sm">{t('This becomes company work: its words are visible to everyone in {company} and to its agents.', { company: scope.ctx.company.name })}</Text>
              </Alert>
            )}
            {error && <Alert color="red" variant="light">{error}</Alert>}
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>{t('Cancel')}</Button>
              <Button data-ask loading={busy} disabled={!assignment.roleId || !assignment.goalId || !assignment.goal.trim()} onClick={() => void ask()}>
                {t('Ask')}
              </Button>
            </Group>
          </Stack>
        )}
      </Box>
    </Drawer>
  );
}
