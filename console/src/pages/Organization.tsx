/**
 * The company's shape (F2, F2.7, F3): the goal ladder it works towards, its
 * divisions and the roles in them, its schedules and its policies. Every
 * change is made from the thing it changes -- a role's charter from the role,
 * a division's grants from the division -- instead of from a form that asks
 * which one by id.
 */
import { useState } from 'react';
import {
  Accordion, Alert, Avatar, Badge, Box, Button, Card, Divider, Drawer, Group, List, Modal, Paper, Progress, Select, SimpleGrid, Spoiler, Stack, Table, Tabs, Text, TextInput, Textarea, ThemeIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsRight, IconCalendarTime, IconFlag, IconPlus, IconShieldCheck, IconTarget, IconUserCircle, IconUsersGroup, IconWebhook,
} from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Division, Goal, PolicyRow, Role, Schedule, Structure } from '../types.ts';
import { count, dateTime, goalKind, money, relative } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { N, t } from '../i18n.ts';
import { LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';
import { AssignWork } from '../components/AssignWork.tsx';
import { GoalMetrics } from '../components/Metrics.tsx';
import { Triggers } from '../components/Triggers.tsx';
import { Handoffs } from '../components/Handoffs.tsx';
import { ConfigHistory } from '../components/ConfigHistory.tsx';
import { companyEmblem, rolePicture } from '../images.ts';

export function Organization({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [structure, schedules]: [Structure, { schedules: Schedule[] }] = await Promise.all([
      api('GET', `/api/companies/${companyId}/structure`),
      api('GET', `/api/companies/${companyId}/schedules`),
    ]);
    return { structure, schedules: schedules.schedules };
  }, [companyId], { every: 30_000 });
  const [role, setRole] = useState<Role | null>(null);
  const [division, setDivision] = useState<Division | null>(null);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Team')}
      description={t('Who does the work: divisions and the roles in them, the goals they work towards, their schedules and the policies they work under.')}
      live={view.updatedAt}
      actions={<Button leftSection={<IconPlus size={16} />} onClick={ctx.giveWork}>{t('Give work')}</Button>}
    />
  );
  if (view.error && !view.data) return <>{header}<LoadFailed message={view.error} retry={view.reload} /></>;
  if (!view.data) return <>{header}<Loading rows={5} /></>;
  const { structure, schedules } = view.data;
  const openRole = role ? structure.roles.find((one) => one.id === role.id) ?? null : null;
  const openDivision = division ? structure.divisions.find((one) => one.id === division.id) ?? null : null;

  return (
    <Stack gap="lg">
      {header}

      <Tabs defaultValue="chart" keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab value="chart" leftSection={<IconUsersGroup size={16} />}>{t('Divisions & roles')}</Tabs.Tab>
          <Tabs.Tab value="goals" leftSection={<IconTarget size={16} />}>{t('Goals')}</Tabs.Tab>
          <Tabs.Tab value="schedules" leftSection={<IconCalendarTime size={16} />}>{t('Schedules')}</Tabs.Tab>
          <Tabs.Tab value="handoffs" leftSection={<IconArrowsRight size={16} />}>{t('Handoffs')}</Tabs.Tab>
          <Tabs.Tab value="triggers" leftSection={<IconWebhook size={16} />}>{t('Triggers')}</Tabs.Tab>
          <Tabs.Tab value="policies" leftSection={<IconShieldCheck size={16} />}>{t('Policies')}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="chart">
          <Grow companyId={companyId} structure={structure} changed={view.reload} />
          <OrgChart structure={structure} company={ctx.company} openRole={setRole} openDivision={setDivision} />
        </Tabs.Panel>
        <Tabs.Panel value="goals">
          <GoalLadder companyId={companyId} goals={structure.goals} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="schedules">
          <Schedules companyId={companyId} structure={structure} schedules={schedules} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="handoffs">
          <Handoffs companyId={companyId} structure={structure} />
        </Tabs.Panel>
        <Tabs.Panel value="triggers">
          <Triggers companyId={companyId} structure={structure} />
        </Tabs.Panel>
        <Tabs.Panel value="policies">
          <Policies companyId={companyId} />
        </Tabs.Panel>
      </Tabs>

      <RoleDrawer companyId={companyId} role={openRole} structure={structure} close={() => setRole(null)} changed={view.reload} />
      <DivisionDrawer companyId={companyId} division={openDivision} structure={structure} close={() => setDivision(null)} changed={view.reload} />
    </Stack>
  );
}

/* ------------------------------------------------------------- growing it --- */

/**
 * Hiring a role, opening a division, starting a project (F2.9). The first two
 * change what the company can do and take the owner's device; a project only
 * groups work. A hire whose tools its division has no grant for is made, and
 * the owner is told which ones, rather than refused: granting them is the
 * next thing they will do, from the division.
 */
function Grow({ companyId, structure, changed }: { companyId: string; structure: Structure; changed: () => void }) {
  const [open, setOpen] = useState<'role' | 'division' | 'project' | null>(null);
  const list = (value: string | number | undefined, separator: RegExp) =>
    String(value ?? '').split(separator).map((part) => part.trim()).filter(Boolean);
  const done = (message: string) => () => {
    setOpen(null);
    notifications.show({ color: 'teal', message });
    changed();
  };
  return (
    <>
      <Group justify="flex-end" gap="xs" mb="md">
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setOpen('project')}>{t('New project')}</Button>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setOpen('division')}>{t('New division')}</Button>
        <Button size="xs" leftSection={<IconUserCircle size={14} />} onClick={() => setOpen('role')}>{t('Hire a role')}</Button>
      </Group>

      <Modal opened={open === 'role'} onClose={() => setOpen(null)} title={t('Hire a role')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'divisionId', label: t('Division'), type: 'select', required: true,
              options: structure.divisions.map((division) => ({ value: division.id, label: division.name })) },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'content-writer' },
            { name: 'systemPrompt', label: t('What the role is for'), type: 'textarea', required: true, wide: true,
              placeholder: t('e.g. You write the words customers read: product pages and newsletters. Draft first; nothing goes out without review.') },
            { name: 'tools', label: t('Tools'), wide: true, placeholder: 'doc.draft',
              description: t('Capabilities, separated by commas; at most twelve. It can use only those its division is granted.') },
            { name: 'doneCriteria', label: t('How to know it is done'), type: 'textarea', required: true, wide: true,
              description: t('One per line. Work is checked against these before it counts as finished.'),
              placeholder: t('e.g. every claim about the product is one the product page makes') },
          ]}
          factor={t('Hire a role')}
          submit={async (values, proof) => {
            const hired: { roleId: string; ungranted: string[] } = await api('POST', `/api/companies/${companyId}/roles`, {
              divisionId: values.divisionId, slug: values.slug, systemPrompt: values.systemPrompt,
              tools: list(values.tools, /,/), doneCriteria: list(values.doneCriteria, /\n/), proof,
            });
            if (hired.ungranted.length > 0) {
              notifications.show({
                color: 'orange',
                message: t('Its division has no grant yet for {tools}. Open the division to grant them.', { tools: hired.ungranted.join(', ') }),
              });
            }
            return hired;
          }}
          action={t('Hire')}
          done={done(t('Hired. It can be given work now.'))}
        />
      </Modal>

      <Modal opened={open === 'division'} onClose={() => setOpen(null)} title={t('New division')} centered>
        <ActionForm
          columns={1}
          fields={[
            { name: 'name', label: t('Name'), required: true, placeholder: t('e.g. Sales') },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'field-sales' },
            { name: 'parentDivisionId', label: t('Inside'), type: 'select',
              description: t('Leave empty for a division of its own. Divisions go two levels deep at most.'),
              options: structure.divisions.filter((division) => division.parentId === null).map((division) => ({ value: division.id, label: division.name })) },
            { name: 'maxConcurrency', label: t('Runs at once, at most'), type: 'number', initial: 4 },
          ]}
          factor={t('Open a division')}
          submit={(values, proof) => api('POST', `/api/companies/${companyId}/divisions`, { ...values, proof })}
          action={t('Open it')}
          done={done(t('The division is open. It can read its own memory and skills; grant it anything else from the division.'))}
        />
      </Modal>

      <Modal opened={open === 'project'} onClose={() => setOpen(null)} title={t('New project')} centered>
        <ActionForm
          columns={1}
          fields={[
            { name: 'name', label: t('Name'), required: true, placeholder: t('e.g. Wholesale') },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'wholesale-2026' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/projects`, values)}
          action={t('Start it')}
          done={done(t('The project is started. Work given to the company can be put in it.'))}
        />
      </Modal>
    </>
  );
}

/* --------------------------------------------------------------- the chart --- */

function OrgChart({
  structure, company, openRole, openDivision,
}: {
  structure: Structure;
  company: { id: string; name: string };
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
            <Avatar radius="md" size={40} src={companyEmblem(company)} alt="" />
            <div>
              <Text fw={800}>{company.name}</Text>
              <Text size="xs" c="dimmed">{t('{divisions} divisions · {roles} roles · you own it', { divisions: structure.divisions.length, roles: structure.roles.length })}</Text>
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

const GOAL_STATUS: Record<string, string> = { active: N('Active'), met: N('Met'), abandoned: N('Abandoned') };

function goalStatus(status: string): string {
  const label = GOAL_STATUS[status];
  return label ? t(label) : status;
}

function roleState(role: Role): { label: string; color: string } {
  if (role.frozenAt) return { label: t('Frozen'), color: 'red' };
  if (role.openTasks > 0) return { label: t('Working'), color: 'teal' };
  if (role.dormantUntil && new Date(role.dormantUntil) > new Date()) return { label: t('Asleep'), color: 'gray' };
  return { label: t('Idle'), color: 'gray' };
}

function DivisionCard({
  division, roles, openRole, openDivision,
}: { division: Division; roles: Role[]; openRole: (role: Role) => void; openDivision: (division: Division) => void }) {
  return (
    <Card withBorder radius="md" shadow="xs" padding="md" className="org-node">
      <Group justify="space-between" onClick={() => openDivision(division)} style={{ cursor: 'pointer' }} wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Text fw={700} truncate>{division.name}</Text>
          <Text size="xs" c="dimmed">{t('{count} capabilities · up to {max} at once', { count: division.grants.length, max: division.maxConcurrency })}</Text>
        </div>
        {division.openTasks > 0 ? <Badge color="teal" variant="light">{t('{count} open', { count: division.openTasks })}</Badge> : <Badge color="gray" variant="light">{t('quiet')}</Badge>}
      </Group>
      <Divider my="sm" />
      <Stack gap={6}>
        {roles.length === 0 && <Text size="xs" c="dimmed">{t('No roles.')}</Text>}
        {roles.map((role) => {
          const state = roleState(role);
          return (
            <Paper key={role.id} withBorder radius="md" px="sm" py={8} className="org-node" onClick={() => openRole(role)}>
              <Group gap="sm" wrap="nowrap">
                <Avatar size={34} radius="xl" src={rolePicture(role.slug)} alt="" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text size="sm" fw={600} truncate>{role.slug}</Text>
                  <Text size="xs" c="dimmed" truncate>{role.model}{role.runtime ? ` · ${role.runtime}` : ''}</Text>
                </div>
                <Tooltip label={role.frozenReason ?? t('{open} open · {done} done this week', { open: role.openTasks, done: role.doneLastWeek })}>
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

interface RuntimeRow { name: string; backends: string[]; ok: boolean; detail?: string }

/**
 * Which runtime does the role's work, and the ones it could be moved to.
 *
 * Each with whether it answers now: a role moved onto a runtime that does not
 * answer gets no work (F13.8), so the owner sees that before choosing it.
 */
function RoleRuntime({ companyId, role, changed }: { companyId: string; role: Role; changed: () => void }) {
  const runtimes = useLoad(async () => ((await api('GET', '/api/runtimes')) as { runtimes: RuntimeRow[] }).runtimes, []);
  if (runtimes.error) return <LoadFailed message={runtimes.error} retry={runtimes.reload} />;
  if (!runtimes.data) return <Loading rows={1} />;
  const current = runtimes.data.find((runtime) => runtime.name === role.runtime);
  return (
    <Stack gap="sm">
      <Text size="sm">
        {current
          ? current.ok
            ? t('{runtime} does its work, and answers now.', { runtime: current.name })
            : t('{runtime} does its work, and is not answering: {detail}', { runtime: current.name, detail: current.detail ?? t('no detail') })
          : t('Its runtime, {runtime}, does not run here, so it cannot work until it is moved to one that does.', { runtime: role.runtime ?? t('none') })}
      </Text>
      {runtimes.data.length === 0 ? (
        <Text size="sm" c="dimmed">{t('No runtime runs here yet. Setting a model key in the deployment gives every role one.')}</Text>
      ) : (
        <ActionForm
          columns={1}
          fields={[{
            name: 'runtime',
            label: t('Move it to'),
            type: 'select',
            required: true,
            initial: role.runtime,
            options: runtimes.data.map((runtime) => ({
              value: runtime.name,
              label: runtime.ok ? runtime.name : t('{runtime} (not answering)', { runtime: runtime.name }),
            })),
          }]}
          submit={(values, proof) => api('POST', `/api/companies/${companyId}/roles/${role.id}`, { ...values, proof })}
          factor={t('Move {role} to another runtime', { role: role.slug })}
          action={t('Move it')}
          success={t('Role moved.')}
          done={changed}
        />
      )}
    </Stack>
  );
}

function RoleDrawer({
  companyId, role, structure, close, changed,
}: { companyId: string; role: Role | null; structure: Structure; close: () => void; changed: () => void }) {
  const division = structure.divisions.find((one) => one.id === role?.divisionId);
  return (
    <Drawer opened={role !== null} onClose={close} position="right" size="xl" title={
      <Group gap="sm" wrap="nowrap">
        {role && <Avatar size={40} radius="xl" src={rolePicture(role.slug)} alt="" />}
        <Text fw={700}>{role?.slug}</Text>
      </Group>
    }>
      {role && division && (
        <Stack gap="lg">
          <Group gap="xs">
            <Badge variant="light">{division.name}</Badge>
            <Badge variant="dot" color={roleState(role).color}>{roleState(role).label}</Badge>
            <Badge variant="outline" color="gray">{role.model}</Badge>
            {role.runtime && <Badge variant="outline" color="gray">{role.runtime}</Badge>}
            {!role.frozenAt && (
              <ActionButton
                size="xs"
                variant="subtle"
                color="orange"
                label={t('Pause this role')}
                run={() => api('POST', `/api/control/company/${companyId}/role/${role.id}/pause`, {})}
                done={() => {
                  notifications.show({ color: 'orange', message: t('{role} paused. Nothing new starts for it until you resume it.', { role: role.slug }) });
                  changed();
                  close();
                }}
              />
            )}
          </Group>
          {role.frozenAt && (
            <Alert color="red" variant="light" title={t('Frozen')}>
              <Text size="sm">{role.frozenReason ?? t('Repeatedly denied.')} {t('It stays frozen until you look.')}</Text>
              <Group mt="sm">
                <ActionButton
                  label={t('Resume this role')}
                  color="red"
                  variant="light"
                  factor={t('Resume {role}', { role: role.slug })}
                  run={(proof) => api('POST', `/api/control/company/${companyId}/role/${role.id}/resume`, { proof })}
                  done={() => { notifications.show({ color: 'teal', message: t('{role} resumed.', { role: role.slug }) }); changed(); close(); }}
                />
              </Group>
            </Alert>
          )}
          <SimpleGrid cols={3} spacing="sm">
            <Mini label={t('Open tasks')} value={String(role.openTasks)} />
            <Mini label={t('Done this week')} value={String(role.doneLastWeek)} />
            <Mini label={t('Heartbeat')} value={role.heartbeatMinutes ? t('{minutes} min', { minutes: role.heartbeatMinutes }) : t('Default')} />
          </SimpleGrid>
          <Paper withBorder radius="md" p="md">
            <Group gap={6} mb={6}><IconUserCircle size={16} /><Text size="xs" fw={700} tt="uppercase" c="dimmed">{t('Who it is')}</Text></Group>
            <Text size="xs" c="dimmed" mb="xs">{t('Its charter: the persona and rules it is given first in every run, before anything it reads.')}</Text>
            {role.charter.trim() ? (
              <Spoiler maxHeight={120} showLabel={t('Show all')} hideLabel={t('Show less')}>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{role.charter}</Text>
              </Spoiler>
            ) : <Text size="sm" c="dimmed">{t('No charter yet. It works from the company charter alone.')}</Text>}
            {role.doneCriteria.length > 0 && (
              <>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mt="md" mb={6}>{t('Done means')}</Text>
                <List size="sm" spacing={4}>
                  {role.doneCriteria.map((criterion) => <List.Item key={criterion}>{criterion}</List.Item>)}
                </List>
              </>
            )}
          </Paper>
          <div>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={6}>{t('Tools')}</Text>
            <Group gap={6}>{role.tools.length === 0 ? <Text size="sm" c="dimmed">{t('None')}</Text> : role.tools.map((tool) => <Badge key={tool} variant="light" color="gray" radius="sm">{tool}</Badge>)}</Group>
          </div>

          <Accordion variant="separated" radius="md" defaultValue="work">
            <Accordion.Item value="work">
              <Accordion.Control>{t('Give it something to do')}</Accordion.Control>
              <Accordion.Panel>
                <AssignWork companyId={companyId} structure={structure} roleId={role.id} done={changed} />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="budget">
              <Accordion.Control>{t('What funds it')}</Accordion.Control>
              <Accordion.Panel><RoleBudget companyId={companyId} role={role} /></Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="runtime">
              <Accordion.Control>{t('Who does its work')}</Accordion.Control>
              <Accordion.Panel><RoleRuntime companyId={companyId} role={role} changed={changed} /></Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="change">
              <Accordion.Control>{t('Change its charter or model')}</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  columns={1}
                  fields={[
                    { name: 'systemPrompt', label: t('Charter'), type: 'textarea', description: t('Blank keeps the current one') },
                    { name: 'modelPrimary', label: t('Primary model'), initial: role.model },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/roles/${role.id}`, { ...values, proof })}
                  factor={t('Change {role}', { role: role.slug })}
                  action={t('Change it')}
                  success={t('Role changed.')}
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="evals">
              <Accordion.Control>{t('Eval set and change requests')}</Accordion.Control>
              <Accordion.Panel><RoleEvals companyId={companyId} role={role} /></Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="history">
              <Accordion.Control>{t('History')}</Accordion.Control>
              <Accordion.Panel><ConfigHistory companyId={companyId} kind="role" subjectId={role.id} changed={changed} /></Accordion.Panel>
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
      <Mini label={t('Tokens')} value={t('{spent} of {max}', { spent: count(budget.data.snapshot.tokensSpent), max: count(budget.data.snapshot.tokensMax) })} />
      {budget.data.snapshot.moneyMaxCents !== undefined && (
        <Mini label={t('Money')} value={t('{spent} of {max}', { spent: money(budget.data.snapshot.moneySpentCents ?? 0), max: money(budget.data.snapshot.moneyMaxCents) })} />
      )}
      <Paper withBorder radius="md" p="sm" style={{ gridColumn: '1 / -1' }}>
        <Text size="xs" c="dimmed">{t('Rolls up through')}</Text>
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
      ) : <Text size="sm" c="dimmed">{t('Never scored. A role with fewer than five references is unscored, not passing.')}</Text>}
      {evals.data.cases.length > 0 && (
        <Table verticalSpacing={6}>
          <Table.Tbody>
            {evals.data.cases.map((one) => (
              <Table.Tr key={one.id}>
                <Table.Td><Text size="sm">{one.name}</Text></Table.Td>
                <Table.Td><Badge size="sm" variant="light" color={one.polarity === 'negative' ? 'red' : 'teal'}>{one.polarity}</Badge></Table.Td>
                <Table.Td ta="right">
                  {one.accepted ? <Badge size="sm" variant="outline" color="gray">{t('accepted')}</Badge> : (
                    <ActionButton size="xs" variant="light" label={t('Accept')} run={() => api('POST', `/api/companies/${companyId}/evals/${one.id}/accept`, {})} done={evals.reload} />
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      <Divider label={t('Request a change, scored before you decide')} labelPosition="left" />
      <ActionForm
        columns={1}
        fields={[
          { name: 'change', label: t('What changes'), type: 'select', required: true, options: [
            { value: 'charter', label: t('Charter') }, { value: 'skills', label: t('Skills') }, { value: 'model_routing', label: t('Model routing') },
          ] },
          { name: 'summary', label: t('What and why'), type: 'textarea', required: true },
        ]}
        submit={async (values) => {
          const answer: { score: { passed: number; failed: number } } =
            await api('POST', `/api/companies/${companyId}/roles/${role.id}/change-request`, { ...values, tools: [] });
          setAsked(t('Filed in your inbox. It scored {passed} passed, {failed} failed.', { passed: answer.score.passed, failed: answer.score.failed }));
        }}
        action={t('Request the change')}
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
            <Mini label={t('Roles')} value={String(roles.length)} />
            <Mini label={t('Open tasks')} value={String(division.openTasks)} />
            <Mini label={t('At once')} value={String(division.maxConcurrency)} />
          </SimpleGrid>

          <Section title={t('Capabilities it may use')} description={t('A grant may tighten a tier and never loosen it; the database is what says so.')}>
            <Group gap={6}>
              {division.grants.length === 0 && <Text size="sm" c="dimmed">{t('None.')}</Text>}
              {division.grants.map((grant) => (
                <Badge key={grant.capability} variant="light" color={grant.tier === null ? 'gray' : ['gray', 'blue', 'orange', 'red'][grant.tier]} radius="sm">
                  {grant.capability}{grant.tier !== null ? ` · T${grant.tier}` : ''}
                </Badge>
              ))}
            </Group>
          </Section>

          <Accordion variant="separated" radius="md">
            <Accordion.Item value="grant">
              <Accordion.Control>{t('Change a grant')}</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  fields={[
                    { name: 'capabilityName', label: t('Capability'), required: true, placeholder: 'email.send' },
                    { name: 'tierOverride', label: t('Tier'), type: 'select', description: t('Blank revokes the grant'), options: [
                      { value: '0', label: t('Tier 0 · read only') }, { value: '1', label: t('Tier 1 · cheap to undo') },
                      { value: '2', label: t('Tier 2 · costly') }, { value: '3', label: t('Tier 3 · irreversible') },
                    ] },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/structure/grant`, {
                    divisionId: division.id,
                    capabilityName: values.capabilityName,
                    ...(values.tierOverride === undefined ? { revoke: true } : { tierOverride: Number(values.tierOverride) }),
                    proof,
                  })}
                  factor={t('Change a grant in {division}', { division: division.name })}
                  action={t('Apply')}
                  success={t('Grant changed.')}
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="escalation">
              <Accordion.Control>{t('Who hears about trouble first')}</Accordion.Control>
              <Accordion.Panel>
                <Text size="sm" c="dimmed" mb="sm">
                  {division.escalationRole
                    ? t('Now: {role}, for {minutes} minutes, then you.', { role: division.escalationRole, minutes: division.escalateAfterMinutes ?? 240 })
                    : t('Now: straight to you.')}
                </Text>
                <ActionForm
                  fields={[
                    { name: 'roleSlug', label: t('Escalate to'), type: 'select', description: t('Blank sends it straight to you'),
                      options: roles.map((role) => ({ value: role.slug, label: role.slug })), initial: division.escalationRole },
                    { name: 'afterMinutes', label: t('Then you, after (minutes)'), type: 'number', initial: division.escalateAfterMinutes },
                  ]}
                  submit={(values) => api('POST', `/api/companies/${companyId}/divisions/${division.id}/escalation`, {
                    roleSlug: values.roleSlug === undefined ? null : values.roleSlug,
                    ...(values.afterMinutes === undefined ? {} : { afterMinutes: values.afterMinutes }),
                  })}
                  success={t('Escalation policy saved.')}
                  done={changed}
                />
              </Accordion.Panel>
            </Accordion.Item>
            <Accordion.Item value="health">
              <Accordion.Control>{t('Capability health')}</Accordion.Control>
              <Accordion.Panel>
                <Button variant="light" onClick={() => void readHealth()} mb="sm">{t('Read the last check')}</Button>
                {health && (health.length === 0 ? <Text size="sm" c="dimmed">{t('Nothing checked yet.')}</Text> : (
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
              <Accordion.Control>{t('Rotate a credential')}</Accordion.Control>
              <Accordion.Panel>
                <Text size="sm" c="dimmed" mb="sm">{t('The answer to “that token leaked”. Effective on the next call, no restart.')}</Text>
                <ActionForm
                  fields={[
                    { name: 'alias', label: t('Credential alias'), required: true },
                    { name: 'newSecretRef', label: t('New reference'), description: t('Blank keeps the same path') },
                  ]}
                  submit={async (values, proof) => {
                    const rotated: { alias: string; version: number } = await api(
                      'POST', `/api/companies/${companyId}/divisions/${division.id}/credentials/${values.alias}/rotate`,
                      { ...(values.newSecretRef === undefined ? {} : { newSecretRef: values.newSecretRef }), proof },
                    );
                    notifications.show({ color: 'teal', message: t('{alias} is now version {version}.', { alias: rotated.alias, version: rotated.version }) });
                  }}
                  factor={t('Rotate a credential')}
                  action={t('Rotate')}
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
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{goalKind(goal.kind)}</Text>
              <Text size="sm" fw={600}>{goal.statement}</Text>
            </div>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {goal.tasksTotal > 0 && (
              <Tooltip label={t('{done} of {total} tasks under it are done', { done: goal.tasksDone, total: goal.tasksTotal })}>
                <Group gap={6} wrap="nowrap" w={140} visibleFrom="sm">
                  <Progress value={(goal.tasksDone / goal.tasksTotal) * 100} size="sm" radius="xl" style={{ flex: 1 }} color={goal.tasksDone === goal.tasksTotal ? 'teal' : 'brand'} />
                  <Text size="xs" c="dimmed" className="tabular">{goal.tasksDone}/{goal.tasksTotal}</Text>
                </Group>
              </Tooltip>
            )}
            <Badge color={goal.status === 'active' ? 'brand' : goal.status === 'met' ? 'teal' : 'gray'} variant="light">{goalStatus(goal.status)}</Badge>
          </Group>
        </Group>
        {(goal.kind !== 'mission' || goal.metrics.length > 0) && (
          // The goal opens its editor on a click; recording a value or adding
          // a measure is its own action, including inside the modals it opens,
          // whose events still bubble through React to this card.
          <div onClick={(event) => event.stopPropagation()}>
            <GoalMetrics companyId={companyId} goal={goal} changed={changed} />
          </div>
        )}
      </Paper>
      {childrenOf(goal.id).map((child) => renderGoal(child, depth + 1))}
    </Box>
  );

  return (
    <Section
      title={t('The goal ladder')}
      description={t('A mission, the objectives under it, and the key results under those. Agents read it; only you change it.')}
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('Add a goal')}</Button>}
    >
      {roots.length === 0 ? <Text size="sm" c="dimmed">{t('No goals yet.')}</Text> : roots.map((goal) => renderGoal(goal, 0))}

      <Modal opened={adding} onClose={() => setAdding(false)} title={t('Add a goal')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'kind', label: t('Kind'), type: 'select', required: true, options: [
              { value: 'mission', label: t('Mission') }, { value: 'objective', label: t('Objective') }, { value: 'key_result', label: t('Key result') },
            ] },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'grow-revenue' },
            { name: 'parentGoalId', label: t('Under'), type: 'select', options: goals.map((goal) => ({ value: goal.id, label: `${goalKind(goal.kind)}: ${goal.statement}` })), wide: true },
            { name: 'statement', label: t('Statement'), type: 'textarea', required: true },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/goals`, values)}
          action={t('Add it')}
          success={t('Goal added.')}
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
    <Modal opened={goal !== null} onClose={close} title={t('Change a goal')} centered size="lg">
      {goal && (
        <Stack>
          {detail.data && <Text size="sm" c="dimmed">{goalKind(detail.data.kind)} · {detail.data.slug} · {goalStatus(detail.data.status)}</Text>}
          <ActionForm
            columns={1}
            fields={[
              { name: 'statement', label: t('Statement'), type: 'textarea', initial: goal.statement },
              { name: 'status', label: t('Status'), type: 'select', initial: goal.status, options: [
                { value: 'active', label: t('Active') }, { value: 'met', label: t('Met') }, { value: 'abandoned', label: t('Abandoned') },
              ] },
            ]}
            submit={(values, proof) => api('POST', `/api/companies/${companyId}/goals/${goal.id}`, { ...values, proof })}
            factor={t('Change a goal')}
            action={t('Change it')}
            success={t('Goal changed.')}
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
      title={t('Schedules')}
      description={t("Durable cron in the schedule's own time zone. A schedule whose last five runs said the same thing asks you whether it is still worth running.")}
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('New schedule')}</Button>}
      padding="lg"
    >
      {schedules.length === 0 ? <Text size="sm" c="dimmed">{t('No schedules.')}</Text> : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm" highlightOnHover>
            <Table.Thead>
              <Table.Tr><Table.Th>{t('Schedule')}</Table.Th><Table.Th>{t('When')}</Table.Th><Table.Th>{t('Role')}</Table.Th><Table.Th>{t('Next')}</Table.Th><Table.Th>{t('State')}</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.map((schedule) => (
                <Table.Tr key={schedule.id}>
                  <Table.Td><Text size="sm" fw={600}>{schedule.slug}</Text><Text size="xs" c="dimmed">P{schedule.priority}</Text></Table.Td>
                  <Table.Td><Text size="sm" ff="monospace">{schedule.cron}</Text><Text size="xs" c="dimmed">{schedule.timezone}</Text></Table.Td>
                  <Table.Td><Text size="sm">{schedule.roleSlug}</Text><Text size="xs" c="dimmed">{schedule.divisionName}</Text></Table.Td>
                  <Table.Td><Text size="sm">{relative(schedule.nextRunAt)}</Text></Table.Td>
                  <Table.Td>
                    {schedule.failure ? <Tooltip label={schedule.failure}><Badge color="red" variant="light">{t('Cannot fire')}</Badge></Tooltip>
                      : schedule.enabled ? <Badge color="teal" variant="light">{t('On')}</Badge> : <Badge color="gray" variant="light">{t('Off')}</Badge>}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={adding} onClose={() => setAdding(false)} title={t('New schedule')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'roleId', label: t('Role'), type: 'select', required: true, options: structure.roles.map((role) => ({
              value: role.id, label: `${role.slug} · ${structure.divisions.find((d) => d.id === role.divisionId)?.name ?? ''}`,
            })) },
            { name: 'projectId', label: t('Project'), type: 'select', required: true, initial: structure.projects[0]?.id ?? null,
              options: structure.projects.map((project) => ({ value: project.id, label: project.name })) },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'weekly-invoices' },
            { name: 'cronExpression', label: t('Cron'), required: true, placeholder: '0 3 * * *', description: t('minute hour day month weekday') },
            { name: 'timezone', label: t('Time zone'), type: 'select', initial: 'UTC', options: ZONES.map((zone) => ({ value: zone, label: zone })) },
            { name: 'priority', label: t('Priority'), type: 'select', initial: '2', options: [
              { value: '0', label: t('P0 · first') }, { value: '1', label: 'P1' }, { value: '2', label: t('P2 · normal') }, { value: '3', label: t('P3 · last') },
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
          action={t('Schedule it')}
          success={t('Scheduled.')}
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
  const [condition, setCondition] = useState('{\n  "field": "tool",\n  "op": "eq",\n  "value": "email.send"\n}');
  const [error, setError] = useState<string | null>(null);

  const write = async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(condition);
    } catch {
      setError(t('The condition is not valid JSON.'));
      return;
    }
    try {
      const done = await requireFactor(t('Write the policy'), (proof) => api('POST', '/api/policies', {
        slug, effect, companyId, condition: parsed, proof,
      }));
      if (done) notifications.show({ color: 'teal', message: t('Policy {slug} written.', { slug }) });
    } catch (failure) {
      setError(explain(failure));
    }
  };

  return (
    <Stack gap="lg">
    <PolicyList companyId={companyId} />
    <Section title={t('Write a policy')} description={t('The condition is JSON and the engine validates it. A lower scope may only tighten what a broader one set.')}>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label={t('Short name')} value={slug} onChange={(event) => setSlug(event.currentTarget.value)} required />
          <Select label={t('Effect')} value={effect} onChange={setEffect} data={[
            { value: 'allow', label: t('Allow') }, { value: 'require_review', label: t('Require a review') },
            { value: 'require_approval', label: t('Require your approval') }, { value: 'deny', label: t('Deny') },
          ]} required />
        </SimpleGrid>
        <Textarea
          label={t('Condition')}
          description={t('A field, a comparison and a value. Fields: tool, tier, division, money_cents, recipient_domain, url_host, hour_local, calls_in_window, stage. Comparisons: eq, ne, gt, gte, lt, lte, in, not_in, matches. Combine with "all", "any" and "not".')}
          autosize minRows={4} ff="monospace" value={condition} onChange={(event) => setCondition(event.currentTarget.value)}
        />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group><Button disabled={!slug || !effect} onClick={() => void write()}>{t('Write it')}</Button></Group>
      </Stack>
    </Section>
    </Stack>
  );
}

/** The rules the company works under, broadest first, each with its history (F3.5, F3.9). */
function PolicyList({ companyId }: { companyId: string }) {
  const view = useLoad(async () => {
    const answer: { policies: PolicyRow[] } = await api('GET', `/api/companies/${companyId}/policies`);
    return answer.policies;
  }, [companyId], { every: 30_000 });
  const [open, setOpen] = useState<PolicyRow | null>(null);
  const scopeLabel = (policy: PolicyRow) => policy.scope === 'platform' ? t('Platform')
    : policy.scope === 'company' ? t('Company') : t('Division {division}', { division: policy.division ?? '' });

  return (
    <Section title={t('Policies in force')} description={t('Broadest first. The platform\'s rules outrank the company\'s, and a narrower rule may only tighten a broader one.')} padding={0}>
      {view.error && !view.data ? <LoadFailed message={view.error} retry={view.reload} /> : !view.data ? <Loading rows={2} /> : view.data.length === 0 ? (
        <Text size="sm" c="dimmed" px="lg" pb="lg">{t('No policies. Tiers alone decide what needs you.')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm">
            <Table.Tbody>
              {view.data.map((policy) => (
                <Table.Tr key={policy.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>{policy.slug}</Text>
                    <Text size="xs" c="dimmed">{scopeLabel(policy)}{policy.mode === 'log_only' ? ` · ${t('Only logged')}` : ''}</Text>
                  </Table.Td>
                  <Table.Td><Badge variant="light" color={policy.effect === 'deny' ? 'red' : policy.effect === 'allow' ? 'teal' : 'orange'}>{policyEffectLabel(policy.effect)}</Badge></Table.Td>
                  <Table.Td maw={320}><Text size="xs" ff="monospace" lineClamp={2}>{JSON.stringify(policy.condition)}</Text></Table.Td>
                  <Table.Td ta="right">
                    {policy.scope !== 'platform' && (
                      <Button size="compact-xs" variant="subtle" onClick={() => setOpen(policy)}>{t('History')}</Button>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={open !== null} onClose={() => setOpen(null)} title={open?.slug} size="lg" centered>
        {open && <ConfigHistory companyId={companyId} kind="policy" subjectId={open.id} changed={view.reload} />}
      </Modal>
    </Section>
  );
}

function policyEffectLabel(effect: string): string {
  if (effect === 'allow') return t('Allow');
  if (effect === 'deny') return t('Deny');
  if (effect === 'require_review') return t('Require a review');
  if (effect === 'require_approval') return t('Require your approval');
  return effect;
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <Paper withBorder radius="md" px="sm" py={8}>
      <Text size="xs" c="dimmed">{label}</Text>
      <Text size="sm" fw={700}>{value}</Text>
    </Paper>
  );
}
