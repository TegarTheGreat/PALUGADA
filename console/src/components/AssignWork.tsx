/**
 * Giving a role something to do (F10.11): it wakes the role now rather than
 * waiting for its next heartbeat. Picked from the company's own shape -- a
 * project, a role, the goal it serves -- rather than typed in as ids.
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import type { Structure } from '../types.ts';
import { goalKind } from '../format.ts';
import { t } from '../i18n.ts';

export function AssignWork({
  companyId, structure, roleId: fixedRole, done,
}: { companyId: string; structure: Structure; roleId?: string; done: () => void }) {
  // The role that routes work -- the standard company's coordinator -- is
  // where work goes when the owner does not know whose it is, so it is picked
  // unless the owner picks someone else.
  const router = structure.roles.find((role) => role.slug === 'coordinator')
    ?? structure.roles.find((role) => role.tools?.includes('task.delegate'));
  const [roleId, setRoleId] = useState<string | null>(fixedRole ?? router?.id ?? null);
  const [projectId, setProjectId] = useState<string | null>(structure.projects[0]?.id ?? null);
  const leaf = structure.goals.filter((goal) => goal.status === 'active');
  const [goalId, setGoalId] = useState<string | null>(
    leaf.find((goal) => goal.kind !== 'mission')?.id ?? leaf[0]?.id ?? null,
  );
  const [goal, setGoal] = useState('');
  const [reserve, setReserve] = useState<number | string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleOptions = useMemo(() => structure.divisions.map((division) => ({
    group: division.name,
    items: structure.roles.filter((role) => role.divisionId === division.id)
      .map((role) => ({ value: role.id, label: role.slug })),
  })).filter((group) => group.items.length > 0), [structure]);

  const submit = async () => {
    const role = structure.roles.find((one) => one.id === roleId);
    if (!role || !projectId || !goalId || !goal.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const assigned: { taskId: string } = await api('POST', `/api/companies/${companyId}/assign`, {
        projectId, divisionId: role.divisionId, roleId: role.id, goalId, goal,
        ...(reserve === '' ? {} : { reserveTokens: Number(reserve) }),
      });
      notifications.show({ color: 'teal', title: t('Assigned'), message: t('{role} is awake and has it (task {task}).', { role: role.slug, task: assigned.taskId.slice(0, 8) }) });
      setGoal('');
      done();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {!fixedRole && (
          <Select
            label={t('Role')}
            placeholder={t('Who does it')}
            description={router && roleId === router.id ? t('{role} hands it to whoever should do it', { role: router.slug }) : undefined}
            data={roleOptions}
            value={roleId}
            onChange={setRoleId}
            searchable
            required
          />
        )}
        <Select
          label={t('Project')}
          data={structure.projects.map((project) => ({ value: project.id, label: project.name }))}
          value={projectId}
          onChange={setProjectId}
          required
        />
        <Select
          label={t('Serves')}
          description={t('Every task hangs from a goal')}
          data={leaf.map((one) => ({ value: one.id, label: `${goalKind(one.kind)}: ${one.statement}` }))}
          value={goalId}
          onChange={setGoalId}
          required
          style={{ gridColumn: '1 / -1' }}
        />
      </SimpleGrid>
      <Textarea label={t('What to do')} autosize minRows={3} value={goal} onChange={(event) => setGoal(event.currentTarget.value)} required />
      <NumberInput label={t('Tokens to reserve')} description={t("Blank uses the role's default")} value={reserve} onChange={setReserve} min={0} maw={260} />
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button loading={busy} disabled={!roleId || !projectId || !goalId || !goal.trim()} onClick={() => void submit()}>
          {t('Assign it')}
        </Button>
      </Group>
    </Stack>
  );
}
