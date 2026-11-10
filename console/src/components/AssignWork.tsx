/**
 * Giving a role something to do (F10.11): it wakes the role now rather than
 * waiting for its next heartbeat. Picked from the company's own shape -- a
 * project, a role, the goal it serves -- rather than typed in as ids.
 *
 * The fields are `AssignFields`, which a room's "Ask the team" draws too
 * (console/src/workspace/AskWork.tsx, F19.6): who does it, what it serves
 * and what it is, chosen the same way wherever work is given.
 */
import { useMemo, useState } from 'react';
import { Alert, Button, Group, NumberInput, Select, SimpleGrid, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import type { Structure } from '../types.ts';
import { goalKind } from '../format.ts';
import { t } from '../i18n.ts';
import { openGoals } from '../goals.ts';

/** What is chosen: the role (or `'company'`, for its CEO to decide), the project, the goal served and what to do. */
export interface Assignment {
  roleId: string | null;
  projectId: string | null;
  goalId: string | null;
  goal: string;
}

/** A role as the owner calls it. */
const called = (role: { slug: string; displayName: string | null }) => role.displayName ?? role.slug;

/**
 * The CEO is where work goes when the owner does not know whose it is
 * (0068): it hands it to whoever should do it, so it is the first choice.
 */
function routerOf(structure: Structure) {
  return structure.roles.find((role) => role.title === 'CEO') ?? structure.roles.find((role) => role.tools?.includes('task.delegate'));
}

/**
 * What the fields start as. Work given from the owner's form serves the
 * first open goal under the mission; work asked for in a room serves the
 * mission unless whoever asks says otherwise, since a message rarely names
 * a key result.
 */
export function startingAssignment(structure: Structure, options: { roleId?: string | null; goal?: string; serves?: 'leaf' | 'mission' } = {}): Assignment {
  const leaf = openGoals(structure.goals);
  const mission = leaf.find((goal) => goal.kind === 'mission');
  return {
    roleId: options.roleId !== undefined ? options.roleId : routerOf(structure)?.id ?? null,
    projectId: structure.projects[0]?.id ?? null,
    goalId: options.serves === 'mission'
      ? mission?.id ?? leaf[0]?.id ?? null
      : leaf.find((goal) => goal.kind !== 'mission')?.id ?? leaf[0]?.id ?? null,
    goal: options.goal ?? '',
  };
}

export function AssignFields({ structure, value, onChange, fixedRole = false, theCompany = false, project = true }: {
  structure: Structure;
  value: Assignment;
  onChange: (next: Assignment) => void;
  /** The role is already chosen, and not offered. */
  fixedRole?: boolean;
  /** Offer "The company" first, which means the CEO decides who does it. */
  theCompany?: boolean;
  /** Offer the project; a room's ask leaves it to the company's first. */
  project?: boolean;
}) {
  const router = routerOf(structure);
  const leaf = openGoals(structure.goals);
  const roleOptions = useMemo(() => [
    ...(theCompany ? [{ group: t('The company'), items: [{ value: 'company', label: t('The company: its CEO decides who does it') }] }] : []),
    ...structure.divisions.map((division) => ({
      group: division.name,
      items: structure.roles.filter((role) => role.divisionId === division.id)
        .map((role) => ({ value: role.id, label: [called(role), role.title].filter(Boolean).join(' · ') })),
    })).filter((group) => group.items.length > 0),
  ], [structure, theCompany]);
  const set = (change: Partial<Assignment>) => onChange({ ...value, ...change });

  return (
    <Stack>
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        {!fixedRole && (
          <Select
            label={theCompany ? t('Who') : t('Role')}
            placeholder={t('Who does it')}
            description={router && value.roleId === router.id ? t('{role} hands it to whoever should do it', { role: called(router) }) : undefined}
            data={roleOptions}
            value={value.roleId}
            onChange={(roleId) => set({ roleId })}
            searchable
            required
          />
        )}
        {project && (
          <Select
            label={t('Project')}
            data={structure.projects.map((one) => ({ value: one.id, label: one.name }))}
            value={value.projectId}
            onChange={(projectId) => set({ projectId })}
            required
          />
        )}
        <Select
          label={t('Serves')}
          description={t('Every task hangs from a goal')}
          data={leaf.map((one) => ({ value: one.id, label: `${goalKind(one.kind)}: ${one.statement}` }))}
          value={value.goalId}
          onChange={(goalId) => set({ goalId })}
          required
          style={{ gridColumn: '1 / -1' }}
        />
      </SimpleGrid>
      <Textarea label={t('What to do')} autosize minRows={3} maxRows={10} value={value.goal} onChange={(event) => set({ goal: event.currentTarget.value })} required />
    </Stack>
  );
}

export function AssignWork({
  companyId, structure, roleId: fixedRole, done,
}: { companyId: string; structure: Structure; roleId?: string; done: () => void }) {
  const [assignment, setAssignment] = useState<Assignment>(() => startingAssignment(structure, fixedRole ? { roleId: fixedRole } : {}));
  const [reserve, setReserve] = useState<number | string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const role = structure.roles.find((one) => one.id === assignment.roleId);
    if (!role || !assignment.projectId || !assignment.goalId || !assignment.goal.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const assigned: { taskId: string } = await api('POST', `/api/companies/${companyId}/assign`, {
        projectId: assignment.projectId, divisionId: role.divisionId, roleId: role.id, goalId: assignment.goalId, goal: assignment.goal,
        ...(reserve === '' ? {} : { reserveTokens: Number(reserve) }),
      });
      notifications.show({ color: 'teal', title: t('Assigned'), message: t('{role} is awake and has it (task {task}).', { role: called(role), task: assigned.taskId.slice(0, 8) }) });
      setAssignment((now) => ({ ...now, goal: '' }));
      done();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack>
      <AssignFields structure={structure} value={assignment} onChange={setAssignment} fixedRole={Boolean(fixedRole)} />
      <NumberInput label={t('Tokens to reserve')} description={t("Blank uses the role's default")} value={reserve} onChange={setReserve} min={0} maw={260} />
      {error && <Alert color="red" variant="light">{error}</Alert>}
      <Group justify="flex-end">
        <Button loading={busy} disabled={!assignment.roleId || !assignment.projectId || !assignment.goalId || !assignment.goal.trim()} onClick={() => void submit()}>
          {t('Assign it')}
        </Button>
      </Group>
    </Stack>
  );
}
