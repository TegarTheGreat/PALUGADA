/**
 * Giving a role something to do (F10.11): it wakes the role now rather than
 * waiting for its next heartbeat. Picked from the company's own shape -- a
 * project, a role, the goal it serves -- rather than typed in as ids.
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../api.ts';
import type { Structure } from '../types.ts';

export function AssignWork({
  companyId, structure, roleId: fixedRole, done,
}: { companyId: string; structure: Structure; roleId?: string; done: () => void }) {
  const [roleId, setRoleId] = useState<string | null>(fixedRole ?? null);
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
      notifications.show({ color: 'teal', title: 'Assigned', message: `${role.slug} is awake and has it (task ${assigned.taskId.slice(0, 8)}).` });
      setGoal('');
      done();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {!fixedRole && (
          <Select label="Role" placeholder="Who does it" data={roleOptions} value={roleId} onChange={setRoleId} searchable required />
        )}
        <Select
          label="Project"
          data={structure.projects.map((project) => ({ value: project.id, label: project.name }))}
          value={projectId}
          onChange={setProjectId}
          required
        />
        <Select
          label="Serves"
          description="Every task hangs from a goal (F2.7)"
          data={leaf.map((one) => ({ value: one.id, label: `${one.kind.replace('_', ' ')}: ${one.statement}` }))}
          value={goalId}
          onChange={setGoalId}
          required
          style={{ gridColumn: '1 / -1' }}
        />
      </SimpleGrid>
      <Textarea label="What to do" autosize minRows={3} value={goal} onChange={(event) => setGoal(event.currentTarget.value)} required />
      <NumberInput label="Tokens to reserve" description="Blank uses the role's default" value={reserve} onChange={setReserve} min={0} maw={260} />
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button loading={busy} disabled={!roleId || !projectId || !goalId || !goal.trim()} onClick={() => void submit()}>
          Assign it
        </Button>
      </Group>
    </Stack>
  );
}
