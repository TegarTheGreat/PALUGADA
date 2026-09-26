/**
 * The company's shape (F2, F2.7, F3): the goal ladder it works towards, its
 * divisions and the roles in them, its schedules and its policies. Every
 * change is made from the thing it changes -- a role's charter from the role,
 * a division's grants from the division -- instead of from a form that asks
 * which one by id.
 */
import { useState } from 'react';
import {
  Accordion, Alert, Avatar, Badge, Box, Button, Card, Divider, Drawer, Group, Modal, Paper, Select,
  SimpleGrid, Stack, Table, Tabs, Text, Textarea, TextInput, ThemeIcon, Title, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconBuilding, IconCalendarTime, IconFlag, IconPlus, IconShieldCheck, IconTarget, IconUsersGroup,
} from '@tabler/icons-react';
import { api } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Division, Goal, Role, Schedule, Structure } from '../types.ts';
import { dateTime, money, relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';
import { AssignWork } from '../components/AssignWork.tsx';

export function Organization({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [structure, schedules]: [Structure, { schedules: Schedule[] }] = await Promise.all([
      api('GET', `/api/companies/${companyId}/structure`),
      api('GET', `/api/companies/${companyId}/schedules`),
    ]);
    return { structure, schedules: schedules.schedules };
  }, [companyId]);
  const [role, setRole] = useState<Role | null>(null);
  const [division, setDivision] = useState<Division | null>(null);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={5} />;
  const { structure, schedules } = view.data;

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>Organization</Title>
      </div>

      <Tabs defaultValue="chart" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="chart" leftSection={<IconUsersGroup size={16} />}>Divisions & roles</Tabs.Tab>
          <Tabs.Tab value="goals" leftSection={<IconTarget size={16} />}>Goals</Tabs.Tab>
          <Tabs.Tab value="schedules" leftSection={<IconCalendarTime size={16} />}>Schedules</Tabs.Tab>
          <Tabs.Tab value="policies" leftSection={<IconShieldCheck size={16} />}>Policies</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="chart">
          <OrgChart structure={structure} company={ctx.company.name} openRole={setRole} openDivision={setDivision} />
        </Tabs.Panel>
        <Tabs.Panel value="goals">
          <GoalLadder companyId={companyId} goals={structure.goals} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="schedules">
          <Schedules companyId={companyId} structure={structure} schedules={schedules} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="policies">
          <Policies companyId={companyId} />
        </Tabs.Panel>
      </Tabs>

      <RoleDrawer companyId={companyId} role={role} structure={structure} close={() => setRole(null)} changed={view.reload} />
      <DivisionDrawer companyId={companyId} division={division} structure={structure} close={() => setDivision(null)} changed={view.reload} />
    </Stack>
  );
}

/* --------------------------------------------------------------- the chart --- */

function OrgChart({
  structure, company, openRole, openDivision,
}: {
  structure: Structure;
  company: string;
  openRole: (role: Role) => void;
  openDivision: (division: Division) => void;
}) {
  const top = structure.divisions.filter((division) => division.parentId === null);
  const childrenOf = (id: string) => structure.divisions.filter((division) => division.parentId === id);
  return (
    <Stack gap={0} align="stretch">
      <Group justify="center">
        <Paper withBorder radius="md" px="lg" py="sm" shadow="xs">
          <Group gap="sm">
            <ThemeIcon radius="md" size="lg"><IconBuilding size={18} /></ThemeIcon>
            <div>
              <Text fw={800}>{company}</Text>
              <Text size="xs" c="dimmed">{structure.divisions.length} divisions · {structure.roles.length} roles · you own it</Text>
            </div>
          </Group>
        </Paper>
      </Group>
      <div className="org-connector" />
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="md">
        {top.map((division) => (
          <Stack key={division.id} gap="sm">
            <DivisionCard division={division} roles={structure.roles.filter((role) => role.divisionId === division.id)} openRole={openRole} openDivision={openDivision} />
            {childrenOf(division.id).map((child) => (
              <Box key={child.id} pl="lg" style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}>
                <DivisionCard division={child} roles={structure.roles.filter((role) => role.divisionId === child.id)} openRole={openRole} openDivision={openDivision} />
              </Box>
            ))}
          </Stack>
        ))}
      </SimpleGrid>
    </Stack>
  );
}

function roleState(role: Role): { label: string; color: string } {
  if (role.frozenAt) return { label: 'Frozen', color: 'red' };
  if (role.openTasks > 0) return { label: 'Working', color: 'teal' };
  if (role.dormantUntil && new Date(role.dormantUntil) > new Date()) return { label: 'Asleep', color: 'gray' };
  return { label: 'Idle', color: 'gray' };
}

function DivisionCard({
  division, roles, openRole, openDivision,
}: { division: Division; roles: Role[]; openRole: (role: Role) => void; openDivision: (division: Division) => void }) {
  return (
    <Card withBorder radius="md" shadow="xs" padding="md" className="org-node">
      <Group justify="space-between" onClick={() => openDivision(division)} style={{ cursor: 'pointer' }} wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text fw={700} truncate>{division.name}</Text>
          <Text size="xs" c="dimmed">{division.grants.length} capabilities · up to {division.maxConcurrency} at once</Text>
        </div>
        {division.openTasks > 0 ? <Badge color="teal" variant="light">{division.openTasks} open</Badge> : <Badge color="gray" variant="light">quiet</Badge>}
      </Group>
      <Divider my="sm" />
      <Stack gap={6}>
        {roles.length === 0 && <Text size="xs" c="dimmed">No roles.</Text>}
        {roles.map((role) => {
          const state = roleState(role);
          return (
            <Paper key={role.id} withBorder radius="md" px="sm" py={8} className="org-node" onClick={() => openRole(role)}>
              <Group gap="sm" wrap="nowrap">
                <Avatar size={30} radius="xl" color={state.color === 'teal' ? 'teal' : 'blue'}>{role.slug.slice(0, 2).toUpperCase()}</Avatar>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600} truncate>{role.slug}</Text>
                  <Text size="xs" c="dimmed" truncate>{role.model}{role.runtime ? ` · ${role.runtime}` : ''}</Text>
                </div>
                <Tooltip label={role.frozenReason ?? `${role.openTasks} open · ${role.doneLastWeek} done this week`}>
                  <Badge size="sm" variant="dot" color={state.color}>{state.label}</Badge>
                </Tooltip>
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </Card>
  );
}

/* ------------------------------------------------------------ role drawer --- */

function RoleDrawer({
  companyId, role, structure, close, changed,
}: { companyId: string; role: Role | null; structure: Structure; close: () => void; changed: () => void }) {
  const division = structure.divisions.find((one) => one.id === role?.divisionId);
  return (
    <Drawer opened={role !== null} onClose={close} position="right" size="xl" title={<Text fw={700}>{role?.slug}</Text>}>
      {role && division && (
        <Stack gap="lg">
          <Group gap="xs">
            <Badge variant="light">{division.name}</Badge>
            <Badge variant="dot" color={roleState(role).color}>{roleState(role).label}</Badge>
            <Badge variant="outline" color="gray">{role.model}</Badge>
            {role.runtime && <Badge variant="outline" color="gray">{role.runtime}</Badge>}
          </Group>
          {role.frozenAt && (
            <Alert color="red" variant="light" title="Frozen">
              <Text size="sm">{role.frozenReason ?? 'Repeatedly denied.'} It stays frozen until you look (F3.7).</Text>
              <Group mt="sm">
                <ActionButton
                  label="Resume this role"
                  color="red"
                  variant="light"
                  factor={`Resume ${role.slug}`}
                  run={(proof) => api('POST', `/api/control/company/${companyId}/role/${role.id}/resume`, { proof })}
                  done={() => { notifications.show({ color: 'teal', message: `${role.slug} resumed.` }); changed(); close(); }}
                />
              </Group>
            </Alert>
          )}
          <SimpleGrid cols={3} spacing="sm">
            <Mini label="Open tasks" value={String(role.openTasks)} />
            <Mini label="Done this week" value={String(role.doneLastWeek)} />
            <Mini label="Heartbeat" value={role.heartbeatMinutes ? `${role.heartbeatMinutes} min` : 'Default'} />
          </SimpleGrid>
          <div>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>Tools</Text>
            <Group gap={6}>{role.tools.length === 0 ? <Text size="sm" c="dimmed">None</Text> : role.tools.map((tool) => <Badge key={tool} variant="light" color="gray" radius="sm">{tool}</Badge>)}</Group>
          </div>

          <Accordion variant="separated" radius="md" defaultValue="work">
            <Accordion.Item value="work">
              <Accordion.Control>Give it something to do</Accordion.Control>
              <Accordion.Panel>
                <AssignWork companyId={companyId} structure={structure} roleId={role.id} done={changed} />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="budget">
              <Accordion.Control>What funds it</Accordion.Control>
              <Accordion.Panel><RoleBudget companyId={companyId} role={role} /></Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="change">
              <Accordion.Control>Change its charter or model</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  columns={1}
                  fields={[
                    { name: 'systemPrompt', label: 'Charter', type: 'textarea', description: 'Blank keeps the current one' },
                    { name: 'modelPrimary', label: 'Primary model', initial: role.model },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/roles/${role.id}`, { ...values, proof })}
                  factor={`Change ${role.slug}`}
                  action="Change it"
                  success="Role changed."
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="evals">
              <Accordion.Control>Eval set and change requests</Accordion.Control>
              <Accordion.Panel><RoleEvals companyId={companyId} role={role} /></Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      )}
    </Drawer>
  );
}

function RoleBudget({ companyId, role }: { companyId: string; role: Role }) {
  // F1.6. A budget is a tree: a task draws on the narrowest account that
  // covers it, and a spend counts against every account above.
  const budget = useLoad(async () => {
    const answer: { accountId: string; snapshot: { tokensSpent: number; tokensMax: number; moneySpentCents?: number; moneyMaxCents?: number }; chain: string[] } =
      await api('GET', `/api/companies/${companyId}/divisions/${role.divisionId}/roles/${role.id}/budget`);
    return answer;
  }, [companyId, role.id]);
  if (budget.error) return <Text c="red" size="sm">{budget.error}</Text>;
  if (!budget.data) return <Loading rows={1} />;
  return (
    <SimpleGrid cols={2} spacing="sm">
      <Mini label="Tokens" value={`${budget.data.snapshot.tokensSpent.toLocaleString()} of ${budget.data.snapshot.tokensMax.toLocaleString()}`} />
      {budget.data.snapshot.moneyMaxCents !== undefined && (
        <Mini label="Money" value={`${money(budget.data.snapshot.moneySpentCents ?? 0)} of ${money(budget.data.snapshot.moneyMaxCents)}`} />
      )}
      <Paper withBorder radius="md" p="sm" style={{ gridColumn: '1 / -1' }}>
        <Text size="xs" c="dimmed">Rolls up through</Text>
        <Text size="sm" ff="monospace">{budget.data.chain.map((id) => id.slice(0, 8)).join(' → ')}</Text>
      </Paper>
    </SimpleGrid>
  );
}

function RoleEvals({ companyId, role }: { companyId: string; role: Role }) {
  const evals = useLoad(async () => {
    const answer: {
      latest: { passed: number; failed: number; ranAt: string; triggeredBy: string } | null;
      cases: Array<{ id: string; name: string; polarity: string; accepted: boolean }>;
    } = await api('GET', `/api/companies/${companyId}/roles/${role.id}/evals`);
    return answer;
  }, [companyId, role.id]);
  const [asked, setAsked] = useState<string | null>(null);
  if (evals.error) return <Text c="red" size="sm">{evals.error}</Text>;
  if (!evals.data) return <Loading rows={1} />;
  return (
    <Stack>
      {evals.data.latest ? (
        <Group gap="xs">
          <Badge color="teal" variant="light">{evals.data.latest.passed} passed</Badge>
          <Badge color={evals.data.latest.failed ? 'red' : 'gray'} variant="light">{evals.data.latest.failed} failed</Badge>
          <Text size="xs" c="dimmed">{relative(evals.data.latest.ranAt)} · {evals.data.latest.triggeredBy}</Text>
        </Group>
      ) : <Text size="sm" c="dimmed">Never scored. A role with fewer than five references is unscored, not passing (F17.2).</Text>}
      {evals.data.cases.length > 0 && (
        <Table verticalSpacing={6}>
          <Table.Tbody>
            {evals.data.cases.map((one) => (
              <Table.Tr key={one.id}>
                <Table.Td><Text size="sm">{one.name}</Text></Table.Td>
                <Table.Td><Badge size="sm" variant="light" color={one.polarity === 'negative' ? 'red' : 'teal'}>{one.polarity}</Badge></Table.Td>
                <Table.Td ta="right">
                  {one.accepted ? <Badge size="sm" variant="outline" color="gray">accepted</Badge> : (
                    <ActionButton size="xs" variant="light" label="Accept" run={() => api('POST', `/api/companies/${companyId}/evals/${one.id}/accept`, {})} done={evals.reload} />
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Divider label="Request a change, scored before you decide (F17.3)" labelPosition="left" />
      <ActionForm
        columns={1}
        fields={[
          { name: 'change', label: 'What changes', type: 'select', required: true, options: [
            { value: 'charter', label: 'Charter' }, { value: 'skills', label: 'Skills' }, { value: 'model_routing', label: 'Model routing' },
          ] },
          { name: 'summary', label: 'What and why', type: 'textarea', required: true },
        ]}
        submit={async (values) => {
          const answer: { score: { passed: number; failed: number } } =
            await api('POST', `/api/companies/${companyId}/roles/${role.id}/change-request`, { ...values, tools: [] });
          setAsked(`Filed in your decisions. It scored ${answer.score.passed} passed, ${answer.score.failed} failed.`);
        }}
        action="Request the change"
        done={() => undefined}
      />
      {asked && <Alert color="blue" variant="light">{asked}</Alert>}
    </Stack>
  );
}

/* -------------------------------------------------------- division drawer --- */

function DivisionDrawer({
  companyId, division, structure, close, changed,
}: { companyId: string; division: Division | null; structure: Structure; close: () => void; changed: () => void }) {
  const [health, setHealth] = useState<Array<{ capabilityName: string; status: string; detail: string; checkedAt: string }> | null>(null);
  const roles = structure.roles.filter((role) => role.divisionId === division?.id);
  const readHealth = async () => {
    if (!division) return;
    const answer: { health: Array<{ capabilityName: string; status: string; detail: string; checkedAt: string }> } =
      await api('GET', `/api/companies/${companyId}/divisions/${division.id}/health`);
    setHealth(answer.health);
  };
  return (
    <Drawer opened={division !== null} onClose={() => { setHealth(null); close(); }} position="right" size="xl" title={<Text fw={700}>{division?.name}</Text>}>
      {division && (
        <Stack gap="lg">
          <SimpleGrid cols={3} spacing="sm">
            <Mini label="Roles" value={String(roles.length)} />
            <Mini label="Open tasks" value={String(division.openTasks)} />
            <Mini label="At once" value={String(division.maxConcurrency)} />
          </SimpleGrid>

          <Section title="Capabilities it may use" description="A grant may tighten a tier and never loosen it; the database is what says so (F8.3).">
            <Group gap={6}>
              {division.grants.length === 0 && <Text size="sm" c="dimmed">None.</Text>}
              {division.grants.map((grant) => (
                <Badge key={grant.capability} variant="light" color={grant.tier === null ? 'gray' : ['gray', 'blue', 'orange', 'red'][grant.tier]} radius="sm">
                  {grant.capability}{grant.tier !== null ? ` · T${grant.tier}` : ''}
                </Badge>
              ))}
            </Group>
          </Section>

          <Accordion variant="separated" radius="md">
            <Accordion.Item value="grant">
              <Accordion.Control>Change a grant</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  fields={[
                    { name: 'capabilityName', label: 'Capability', required: true, placeholder: 'email.send' },
                    { name: 'tierOverride', label: 'Tier', type: 'select', description: 'Blank revokes the grant', options: [
                      { value: '0', label: 'Tier 0 · read only' }, { value: '1', label: 'Tier 1 · cheap to undo' },
                      { value: '2', label: 'Tier 2 · costly' }, { value: '3', label: 'Tier 3 · irreversible' },
                    ] },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/structure/grant`, {
                    divisionId: division.id,
                    capabilityName: values.capabilityName,
                    ...(values.tierOverride === undefined ? { revoke: true } : { tierOverride: Number(values.tierOverride) }),
                    proof,
                  })}
                  factor={`Change a grant in ${division.name}`}
                  action="Apply"
                  success="Grant changed."
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="escalation">
              <Accordion.Control>Who hears about trouble first</Accordion.Control>
              <Accordion.Panel>
                <Text size="sm" c="dimmed" mb="sm">
                  Now: {division.escalationRole ? `${division.escalationRole}, for ${division.escalateAfterMinutes ?? 240} minutes, then you` : 'straight to you'} (F2.6).
                </Text>
                <ActionForm
                  fields={[
                    { name: 'roleSlug', label: 'Escalate to', type: 'select', description: 'Blank sends it straight to you',
                      options: roles.map((role) => ({ value: role.slug, label: role.slug })), initial: division.escalationRole },
                    { name: 'afterMinutes', label: 'Then you, after (minutes)', type: 'number', initial: division.escalateAfterMinutes },
                  ]}
                  submit={(values) => api('POST', `/api/companies/${companyId}/divisions/${division.id}/escalation`, {
                    roleSlug: values.roleSlug === undefined ? null : values.roleSlug,
                    ...(values.afterMinutes === undefined ? {} : { afterMinutes: values.afterMinutes }),
                  })}
                  success="Escalation policy saved."
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="health">
              <Accordion.Control>Capability health</Accordion.Control>
              <Accordion.Panel>
                <Button variant="light" onClick={() => void readHealth()} mb="sm">Read the last check</Button>
                {health && (health.length === 0 ? <Text size="sm" c="dimmed">Nothing checked yet.</Text> : (
                  <Table verticalSpacing={6}>
                    <Table.Tbody>
                      {health.map((row) => (
                        <Table.Tr key={row.capabilityName}>
                          <Table.Td><Text size="sm">{row.capabilityName}</Text></Table.Td>
                          <Table.Td><Badge size="sm" color={row.status === 'healthy' ? 'teal' : 'red'} variant="light">{row.status}</Badge></Table.Td>
                          <Table.Td><Text size="xs" c="dimmed">{row.detail}</Text></Table.Td>
                          <Table.Td><Text size="xs" c="dimmed">{dateTime(row.checkedAt)}</Text></Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                ))}
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="rotate">
              <Accordion.Control>Rotate a credential</Accordion.Control>
              <Accordion.Panel>
                <Text size="sm" c="dimmed" mb="sm">The answer to “that token leaked”. Effective on the next call, no restart (F12.3).</Text>
                <ActionForm
                  fields={[
                    { name: 'alias', label: 'Credential alias', required: true },
                    { name: 'newSecretRef', label: 'New reference', description: 'Blank keeps the same path' },
                  ]}
                  submit={async (values, proof) => {
                    const rotated: { alias: string; version: number } = await api(
                      'POST', `/api/companies/${companyId}/divisions/${division.id}/credentials/${values.alias}/rotate`,
                      { ...(values.newSecretRef === undefined ? {} : { newSecretRef: values.newSecretRef }), proof },
                    );
                    notifications.show({ color: 'teal', message: `${rotated.alias} is now version ${rotated.version}.` });
                  }}
                  factor="Rotate a credential"
                  action="Rotate"
                  done={() => undefined}
                />
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
        </Stack>
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------- goals --- */

function GoalLadder({ companyId, goals, changed }: { companyId: string; goals: Goal[]; changed: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const roots = goals.filter((goal) => goal.parentId === null);
  const childrenOf = (id: string) => goals.filter((goal) => goal.parentId === id);

  const renderGoal = (goal: Goal, depth: number): React.ReactNode => (
    <Box key={goal.id} pl={depth * 28}>
      <Paper withBorder radius="md" p="sm" mb="xs" className="org-node" onClick={() => setEditing(goal)}>
        <Group justify="space-between" wrap="nowrap">
          <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
            <ThemeIcon variant="light" radius="xl" color={goal.kind === 'mission' ? 'violet' : goal.kind === 'objective' ? 'blue' : 'teal'}>
              {goal.kind === 'mission' ? <IconFlag size={16} /> : <IconTarget size={16} />}
            </ThemeIcon>
            <div style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{goal.kind.replace('_', ' ')}</Text>
              <Text size="sm" fw={600}>{goal.statement}</Text>
            </div>
          </Group>
          <Badge color={goal.status === 'active' ? 'blue' : goal.status === 'met' ? 'teal' : 'gray'} variant="light">{goal.status}</Badge>
        </Group>
      </Paper>
      {childrenOf(goal.id).map((child) => renderGoal(child, depth + 1))}
    </Box>
  );

  return (
    <Section
      title="The goal ladder"
      description="A mission, the objectives under it, and the key results under those. Agents read it; only you change it (F2.7, F3.10)."
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>Add a goal</Button>}
    >
      {roots.length === 0 ? <Text size="sm" c="dimmed">No goals yet.</Text> : roots.map((goal) => renderGoal(goal, 0))}

      <Modal opened={adding} onClose={() => setAdding(false)} title="Add a goal" centered size="lg">
        <ActionForm
          fields={[
            { name: 'kind', label: 'Kind', type: 'select', required: true, options: [
              { value: 'mission', label: 'Mission' }, { value: 'objective', label: 'Objective' }, { value: 'key_result', label: 'Key result' },
            ] },
            { name: 'slug', label: 'Short name', required: true, placeholder: 'grow-revenue' },
            { name: 'parentGoalId', label: 'Under', type: 'select', options: goals.map((goal) => ({ value: goal.id, label: `${goal.kind.replace('_', ' ')}: ${goal.statement}` })), wide: true },
            { name: 'statement', label: 'Statement', type: 'textarea', required: true },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/goals`, values)}
          action="Add it"
          success="Goal added."
          done={() => { setAdding(false); changed(); }}
        />
      </Modal>
      <GoalEditor companyId={companyId} goal={editing} close={() => setEditing(null)} changed={changed} />
    </Section>
  );
}

function GoalEditor({ companyId, goal, close, changed }: { companyId: string; goal: Goal | null; close: () => void; changed: () => void }) {
  const detail = useLoad(async () => {
    if (!goal) return null;
    const answer: { kind: string; slug: string; status: string; statement: string; parentGoalId: string | null } =
      await api('GET', `/api/companies/${companyId}/goals/${goal.id}`);
    return answer;
  }, [companyId, goal?.id]);
  return (
    <Modal opened={goal !== null} onClose={close} title="Change a goal" centered size="lg">
      {goal && (
        <Stack>
          {detail.data && <Text size="sm" c="dimmed">{detail.data.kind.replace('_', ' ')} · {detail.data.slug} · {detail.data.status}</Text>}
          <ActionForm
            columns={1}
            fields={[
              { name: 'statement', label: 'Statement', type: 'textarea', initial: goal.statement },
              { name: 'status', label: 'Status', type: 'select', initial: goal.status, options: [
                { value: 'active', label: 'Active' }, { value: 'met', label: 'Met' }, { value: 'abandoned', label: 'Abandoned' },
              ] },
            ]}
            submit={(values, proof) => api('POST', `/api/companies/${companyId}/goals/${goal.id}`, { ...values, proof })}
            factor="Change a goal"
            action="Change it"
            success="Goal changed."
            done={() => { close(); changed(); }}
          />
        </Stack>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- schedules --- */

const ZONES = ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

function Schedules({
  companyId, structure, schedules, changed,
}: { companyId: string; structure: Structure; schedules: Schedule[]; changed: () => void }) {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      title="Schedules"
      description="Durable cron in the schedule's own time zone (F9.1). A schedule whose last five runs said the same thing asks you whether it is still worth running."
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>New schedule</Button>}
      padding="lg"
    >
      {schedules.length === 0 ? <Text size="sm" c="dimmed">No schedules.</Text> : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr><Table.Th>Schedule</Table.Th><Table.Th>When</Table.Th><Table.Th>Role</Table.Th><Table.Th>Next</Table.Th><Table.Th>State</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.map((schedule) => (
                <Table.Tr key={schedule.id}>
                  <Table.Td><Text size="sm" fw={600}>{schedule.slug}</Text><Text size="xs" c="dimmed">P{schedule.priority}</Text></Table.Td>
                  <Table.Td><Text size="sm" ff="monospace">{schedule.cron}</Text><Text size="xs" c="dimmed">{schedule.timezone}</Text></Table.Td>
                  <Table.Td><Text size="sm">{schedule.roleSlug}</Text><Text size="xs" c="dimmed">{schedule.divisionName}</Text></Table.Td>
                  <Table.Td><Text size="sm">{relative(schedule.nextRunAt)}</Text></Table.Td>
                  <Table.Td>
                    {schedule.failure ? <Tooltip label={schedule.failure}><Badge color="red" variant="light">Cannot fire</Badge></Tooltip>
                      : schedule.enabled ? <Badge color="teal" variant="light">On</Badge> : <Badge color="gray" variant="light">Off</Badge>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={adding} onClose={() => setAdding(false)} title="New schedule" centered size="lg">
        <ActionForm
          fields={[
            { name: 'roleId', label: 'Role', type: 'select', required: true, options: structure.roles.map((role) => ({
              value: role.id, label: `${role.slug} · ${structure.divisions.find((d) => d.id === role.divisionId)?.name ?? ''}`,
            })) },
            { name: 'projectId', label: 'Project', type: 'select', required: true, initial: structure.projects[0]?.id ?? null,
              options: structure.projects.map((project) => ({ value: project.id, label: project.name })) },
            { name: 'slug', label: 'Short name', required: true, placeholder: 'weekly-invoices' },
            { name: 'cronExpression', label: 'Cron', required: true, placeholder: '0 3 * * *', description: 'minute hour day month weekday' },
            { name: 'timezone', label: 'Time zone', type: 'select', initial: 'UTC', options: ZONES.map((zone) => ({ value: zone, label: zone })) },
            { name: 'priority', label: 'Priority', type: 'select', initial: '2', options: [
              { value: '0', label: 'P0 · first' }, { value: '1', label: 'P1' }, { value: '2', label: 'P2 · normal' }, { value: '3', label: 'P3 · last' },
            ] },
          ]}
          submit={(values) => {
            const role = structure.roles.find((one) => one.id === values.roleId);
            return api('POST', `/api/companies/${companyId}/schedules`, {
              ...values,
              divisionId: role?.divisionId,
              ...(values.priority === undefined ? {} : { priority: Number(values.priority) }),
            });
          }}
          action="Schedule it"
          success="Scheduled."
          done={() => { setAdding(false); changed(); }}
        />
      </Modal>
    </Section>
  );
}

/* ---------------------------------------------------------------- policies --- */

function Policies({ companyId }: { companyId: string }) {
  const requireFactor = useFactor();
  const [slug, setSlug] = useState('');
  const [effect, setEffect] = useState<string | null>('require_approval');
  const [condition, setCondition] = useState('{\n  "capability": "email.send"\n}');
  const [error, setError] = useState<string | null>(null);

  const write = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(condition);
    } catch {
      setError('The condition is not valid JSON.');
      return;
    }
    try {
      const done = await requireFactor('Write the policy', (proof) => api('POST', '/api/policies', {
        slug, effect, companyId, condition: parsed, proof,
      }));
      if (done) notifications.show({ color: 'teal', message: `Policy ${slug} written.` });
    } catch (failure) {
      setError((failure as Error).message);
    }
  };

  return (
    <Section title="Write a policy" description="The condition is JSON and the engine validates it (F3.4). A lower scope may only tighten what a broader one set (F3.5).">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Short name" value={slug} onChange={(event) => setSlug(event.currentTarget.value)} required />
          <Select label="Effect" value={effect} onChange={setEffect} data={[
            { value: 'allow', label: 'Allow' }, { value: 'require_review', label: 'Require a review' },
            { value: 'require_approval', label: 'Require your approval' }, { value: 'deny', label: 'Deny' },
          ]} required />
        </SimpleGrid>
        <Textarea label="Condition" autosize minRows={4} ff="monospace" value={condition} onChange={(event) => setCondition(event.currentTarget.value)} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group><Button disabled={!slug || !effect} onClick={() => void write()}>Write it</Button></Group>
      </Stack>
    </Section>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" px="sm" py={8}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" fw={700}>{value}</Text>
    </Paper>
  );
}
