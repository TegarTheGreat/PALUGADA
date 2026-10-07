/**
 * The company's shape (F2, F2.7, F3): the goal ladder it works towards, its
 * divisions and the roles in them, its schedules, its charter and its
 * policies. Every
 * change is made from the thing it changes -- a role's charter from the role,
 * a division's grants from the division -- instead of from a form that asks
 * which one by id.
 */
import { useEffect, useState } from 'react';
import {
  Accordion, ActionIcon, Alert, Anchor, Avatar, Badge, Box, Button, Card, Code, Divider, Drawer, Group, List, Modal, Paper, PasswordInput, Progress, Select, SimpleGrid, Spoiler, Stack, Switch, Table, Tabs, Text, TextInput, Textarea, ThemeIcon, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  IconArrowsRight, IconCalendarTime, IconChartBar, IconCoin, IconCrown, IconFlag, IconFlask, IconHammer, IconHeadset, IconMessageCircle, IconPlus,
  IconRoute, IconLicense, IconSettings, IconShieldCheck, IconSparkles, IconTarget, IconTrendingUp, IconUserCircle, IconUsersGroup, IconWebhook, IconFolders,
  IconKey, IconExternalLink, IconLogin, IconPlayerPlay, IconTrash,
} from '@tabler/icons-react';
import { useMediaQuery } from '@mantine/hooks';
import { api, ApiError, explain } from '../api.ts';
import { useFactor } from '../factor.tsx';
import { useLoad } from '../hooks.ts';
import type { Company, Division, Goal, PersonaPreset, PolicyRow, Role, Schedule, Structure } from '../types.ts';
import { count, dateTime, goalKind, money, relative, roleLabel } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { N, locale, t, tp } from '../i18n.ts';
import { LoadFailed, Loading, PageHeader, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';
import { AssignWork } from '../components/AssignWork.tsx';
import { GoalMetrics } from '../components/Metrics.tsx';
import { Triggers } from '../components/Triggers.tsx';
import { Handoffs } from '../components/Handoffs.tsx';
import { Projects, useWorkLanguage } from '../components/Projects.tsx';
import { ConfigHistory } from '../components/ConfigHistory.tsx';
import { Charters } from '../components/Charters.tsx';
import { EMPTY_MAILBOX, MailboxFields, mailboxFilled, mailboxSent, type Mailbox } from '../components/MailboxFields.tsx';
import { companyEmblem, OWNER_PICTURE, rolePicture } from '../images.ts';
import { openGoals } from '../goals.ts';

export function Organization({ ctx, route }: PageProps) {
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
  // A division named in the address -- a card asking for one of its keys
  // sends the owner here -- opens with the page.
  const named = view.data && route.item ? view.data.structure.divisions.find((one) => one.id === route.item) ?? null : null;
  useEffect(() => {
    if (named) setDivision(named);
  }, [named?.id]);

  const header = (
    <PageHeader
      crumbs={[ctx.company.name]}
      title={t('Team')}
      description={t('Who does the work: divisions and the roles in them, the goals they work towards, their schedules, and the charter and policies they work under.')}
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
          <Tabs.Tab value="projects" leftSection={<IconFolders size={16} />}>{t('Projects')}</Tabs.Tab>
          <Tabs.Tab value="schedules" leftSection={<IconCalendarTime size={16} />}>{t('Schedules')}</Tabs.Tab>
          <Tabs.Tab value="handoffs" leftSection={<IconArrowsRight size={16} />}>{t('Handoffs')}</Tabs.Tab>
          <Tabs.Tab value="triggers" leftSection={<IconWebhook size={16} />}>{t('Triggers')}</Tabs.Tab>
          <Tabs.Tab value="charter" leftSection={<IconLicense size={16} />}>{t('Charter')}</Tabs.Tab>
          <Tabs.Tab value="policies" leftSection={<IconShieldCheck size={16} />}>{t('Policies')}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="chart">
          <Grow companyId={companyId} company={ctx.company} structure={structure} changed={view.reload} />
          <OrgChart structure={structure} company={ctx.company} openRole={setRole} openDivision={setDivision} talk={ctx.talk} giveWork={ctx.giveWork} />
        </Tabs.Panel>
        <Tabs.Panel value="goals">
          <GoalLadder companyId={companyId} goals={structure.goals} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="projects">
          <Projects companyId={companyId} company={ctx.company} structure={structure} changed={view.reload} />
        </Tabs.Panel>
        <Tabs.Panel value="schedules">
          <Schedules companyId={companyId} structure={structure} schedules={schedules} changed={view.reload}
            openTask={(taskId) => ctx.open('work', { item: taskId })} />
        </Tabs.Panel>
        <Tabs.Panel value="handoffs">
          <Handoffs companyId={companyId} structure={structure} />
        </Tabs.Panel>
        <Tabs.Panel value="triggers">
          <Triggers companyId={companyId} structure={structure} />
        </Tabs.Panel>
        <Tabs.Panel value="charter">
          <Charters companyId={companyId} />
        </Tabs.Panel>
        <Tabs.Panel value="policies">
          <Policies companyId={companyId} />
        </Tabs.Panel>
      </Tabs>

      <RoleDrawer companyId={companyId} role={openRole} structure={structure} close={() => setRole(null)}
        changed={() => { view.reload(); void ctx.refreshCompanies(); }} />
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
function Grow({ companyId, company, structure, changed }: {
  companyId: string; company: Company; structure: Structure; changed: () => void;
}) {
  const [open, setOpen] = useState<'role' | 'division' | 'project' | null>(null);
  const language = useWorkLanguage(company);
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
            { name: 'displayName', label: t('Name'), placeholder: t('e.g. Arka') },
            { name: 'title', label: t('Title'), placeholder: t('e.g. CTO') },
            { name: 'systemPrompt', label: t('What the role is for'), type: 'textarea', required: true, wide: true,
              placeholder: t('e.g. You write the words customers read: product pages and newsletters. Draft first; nothing goes out without review.') },
            { name: 'tools', label: t('Tools'), wide: true, placeholder: 'doc.draft',
              description: t('Capabilities, separated by commas; at most twelve. Its division is granted the ones it lacks, except those that cannot be undone.') },
            { name: 'person', label: t('A person, not an agent'), wide: true,
              description: t('The name of someone you have seated, to give this role to a person. Its work is put to them as a question, and what they answer is what it produced. It has no tools.') },
            { name: 'doneCriteria', label: t('How to know it is done'), type: 'textarea', required: true, wide: true,
              description: t('One per line. Work is checked against these before it counts as finished.'),
              placeholder: t('e.g. every claim about the product is one the product page makes') },
          ]}
          factor={t('Hire a role')}
          submit={async (values, proof) => {
            const hired: { roleId: string; ungranted: string[]; granted: string[] } = await api('POST', `/api/companies/${companyId}/roles`, {
              divisionId: values.divisionId, slug: values.slug, systemPrompt: values.systemPrompt,
              tools: list(values.tools, /,/), doneCriteria: list(values.doneCriteria, /\n/), grantTools: true,
              ...(values.person ? { person: values.person } : {}),
              ...(values.displayName ? { displayName: values.displayName } : {}), ...(values.title ? { title: values.title } : {}), proof,
            });
            if (hired.granted.length > 0) {
              notifications.show({ color: 'teal', message: t('Its division was granted {tools}.', { tools: hired.granted.join(', ') }) });
            }
            if (hired.ungranted.length > 0) {
              notifications.show({
                color: 'orange',
                message: t('Its division has no grant yet for {tools}, which cannot be undone once used. Open the division to grant them if you mean to.', { tools: hired.ungranted.join(', ') }),
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
        {!language.ready ? <Loading rows={2} /> : (
          <ActionForm
            columns={1}
            fields={[
              { name: 'name', label: t('Name'), required: true, placeholder: t('e.g. Wholesale') },
              { name: 'slug', label: t('Short name'), required: true, placeholder: 'wholesale-2026' },
              ...language.fields(null),
            ]}
            submit={(values) => api('POST', `/api/companies/${companyId}/projects`, {
              name: values.name, slug: values.slug, ...language.chosen(values),
            })}
            action={t('Start it')}
            done={done(t('The project is started. Work given to the company can be put in it.'))}
          />
        )}
      </Modal>
    </>
  );
}

/* --------------------------------------------------------------- the chart --- */

/**
 * A division's icon and colour, from the words of its slug: what it does, as
 * a role's picture is (images.ts), and never a letter of its name.
 */
const DIVISION_LOOKS: ReadonlyArray<readonly [readonly string[], typeof IconSettings, string]> = [
  [['assur', 'qa', 'quality', 'review', 'audit'], IconShieldCheck, 'violet'],
  [['lab', 'research', 'experiment', 'sandbox'], IconFlask, 'grape'],
  [['build', 'engineer', 'dev', 'platform', 'tech'], IconHammer, 'orange'],
  [['deliver', 'product', 'project'], IconRoute, 'blue'],
  [['growth', 'market', 'sales', 'brand', 'content'], IconTrendingUp, 'pink'],
  [['financ', 'money', 'account', 'book', 'billing'], IconCoin, 'green'],
  [['support', 'care', 'service', 'success', 'help'], IconHeadset, 'teal'],
  [['data', 'analy', 'insight', 'metric'], IconChartBar, 'cyan'],
  [['ops', 'operat', 'admin', 'office'], IconSettings, 'indigo'],
];

function divisionLook(division: Division): { Icon: typeof IconSettings; color: string } {
  const words = `${division.slug} ${division.name}`.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const found = DIVISION_LOOKS.find(([starts]) => words.some((word) => starts.some((start) => word.startsWith(start))));
  return found ? { Icon: found[1], color: found[2] } : { Icon: IconUsersGroup, color: 'gray' };
}

/**
 * The company as a chart: the owner, the CEO they talk to, and under it every
 * division with the roles in it.
 *
 * The divisions hang from one spine in two columns rather than from one wide
 * row: a company of eight divisions is then readable at a glance on a laptop
 * without panning, and a sub-division hangs from its parent's card. On a
 * phone they stack.
 */
function OrgChart({
  structure, company, openRole, openDivision, talk, giveWork,
}: {
  structure: Structure;
  company: { id: string; name: string };
  openRole: (role: Role) => void;
  openDivision: (division: Division) => void;
  talk: () => void;
  giveWork: () => void;
}) {
  const narrow = useMediaQuery('(max-width: 48em)');
  const personas = useLoad(async (): Promise<{ personas: PersonaPreset[] }> => api('GET', '/api/personas'), []);
  const ceo = structure.roles.find((role) => role.title === 'CEO') ?? null;
  const top = structure.divisions.filter((division) => division.parentId === null);
  const childrenOf = (id: string) => structure.divisions.filter((division) => division.parentId === id);
  const rolesIn = (division: Division) => structure.roles.filter((role) => role.divisionId === division.id && role.id !== ceo?.id);
  const working = structure.roles.filter((role) => role.openTasks > 0).length;
  const branch = (division: Division) => (
    <div className="org-cell">
      <DivisionCard division={division} roles={rolesIn(division)} ceoHere={ceo?.divisionId === division.id} openRole={openRole} openDivision={openDivision} />
      {childrenOf(division.id).map((child) => (
        <div key={child.id} className="org-sub">
          <DivisionCard division={child} roles={rolesIn(child)} ceoHere={ceo?.divisionId === child.id} openRole={openRole} openDivision={openDivision} />
        </div>
      ))}
    </div>
  );
  const rows: Array<[Division, Division | null]> = [];
  for (let index = 0; index < top.length; index += 2) rows.push([top[index]!, top[index + 1] ?? null]);

  return (
    <div className="org-canvas">
      <div className="org-head">
        <Paper withBorder radius="lg" px="md" py="sm" shadow="xs" className="org-owner">
          <Group gap="sm" wrap="nowrap">
            <Avatar radius="xl" size={40} src={OWNER_PICTURE} alt="" />
            <div style={{ minWidth: 0 }}>
              <Text fw={700} size="sm">{t('You, the owner')}</Text>
              <Text size="xs" c="dimmed" truncate>{t('You decide what cannot be undone')}</Text>
            </div>
            <Avatar radius="md" size={32} src={companyEmblem(company)} alt="" ms="xs" />
          </Group>
        </Paper>
        <div className="org-stem org-stem--talk">
          <Badge size="xs" variant="white" color="gray" tt="none" className="org-stem-label" leftSection={<IconMessageCircle size={10} />}>{t('talks with you')}</Badge>
        </div>
        {ceo ? (
          <Paper radius="lg" p="md" shadow="sm" className="org-ceo" onClick={() => openRole(ceo)}>
            <Group gap="md" wrap="nowrap" align="flex-start">
              <Avatar size={60} radius="xl" src={rolePicture(ceo.slug, ceo.title)} alt="" className="org-ceo-picture" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Group gap={6} wrap="nowrap">
                  <Text fw={800} size="lg" truncate>{ceo.displayName ?? ceo.slug}</Text>
                  <Badge size="sm" variant="filled" leftSection={<IconCrown size={11} />}>CEO</Badge>
                </Group>
                <Text size="xs" c="dimmed" truncate>{t('Runs {company} for you', { company: company.name })}</Text>
                {(() => {
                  const preset = personas.data?.personas.find((one) => one.id === ceo.persona?.preset);
                  return preset
                    ? <Badge mt={6} size="sm" variant="light" color="grape" leftSection={<IconSparkles size={11} />} style={{ textTransform: 'none' }}>{preset.label} · {preset.inspiredBy}</Badge>
                    : <Text size="xs" c="dimmed" mt={6}>{t('No persona yet: it works as its charter says.')}</Text>;
                })()}
              </div>
              <Badge size="sm" variant="dot" color={roleState(ceo).color}>{roleState(ceo).label}</Badge>
            </Group>
            <Group gap="xs" mt="sm" onClick={(event) => event.stopPropagation()}>
              <Button size="xs" leftSection={<IconMessageCircle size={14} />} onClick={talk}>{t('Talk to {name}', { name: ceo.displayName ?? ceo.slug })}</Button>
              <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={giveWork}>{t('Give work')}</Button>
            </Group>
          </Paper>
        ) : (
          <Paper radius="lg" p="md" className="org-ceo org-ceo--missing">
            <Group gap="sm" wrap="nowrap">
              <ThemeIcon size={44} radius="xl" variant="light" color="yellow"><IconCrown size={22} /></ThemeIcon>
              <div>
                <Text fw={700}>{t('No CEO yet')}</Text>
                <Text size="xs" c="dimmed">{t('The CEO is who you talk to about a company. Hire its first role on Team; it becomes the CEO.')}</Text>
              </div>
            </Group>
          </Paper>
        )}
        <Text size="xs" c="dimmed" mt={8} className="org-summary">
          {t('{divisions} divisions · {roles} roles · {working} working now', { divisions: structure.divisions.length, roles: structure.roles.length, working })}
        </Text>
        {top.length > 0 && <div className="org-stem" />}
      </div>

      {narrow ? (
        <Stack gap="md">{top.map((division) => <div key={division.id}>{branch(division)}</div>)}</Stack>
      ) : (
        <div className="org-trunk">
          {rows.map(([left, right], index) => {
            const last = index === rows.length - 1;
            return (
              <div key={left.id} className="org-row">
                <div className="org-side">{branch(left)}</div>
                <div className={`org-spine${last ? ' is-last' : ''}`}>
                  <span className="org-branch org-branch--left" />
                  {right && <span className="org-branch org-branch--right" />}
                </div>
                <div className="org-side">{right && branch(right)}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
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
  division, roles, ceoHere, openRole, openDivision,
}: { division: Division; roles: Role[]; ceoHere: boolean; openRole: (role: Role) => void; openDivision: (division: Division) => void }) {
  const look = divisionLook(division);
  return (
    <Card withBorder radius="lg" shadow="xs" padding="md" className="org-division">
      <Group justify="space-between" onClick={() => openDivision(division)} style={{ cursor: 'pointer' }} wrap="nowrap" gap="sm">
        <ThemeIcon size={36} radius="md" variant="light" color={look.color}><look.Icon size={20} /></ThemeIcon>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} truncate>{division.name}</Text>
          <Text size="xs" c="dimmed" truncate>{t('{count} capabilities · up to {max} at once', { count: division.grants.length, max: division.maxConcurrency })}</Text>
        </div>
        {/* The badge keeps its width: a long division name gives way first. */}
        {division.openTasks > 0
          ? <Badge color="teal" variant="light" style={{ flexShrink: 0 }}>{t('{count} open', { count: division.openTasks })}</Badge>
          : <Badge color="gray" variant="light" style={{ flexShrink: 0 }}>{t('quiet')}</Badge>}
      </Group>
      <Stack gap={6} mt="sm">
        {ceoHere && <Text size="xs" c="dimmed"><IconCrown size={12} style={{ verticalAlign: -2 }} /> {t('The CEO works from here.')}</Text>}
        {roles.length === 0 && !ceoHere && <Text size="xs" c="dimmed">{t('No roles.')}</Text>}
        {roles.map((role) => {
          const state = roleState(role);
          return (
            <Paper key={role.id} withBorder radius="md" px="sm" py={8} className="org-node" onClick={() => openRole(role)}>
              <Group gap="sm" wrap="nowrap">
                <Avatar size={34} radius="xl" src={rolePicture(role.slug, role.title)} alt="" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" fw={600} truncate>{role.displayName ?? role.slug}</Text>
                    {role.persona?.preset && <Tooltip label={t('Has a persona')}><IconSparkles size={12} color="var(--mantine-color-grape-5)" style={{ flexShrink: 0 }} /></Tooltip>}
                  </Group>
                  {role.title && <Text size="xs" c="dimmed" truncate>{role.title}</Text>}
                </div>
                <Tooltip label={role.frozenReason ?? t('{open} open · {done} done this week', { open: role.openTasks, done: role.doneLastWeek })}>
                  <Badge size="sm" variant="dot" color={state.color} style={{ flexShrink: 0 }}>{state.label}</Badge>
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
          factor={t('Move {role} to another runtime', { role: role.displayName ?? role.slug })}
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
        {role && <Avatar size={40} radius="xl" src={rolePicture(role.slug, role.title)} alt="" />}
        <div>
          <Text fw={700}>{role?.displayName ?? role?.slug}</Text>
          {role?.title && <Text size="xs" c="dimmed">{role.title}</Text>}
        </div>
      </Group>
    }>
      {role && division && (
        <Stack gap="lg">
          {role.title === 'CEO' ? (
            <Alert variant="light" color="brand" icon={<IconCrown size={18} />} title={t('The CEO: who you talk to')}>
              <Text size="sm">{t('Work you give without saying whose comes here first, and so does trouble a division cannot fix. To make another role the CEO, open that role.')}</Text>
            </Alert>
          ) : (
            <Group justify="space-between" wrap="nowrap">
              <Text size="xs" c="dimmed">{t('A company has one CEO, the role you talk to.')}</Text>
              <ActionButton
                size="xs"
                variant="light"
                label={t('Make {name} the CEO', { name: role.displayName ?? role.slug })}
                factor={t('Make {name} the CEO', { name: role.displayName ?? role.slug })}
                run={(proof) => api('POST', `/api/companies/${companyId}/ceo`, { roleId: role.id, proof })}
                done={() => {
                  notifications.show({ color: 'teal', message: t('{name} is the CEO now. You talk to the company through {name}.', { name: role.displayName ?? role.slug }) });
                  changed();
                }}
              />
            </Group>
          )}
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
                  notifications.show({ color: 'orange', message: t('{role} paused. Nothing new starts for it until you resume it.', { role: role.displayName ?? role.slug }) });
                  changed();
                  close();
                }}
              />
            )}
          </Group>
          {role.frozenAt && (
            <Alert color="red" variant="light" title={t('Frozen')}>
              <Text size="sm">
                {role.frozenReason ?? t('Repeatedly denied.')}{' '}
                {role.frozenBy === 'spend' ? t('It goes on by itself once its spending is back to normal.') : t('It stays frozen until you look.')}
              </Text>
              <Group mt="sm">
                <ActionButton
                  label={t('Resume this role')}
                  color="red"
                  variant="light"
                  factor={t('Resume {role}', { role: role.displayName ?? role.slug })}
                  run={(proof) => api('POST', `/api/control/company/${companyId}/role/${role.id}/resume`, { proof })}
                  done={() => { notifications.show({ color: 'teal', message: t('{role} resumed.', { role: role.displayName ?? role.slug }) }); changed(); close(); }}
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
            <Accordion.Item value="persona">
              <Accordion.Control>{t('Name and persona')}</Accordion.Control>
              <Accordion.Panel><RolePersonaForm companyId={companyId} role={role} changed={changed} /></Accordion.Panel>
            </Accordion.Item>
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
              <Accordion.Control>{t('Change its charter, done criteria, model or run length')}</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  columns={1}
                  fields={[
                    { name: 'systemPrompt', label: t('Charter'), type: 'textarea', description: t('Blank keeps the current one') },
                    {
                      name: 'doneCriteria', label: t('Done means'), type: 'textarea', initial: role.doneCriteria.join('\n'),
                      description: t('One testable sentence per line. Every run answers each one with evidence; name what counts when a tool it needs is not connected.'),
                    },
                    { name: 'modelPrimary', label: t('Primary model'), initial: role.model },
                    {
                      name: 'maxRunMinutes', label: t('Longest one run may take, in minutes'), type: 'number',
                      initial: role.maxRunSeconds === null ? 0 : Math.ceil(role.maxRunSeconds / 60),
                      description: t('A run still going then is stopped and the task waits for you. 0 is no limit but the task\'s own deadline.'),
                    },
                  ]}
                  submit={(values, proof) => {
                    // Sent only when changed, so a new model is not also
                    // recorded as new criteria, or a new length, in the role's history.
                    const { doneCriteria, maxRunMinutes, ...rest } = values;
                    const lines = String(doneCriteria ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
                    const changedCriteria = lines.join('\n') !== role.doneCriteria.join('\n');
                    const current = role.maxRunSeconds === null ? 0 : Math.ceil(role.maxRunSeconds / 60);
                    const changedLength = maxRunMinutes !== undefined && Number(maxRunMinutes) !== current;
                    return api('POST', `/api/companies/${companyId}/roles/${role.id}`, {
                      ...rest, ...(changedCriteria ? { doneCriteria: lines } : {}),
                      ...(changedLength ? { maxRunMinutes } : {}), proof,
                    });
                  }}
                  factor={t('Change {role}', { role: role.displayName ?? role.slug })}
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

/**
 * Who a role is: its name, its title, and a persona to work in, chosen from
 * people whose way of leading is written down in public. A way of thinking,
 * never an identity: the role is told so in every run, and signs as itself.
 */
function RolePersonaForm({ companyId, role, changed }: { companyId: string; role: Role; changed: () => void }) {
  const requireFactor = useFactor();
  const library = useLoad(async (): Promise<{ titles: string[]; personas: PersonaPreset[] }> => api('GET', '/api/personas'), []);
  const [name, setName] = useState(role.displayName ?? '');
  const [title, setTitle] = useState<string | null>(role.title);
  const [preset, setPreset] = useState<string | null>(role.persona?.preset ?? null);
  const [notes, setNotes] = useState(role.persona?.notes ?? '');
  if (library.error) return <Text size="sm" c="red">{library.error}</Text>;
  if (!library.data) return <Loading rows={2} />;
  const chosen = library.data.personas.find((one) => one.id === preset) ?? null;
  const groups = library.data.titles
    .map((one) => ({ group: one, items: library.data!.personas.filter((persona) => persona.title === one) }))
    .filter((group) => group.items.length > 0)
    .map((group) => ({ group: group.group, items: group.items.map((persona) => ({ value: persona.id, label: `${persona.label} — ${persona.inspiredBy}` })) }));
  const save = async () => {
    const done = await requireFactor(t('Change {role}', { role: role.displayName ?? role.slug }), (proof) =>
      api('POST', `/api/companies/${companyId}/roles/${role.id}`, {
        displayName: name.trim(), ...(role.title === 'CEO' ? {} : { title }),
        persona: preset || notes.trim() ? { preset: preset ?? undefined, notes: notes.trim() || undefined } : null,
        summary: t('Who {role} is', { role: name.trim() || role.slug }), proof,
      }));
    if (done) {
      notifications.show({ color: 'teal', message: t('Saved. Its next run works this way.') });
      changed();
    }
  };
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <TextInput label={t('Name')} placeholder={t('e.g. Arka')} value={name} onChange={(event) => setName(event.currentTarget.value)} maxLength={60} />
        {role.title === 'CEO'
          ? <TextInput label={t('Title')} value="CEO" disabled description={t('The CEO\'s title moves when you make another role CEO.')} />
          : (
            <Select
              label={t('Title')}
              // A company has one CEO, made by appointing it rather than by a title.
              data={library.data.titles.filter((one) => one !== 'CEO')}
              value={title}
              onChange={setTitle}
              clearable
              searchable
            />
          )}
      </SimpleGrid>
      <Select
        label={t('Persona')}
        description={t('A way of thinking to work in, taken from someone whose way of leading is on the public record.')}
        placeholder={t('None: it works as its charter says')}
        data={groups}
        value={preset}
        onChange={(value) => {
          setPreset(value);
          const picked = library.data!.personas.find((one) => one.id === value);
          if (picked && !title && picked.title !== 'CEO') setTitle(picked.title);
        }}
        clearable
        searchable
      />
      {chosen && (
        <Paper withBorder radius="md" p="sm">
          <Text size="sm" fw={600}>{chosen.label}</Text>
          <Text size="xs" c="dimmed" mb={6}>{t('Inspired by {person}', { person: chosen.inspiredBy })}</Text>
          <List size="sm" spacing={2}>{chosen.principles.map((principle) => <List.Item key={principle}>{principle}</List.Item>)}</List>
          <Text size="xs" mt={6}><b>{t('Manner')}:</b> {chosen.manner}</Text>
          <Text size="xs"><b>{t('Decides')}:</b> {chosen.decides}</Text>
        </Paper>
      )}
      <Textarea label={t('In your own words')} description={t('Anything else about how it should be: its tone, its habits, what it cares about.')}
        autosize minRows={2} value={notes} onChange={(event) => setNotes(event.currentTarget.value)} maxLength={1000} />
      <Alert variant="light" color="gray">
        <Text size="xs">{t('It takes after the person\'s way of thinking and never claims to be them: whatever it sends out is signed with its own name.')}</Text>
      </Alert>
      <Group justify="flex-end"><Button onClick={() => void save()}>{t('Save')}</Button></Group>
    </Stack>
  );
}

function RoleBudget({ companyId, role }: { companyId: string; role: Role }) {
  // F1.6. A budget is a tree: a task draws on the narrowest account that
  // covers it, and a spend counts against every account above.
  const budget = useLoad(async () => {
    const answer: { accountId: string; snapshot: { tokensSpent: number; tokensMax: number; moneySpentCents?: number; moneyMaxCents?: number }; chain: string[]; chainNames: Array<string | null> } =
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
        {/* By name: it was each account's id cut to eight characters (§2.3 item 7). */}
        <Text size="sm">{budget.data.chainNames.map((name) => name ?? t('The whole company')).join(' → ')}</Text>
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

/** How a key is signed in for, when it is: with whom, and whether the app is registered. */
interface KeySignIn {
  provider: string;
  name: string;
  clientUrl: string | null;
  client: boolean;
}

interface DivisionKeysView {
  credentials: Array<{
    alias: string; version: number; stored: 'console' | 'environment' | 'file' | 'elsewhere'; signedIn: boolean;
    scopes: string[]; createdAt: string; rotatedAt: string | null; signIn?: KeySignIn;
    /** Given in a form rather than pasted. */
    form?: 'mailbox';
  }>;
  needs: Array<{ alias: string; capabilities: string[]; scopes: string[]; signIn?: KeySignIn; form?: 'mailbox' }>;
  /** Where a sign-in comes back to, for the app the owner registers. */
  callback: string | null;
}

/**
 * Signs a division in for a key, in the owner's own browser: the app
 * registered with the provider once for the deployment -- asked for here the
 * first time, with the address to give it -- then the provider's page in a
 * new tab. The key is held when the provider sends the browser back, and this
 * asks until it is.
 */
function SignInKey({ companyId, divisionId, alias, signIn, callback, again, done }: {
  companyId: string; divisionId: string; alias: string; signIn: KeySignIn; callback: string | null; again: boolean; done: () => void;
}) {
  const requireFactor = useFactor();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const begin = async () => {
    setProblem(null);
    let opened: string | null = null;
    try {
      await requireFactor(t('Sign in to {name} for the {alias} key', { name: signIn.name, alias }), async (proof) => {
        const answer: { authorizeUrl: string } = await api('POST', `/api/companies/${companyId}/divisions/${divisionId}/credentials/${alias}/oauth/start`, {
          proof, ...(clientId.trim() ? { clientId: clientId.trim(), clientSecret: clientSecret.trim() || undefined } : {}),
        });
        opened = answer.authorizeUrl;
        return answer;
      });
    } catch (failure) {
      setProblem(explain(failure));
    }
    if (opened) setAuthorizeUrl(opened);
  };
  // While the owner signs in in the other tab: asked every few seconds
  // whether the key has arrived.
  useEffect(() => {
    if (!authorizeUrl) return undefined;
    const started = Date.now();
    const timer = setInterval(() => {
      void api('GET', `/api/companies/${companyId}/divisions/${divisionId}/credentials`).then((view: DivisionKeysView) => {
        const held = view.credentials.find((row) => row.alias === alias);
        if (!held?.signedIn || Date.parse(held.rotatedAt ?? held.createdAt) < started - 5_000) return;
        clearInterval(timer);
        setAuthorizeUrl(null);
        notifications.show({ color: 'teal', message: t('Signed in to {name}. The {alias} key is held, and renewed before it runs out.', { name: signIn.name, alias }) });
        done();
      }, () => undefined);
    }, 3_000);
    return () => clearInterval(timer);
  }, [authorizeUrl]);
  const needsClient = !signIn.client && !authorizeUrl;
  return (
    <Stack gap={6}>
      {needsClient && (
        <>
          <Text size="xs">
            {t('{name} lets PALUGADA in through an app you register with it, once for this deployment. Give the app this return address, then paste its client ID and secret.', { name: signIn.name })}
            {signIn.clientUrl && <>{' '}<Anchor href={signIn.clientUrl} target="_blank" rel="noreferrer" size="xs">{t('Register an app')} <IconExternalLink size={10} /></Anchor></>}
          </Text>
          {callback && <Code>{callback}</Code>}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput size="xs" label={t('Client ID')} description={t('From the app you registered')} value={clientId} onChange={(event) => setClientId(event.currentTarget.value)} />
            <PasswordInput size="xs" label={t('Client secret')} description={t('If it gave you one')} value={clientSecret} onChange={(event) => setClientSecret(event.currentTarget.value)} autoComplete="off" />
          </SimpleGrid>
        </>
      )}
      {authorizeUrl
        ? (
          <Group gap="sm">
            <Button size="xs" component="a" href={authorizeUrl} target="_blank" rel="noopener noreferrer" leftSection={<IconExternalLink size={14} />}>
              {t('Open the sign-in page')}
            </Button>
            <Text size="xs" c="dimmed">{t('Waiting for you to sign in there…')}</Text>
          </Group>
        )
        : (
          <Group gap="xs">
            <Button size="xs" variant={again ? 'subtle' : 'filled'} leftSection={<IconLogin size={14} />}
              disabled={needsClient && clientId.trim() === ''} onClick={() => void begin()}>
              {again ? t('Sign in again') : t('Sign in with {name}', { name: signIn.name })}
            </Button>
          </Group>
        )}
      {problem && <Text size="xs" c="red">{problem}</Text>}
    </Stack>
  );
}

const STORED: Record<DivisionKeysView['credentials'][number]['stored'], string> = {
  console: N('sealed here'),
  environment: N('from the environment'),
  file: N('from a file'),
  elsewhere: N('from a secret manager'),
};

/**
 * The keys a division's services sign in with: what it holds, what its
 * capabilities ask for that it does not, and a place to paste one. A key is
 * sealed as it is saved and never shown again; pasting another for the same
 * name replaces it at the next call.
 */
function DivisionKeys({ companyId, divisionId }: { companyId: string; divisionId: string }) {
  const requireFactor = useFactor();
  const view = useLoad(async (): Promise<DivisionKeysView> =>
    api('GET', `/api/companies/${companyId}/divisions/${divisionId}/credentials`), [companyId, divisionId]);
  const [alias, setAlias] = useState('');
  const [value, setValue] = useState('');
  // A mailbox is a form, not a key: the one being given, and the held one being changed.
  const [mailbox, setMailbox] = useState<Mailbox>(EMPTY_MAILBOX);
  const [changing, setChanging] = useState<string | null>(null);
  const save = async (name: string, key: string) => {
    const done = await requireFactor(t('Save the {alias} key', { alias: name }), (proof) =>
      api('POST', `/api/companies/${companyId}/divisions/${divisionId}/credentials`, { alias: name, value: key, proof }));
    if (done) {
      notifications.show({ color: 'teal', message: t('The {alias} key is sealed. Calls use it from the next one.', { alias: name }) });
      setAlias('');
      setValue('');
      setMailbox(EMPTY_MAILBOX);
      setChanging(null);
      view.reload();
    }
  };
  const mailboxForm = (name: string) => (
    <Stack gap="xs">
      <MailboxFields value={mailbox} onChange={setMailbox} />
      <Group><Button disabled={!mailboxFilled(mailbox)} onClick={() => void save(name, JSON.stringify(mailboxSent(mailbox)))}>{t('Save')}</Button></Group>
    </Stack>
  );
  const remove = async (name: string) => {
    const done = await requireFactor(t('Remove the {alias} key', { alias: name }), (proof) =>
      api('POST', `/api/companies/${companyId}/divisions/${divisionId}/credentials/${name}/remove`, { proof }));
    if (done) view.reload();
  };
  return (
    <Section title={t('Keys for services')} description={t('What its services sign in with. A key is sealed as it is saved and never shown again; paste another to replace it.')}>
      {view.error && <LoadFailed message={view.error} retry={view.reload} />}
      {!view.data && !view.error && <Loading rows={2} />}
      {view.data && (
        <Stack gap="sm">
          {view.data.needs.map((need) => (
            <Alert key={need.alias} variant="light" color="yellow" icon={<IconKey size={18} />}
              title={t('{capabilities} needs the {alias} key', { capabilities: need.capabilities.join(', '), alias: need.alias })}>
              {need.scopes.length > 0 && !need.form && (
                <Text size="xs" mb={6}>{t('Issue it with {scopes}, and nothing wider.', { scopes: need.scopes.join(', ') })}</Text>
              )}
              {need.form === 'mailbox' ? mailboxForm(need.alias) : need.signIn
                ? <SignInKey companyId={companyId} divisionId={divisionId} alias={need.alias} signIn={need.signIn} callback={view.data!.callback} again={false} done={view.reload} />
                : (
                  <Group gap="xs" align="flex-end" wrap="nowrap">
                    <PasswordInput style={{ flex: 1 }} aria-label={t('The {alias} key', { alias: need.alias })} placeholder={t('Paste the key the service gave you')}
                      value={alias === need.alias ? value : ''} onChange={(event) => { setAlias(need.alias); setValue(event.currentTarget.value); }} />
                    <Button disabled={alias !== need.alias || value.trim() === ''} onClick={() => void save(need.alias, value)}>{t('Save')}</Button>
                  </Group>
                )}
            </Alert>
          ))}
          {view.data.credentials.length > 0 && (
            <Table>
              <Table.Tbody>
                {view.data.credentials.map((row) => (
                  <Table.Tr key={row.alias}>
                    <Table.Td><Group gap={6}><IconKey size={14} /><Text size="sm" fw={600}>{row.alias}</Text></Group></Table.Td>
                    <Table.Td>
                      <Text size="xs" c="dimmed">
                        {row.signedIn && row.signIn ? t('signed in with {name}', { name: row.signIn.name }) : t(STORED[row.stored])} · {t('version {version}', { version: row.version })}
                      </Text>
                      {row.scopes.length > 0 && <Text size="xs" c="dimmed">{t('declared with {scopes}', { scopes: row.scopes.join(', ') })}</Text>}
                      {row.signIn && (
                        <SignInKey companyId={companyId} divisionId={divisionId} alias={row.alias} signIn={row.signIn} callback={view.data!.callback} again done={view.reload} />
                      )}
                      {row.form === 'mailbox' && (changing === row.alias
                        ? <Box mt="xs">{mailboxForm(row.alias)}</Box>
                        : <Button variant="subtle" size="compact-xs" mt={4} onClick={() => { setMailbox(EMPTY_MAILBOX); setChanging(row.alias); }}>{t('Change the mailbox')}</Button>)}
                    </Table.Td>
                    <Table.Td><Text size="xs" c="dimmed">{relative(row.rotatedAt ?? row.createdAt)}</Text></Table.Td>
                    <Table.Td ta="right"><Button variant="subtle" color="red" size="compact-xs" onClick={() => void remove(row.alias)}>{t('Remove')}</Button></Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )}
          {view.data.needs.length === 0 && view.data.credentials.length === 0 && (
            <Text size="sm" c="dimmed">{t('None of its capabilities asks for a key.')}</Text>
          )}
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <TextInput style={{ width: 140 }} label={t('Name')} placeholder={t('such as crm')} value={view.data.needs.some((need) => need.alias === alias) ? '' : alias}
              onChange={(event) => { setAlias(event.currentTarget.value.trim().toLowerCase()); setValue(''); }} />
            <PasswordInput style={{ flex: 1 }} label={t('Key')} placeholder={t('Paste the key the service gave you')}
              value={view.data.needs.some((need) => need.alias === alias) ? '' : value} onChange={(event) => setValue(event.currentTarget.value)} />
            <Button variant="light" disabled={alias === '' || value.trim() === '' || view.data.needs.some((need) => need.alias === alias)}
              onClick={() => void save(alias, value)}>{t('Save')}</Button>
          </Group>
        </Stack>
      )}
    </Section>
  );
}

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
                  {grant.maxInFlight !== null ? ` · ${t('{count} at once', { count: grant.maxInFlight })}` : ''}
                </Badge>
              ))}
            </Group>
          </Section>

          <DivisionKeys key={division.id} companyId={companyId} divisionId={division.id} />

          <Accordion variant="separated" radius="md">
            <Accordion.Item value="grant">
              <Accordion.Control>{t('Change a grant')}</Accordion.Control>
              <Accordion.Panel>
                <ActionForm
                  fields={[
                    { name: 'capabilityName', label: t('Capability'), required: true, placeholder: 'email.send',
                      description: t('As the catalogue names it') },
                    { name: 'tierOverride', label: t('Tier'), type: 'select', description: t('Blank revokes the grant'), options: [
                      { value: '0', label: t('Tier 0 · read only') }, { value: '1', label: t('Tier 1 · cheap to undo') },
                      { value: '2', label: t('Tier 2 · costly') }, { value: '3', label: t('Tier 3 · irreversible') },
                    ] },
                    { name: 'maxInFlight', label: t('Calls at once, at most'), type: 'number',
                      description: t('Blank keeps it as it is; 0 takes the limit away; at most 100') },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/structure/grant`, {
                    divisionId: division.id,
                    capabilityName: values.capabilityName,
                    ...(values.tierOverride === undefined ? { revoke: true } : { tierOverride: Number(values.tierOverride) }),
                    ...(values.maxInFlight === undefined ? {} : { maxInFlight: Number(values.maxInFlight) }),
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
                      options: roles.map((role) => ({ value: role.slug, label: roleLabel(role) })), initial: division.escalationRole },
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
    <Box key={goal.id} ps={depth * 28}>
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
            done={(result) => {
              // Closing a goal pauses what would start work under it; the owner is told how much.
              const paused = (result as { paused?: { schedules: number; triggers: number } }).paused;
              notifications.show({
                color: 'teal',
                message: paused && paused.schedules + paused.triggers > 0
                  ? t('Goal changed. Paused under it: {schedules} schedules and {triggers} triggers; turn any back on from its tab.', paused)
                  : t('Goal changed.'),
              });
              close();
              changed();
            }}
          />
        </Stack>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- schedules --- */

const ZONES = ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];

/** The zone this browser is in: a new schedule's default, so an owner in Jakarta is asked in WIB, not UTC (N11). */
function ownZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** A zone as the owner reads it: its name, and what the clock there is called -- "Asia/Jakarta · WIB". */
function zoneLabel(zone: string): string {
  try {
    const named = new Intl.DateTimeFormat(locale(), { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date()).find((part) => part.type === 'timeZoneName')?.value;
    return named && named !== zone ? `${zone} · ${named}` : zone;
  } catch {
    return zone;
  }
}

/** A weekday's name in the owner's language, Sunday being 0 as cron counts. */
function weekday(day: number): string {
  // 2023-01-01 was a Sunday.
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + day)));
}

/** Every half hour of a day, for the time a schedule runs at. */
const TIMES = Array.from({ length: 48 }, (_, slot) => `${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}`);

/**
 * The cron a choice of days and a time makes (N11): an owner picks "every
 * weekday at 07:00", and only a schedule the choices cannot say needs cron.
 */
function cronFor(repeats: string, at: string, custom: string): string {
  const [hour, minute] = at.split(':').map(Number) as [number, number];
  if (repeats === 'daily') return `${minute} ${hour} * * *`;
  if (repeats === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (repeats === 'hourly') return `${minute} * * * *`;
  if (/^[0-6]$/.test(repeats)) return `${minute} ${hour} * * ${repeats}`;
  if (!custom.trim()) throw new Error(t('A custom schedule needs its cron.'));
  return custom.trim();
}

/** A schedule's cron in words, where it is one of the shapes the form makes; null otherwise. */
function cronSaid(cron: string): string | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5 || !/^\d+$/.test(parts[0]!) || parts[2] !== '*' || parts[3] !== '*') return null;
  const minute = Number(parts[0]);
  if (parts[1] === '*' && parts[4] === '*') return t('Every hour at minute {minute}', { minute: String(minute).padStart(2, '0') });
  if (!/^\d+$/.test(parts[1]!)) return null;
  const time = `${String(Number(parts[1])).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  if (parts[4] === '*') return t('Every day at {time}', { time });
  if (parts[4] === '1-5') return t('Weekdays at {time}', { time });
  if (/^[0-6]$/.test(parts[4]!)) return t('Every {day} at {time}', { day: weekday(Number(parts[4])), time });
  return null;
}

/** What a schedule does while its last run is still going (F9.1), as the table says it. */
const OVERLAP_SAID: Record<Schedule['overlap'], string> = {
  skip: N('Skips a run while the last one is going'),
  queue: N('Waits for the last run to finish'),
  allow: N('Runs beside the last run'),
};

/** A catch-up window in the largest whole unit it fills: 90 minutes, 3 hours, 2 days. */
function windowLength(minutes: number): string {
  if (minutes % 1440 === 0) return tp('{count} day', '{count} days', minutes / 1440);
  if (minutes % 60 === 0) return tp('{count} hour', '{count} hours', minutes / 60);
  return tp('{count} minute', '{count} minutes', minutes);
}

function catchUpSaid(minutes: number | null): string {
  return minutes === null
    ? t('Always catches up once')
    : t('Skips a run more than {late} late', { late: windowLength(minutes) });
}

/** Why the last run that did not happen did not, so a quiet night is explained rather than guessed at. */
function skippedSaid(skipped: NonNullable<Schedule['lastSkipped']>): string {
  const values = { when: dateTime(skipped.occurrence) };
  // One run is "the run"; any other number goes through `tp`, whose "one"
  // form some languages use for 21 as well, so that form names the count.
  if (skipped.occurrences === 1) {
    return skipped.because === 'overlap'
      ? t('Skipped the run at {when}: the last one was still going', values)
      : t('Missed the run at {when}: too late to be worth running', values);
  }
  return skipped.because === 'overlap'
    ? tp('Skipped {count} run from {when}: the last one was still going', 'Skipped {count} runs from {when}: the last one was still going', skipped.occurrences, values)
    : tp('Missed {count} run from {when}: too late to be worth running', 'Missed {count} runs from {when}: too late to be worth running', skipped.occurrences, values);
}

function Schedules({
  companyId, structure, schedules, changed, openTask,
}: { companyId: string; structure: Structure; schedules: Schedule[]; changed: () => void; openTask: (taskId: string) => void }) {
  const [adding, setAdding] = useState(false);
  // The schedule about to be run now. Every run reserves from the schedule's
  // budget account, so the press says how much before it spends it.
  const [running, setRunning] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false);
  // The schedule about to be removed, asked about first: removing is for good.
  const [removing, setRemoving] = useState<Schedule | null>(null);

  // Off and on again (N11). On, its next run is its next time.
  const turn = async (schedule: Schedule, enabled: boolean) => {
    try {
      await api('POST', `/api/companies/${companyId}/schedules/${schedule.id}/enabled`, { enabled });
      notifications.show({
        color: 'teal',
        message: enabled ? t('{slug} is on: its next run is its next time.', { slug: schedule.slug }) : t('{slug} is off.', { slug: schedule.slug }),
      });
      changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  const remove = async (schedule: Schedule) => {
    setBusy(true);
    try {
      await api('POST', `/api/companies/${companyId}/schedules/${schedule.id}/remove`);
      notifications.show({ color: 'teal', message: t('{slug} is removed.', { slug: schedule.slug }) });
      changed();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  };
  const zones = [...new Set([ownZone(), ...ZONES])];

  const runNow = async (schedule: Schedule) => {
    setBusy(true);
    try {
      const answer: { task: { id: string } } = await api('POST', `/api/companies/${companyId}/schedules/${schedule.id}/run`);
      notifications.show({
        color: 'teal',
        title: t('{slug} is running', { slug: schedule.slug }),
        message: <Anchor size="sm" onClick={() => openTask(answer.task.id)}>{t('Open the task')}</Anchor>,
      });
      changed();
    } catch (failure) {
      // Its last run has not ended: the refusal names that run, so it is one press away.
      const live = failure instanceof ApiError && failure.code === 'schedule.still_running'
        && typeof failure.details.taskId === 'string' ? failure.details.taskId : null;
      notifications.show({
        color: live ? 'orange' : 'red',
        title: t('Run now'),
        message: live ? (
          <Stack gap={4}>
            <Text size="sm">{explain(failure)}</Text>
            <Anchor size="sm" onClick={() => openTask(live)}>{t('Open the run in progress')}</Anchor>
          </Stack>
        ) : explain(failure),
      });
    } finally {
      setBusy(false);
      setRunning(null);
    }
  };

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
              <Table.Tr><Table.Th>{t('Schedule')}</Table.Th><Table.Th>{t('When')}</Table.Th><Table.Th>{t('Role')}</Table.Th><Table.Th>{t('Next run')}</Table.Th><Table.Th>{t('State')}</Table.Th><Table.Th /></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {schedules.map((schedule) => (
                <Table.Tr key={schedule.id}>
                  <Table.Td>
                    <Text size="sm" fw={600}>{schedule.slug}</Text>
                    <Text size="xs" c="dimmed">P{schedule.priority} · {t(OVERLAP_SAID[schedule.overlap])}</Text>
                    <Text size="xs" c="dimmed">{catchUpSaid(schedule.catchUpMinutes)}</Text>
                  </Table.Td>
                  <Table.Td>
                    {cronSaid(schedule.cron)
                      ? <Tooltip label={schedule.cron}><Text size="sm">{cronSaid(schedule.cron)}</Text></Tooltip>
                      : <Text size="sm" ff="monospace">{schedule.cron}</Text>}
                    <Text size="xs" c="dimmed">{zoneLabel(schedule.timezone)}</Text>
                  </Table.Td>
                  <Table.Td><Text size="sm">{schedule.roleName ?? schedule.roleSlug}</Text><Text size="xs" c="dimmed">{schedule.divisionName}</Text></Table.Td>
                  <Table.Td>
                    <Text size="sm">{relative(schedule.nextRunAt)}</Text>
                    {schedule.lastSkipped && <Text size="xs" c="dimmed">{skippedSaid(schedule.lastSkipped)}</Text>}
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Switch size="sm" checked={schedule.enabled} onChange={(event) => void turn(schedule, event.currentTarget.checked)}
                        aria-label={t('Turn {slug} on or off', { slug: schedule.slug })} />
                      {schedule.failure ? <Tooltip label={schedule.failure}><Badge color="red" variant="light">{t('Cannot fire')}</Badge></Tooltip>
                        : !schedule.enabled ? <Badge color="gray" variant="light">{t('Off')}</Badge>
                          : schedule.waitingFor
                            ? <Tooltip label={t('Its last run is still going. This one runs when that one finishes.')}><Badge color="yellow" variant="light">{t('Waiting')}</Badge></Tooltip>
                            : <Badge color="teal" variant="light">{t('On')}</Badge>}
                    </Group>
                  </Table.Td>
                  <Table.Td ta="right">
                    <Group gap="xs" justify="flex-end" wrap="nowrap">
                      <Button size="compact-xs" variant="light" leftSection={<IconPlayerPlay size={12} />} onClick={() => setRunning(schedule)}>
                        {t('Run now')}
                      </Button>
                      <Tooltip label={t('Remove')}>
                        <ActionIcon size="sm" variant="subtle" color="red" aria-label={t('Remove {slug}', { slug: schedule.slug })} onClick={() => setRemoving(schedule)}>
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      <Modal opened={running !== null} onClose={() => { if (!busy) setRunning(null); }} title={t('Run {slug} now', { slug: running?.slug ?? '' })} centered>
        {running && (
          <Stack>
            <Text size="sm">
              {t('It starts now, as its next occurrence would, and reserves {tokens} tokens from its budget account. Its next run does not move.', { tokens: count(running.reserveTokens) })}
            </Text>
            {/* What it may spend, not only what it sets aside to start: an
                owner read "reserves 1,000 tokens" as the cost of a run that
                spent 770 thousand (N10). */}
            <Text size="sm" fw={600}>
              {t('One run may spend up to {tokens} tokens, the most its role allows a run, and more for work it hands to other roles.', { tokens: count(running.runCeilingTokens) })}
            </Text>
            {!running.enabled && <Text size="sm" c="dimmed">{t('It is off: this runs it once and leaves it off.')}</Text>}
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setRunning(null)}>{t('Cancel')}</Button>
              <Button loading={busy} leftSection={<IconPlayerPlay size={16} />} onClick={() => void runNow(running)}>{t('Run it now')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <Modal opened={removing !== null} onClose={() => { if (!busy) setRemoving(null); }} title={t('Remove {slug}', { slug: removing?.slug ?? '' })} centered>
        {removing && (
          <Stack>
            <Text size="sm">{t('It will not run again. The work it already made stays, with what that work produced.')}</Text>
            <Group justify="flex-end">
              <Button variant="default" disabled={busy} onClick={() => setRemoving(null)}>{t('Cancel')}</Button>
              <Button color="red" loading={busy} leftSection={<IconTrash size={16} />} onClick={() => void remove(removing)}>{t('Remove it')}</Button>
            </Group>
          </Stack>
        )}
      </Modal>
      <Modal opened={adding} onClose={() => setAdding(false)} title={t('New schedule')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'roleId', label: t('Role'), type: 'select', required: true, options: structure.roles.map((role) => ({
              value: role.id, label: `${roleLabel(role)} · ${structure.divisions.find((d) => d.id === role.divisionId)?.name ?? ''}`,
            })) },
            { name: 'projectId', label: t('Project'), type: 'select', required: true, initial: structure.projects[0]?.id ?? null,
              options: structure.projects.map((project) => ({ value: project.id, label: project.name })) },
            // Every task names the goal it serves (F2.7), and the brief is what
            // each run is asked. Without them a schedule saved here could
            // never fire: its first task was refused for want of a goal.
            { name: 'goalId', label: t('Serves'), type: 'select', required: true,
              options: openGoals(structure.goals).map((goal) => ({ value: goal.id, label: goal.statement })) },
            { name: 'brief', label: t('What each run is asked to do'), type: 'textarea', required: true, wide: true,
              placeholder: t('Reconcile last week\'s invoices against the bank statement and list anything that does not match.') },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'weekly-invoices' },
            // Days and a time, not cron (N11); cron only for what these cannot say.
            { name: 'repeats', label: t('Repeats'), type: 'select', required: true, initial: 'daily', options: [
              { value: 'daily', label: t('Every day') },
              { value: 'weekdays', label: t('Every weekday, Monday to Friday') },
              ...[1, 2, 3, 4, 5, 6, 0].map((day) => ({ value: String(day), label: t('Every {day}', { day: weekday(day) }) })),
              { value: 'hourly', label: t('Every hour') },
              { value: 'custom', label: t('Custom, as cron') },
            ] },
            { name: 'at', label: t('At'), type: 'select', required: true, initial: '07:00',
              description: t('Every hour runs at this time\'s minutes.'), options: TIMES.map((time) => ({ value: time, label: time })) },
            { name: 'timezone', label: t('Time zone'), type: 'select', initial: zones[0]!, options: zones.map((zone) => ({ value: zone, label: zoneLabel(zone) })) },
            { name: 'cronExpression', label: t('Cron, for a custom schedule'), placeholder: '0 3 * * *', description: t('minute hour day month weekday') },
            { name: 'priority', label: t('Priority'), type: 'select', initial: '2', options: [
              { value: '0', label: t('P0 · first') }, { value: '1', label: 'P1' }, { value: '2', label: t('P2 · normal') }, { value: '3', label: t('P3 · last') },
            ] },
            { name: 'overlap', label: t('If the last run is still going'), type: 'select', required: true, initial: 'skip',
              description: t('A run that takes longer than the gap, or waits for you, would otherwise have a second one beside it.'),
              options: [
                { value: 'skip', label: t('Skip this one') },
                { value: 'queue', label: t('Run it when the last one finishes') },
                { value: 'allow', label: t('Run both') },
              ] },
            // The shortest window is the scheduler's floor (MIN_CATCH_UP_MINUTES):
            // shorter, and an ordinary busy pass would count as missed.
            { name: 'catchUpMinutes', label: t('If missed while PALUGADA was down'), type: 'select', required: true, initial: 'always',
              description: t('A run found later than this is dropped and noted here, so a morning briefing does not arrive in the evening.'),
              options: [
                { value: 'always', label: t('Always run it once') },
                { value: '15', label: t('Skip it if more than 15 minutes late') },
                { value: '60', label: t('Skip it if more than an hour late') },
                { value: '180', label: t('Skip it if more than 3 hours late') },
                { value: '720', label: t('Skip it if more than 12 hours late') },
                { value: '1440', label: t('Skip it if more than a day late') },
              ] },
          ]}
          submit={(values) => {
            const role = structure.roles.find((one) => one.id === values.roleId);
            const { brief, catchUpMinutes, repeats, at, cronExpression, ...rest } = values;
            return api('POST', `/api/companies/${companyId}/schedules`, {
              ...rest,
              cronExpression: cronFor(String(repeats), String(at), String(cronExpression ?? '')),
              // A new one: a short name in use is refused, not that schedule overwritten (N11).
              create: true,
              divisionId: role?.divisionId,
              // The standard roles take their work as `goal`.
              input: { goal: brief },
              ...(values.priority === undefined ? {} : { priority: Number(values.priority) }),
              catchUpMinutes: catchUpMinutes === undefined || catchUpMinutes === 'always' ? null : Number(catchUpMinutes),
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
