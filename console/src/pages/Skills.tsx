/**
 * Skills (F15): what the company's roles know how to do, and every step a new
 * one takes before a run follows it -- its own checks, a reviewer role, and
 * you. Every skill is here at whatever stage it is, with its text, its
 * versions and the checks it is held to; the page used to list only active
 * ones, and asked for a version's id to approve it.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Code, Drawer, Group, Modal, Paper, ScrollArea, Select, Stack, Tabs, Text, Textarea, Timeline,
  UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCertificate, IconPlus, IconUpload } from '@tabler/icons-react';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Skill, SkillDetail, SkillStage, Structure } from '../types.ts';
import type { PageProps } from '../App.tsx';
import { relative } from '../format.ts';
import { N, t } from '../i18n.ts';
import { EmptyState, LoadFailed, Loading } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

const STAGES: Record<SkillStage, { label: string; color: string }> = {
  active: { label: N('Active'), color: 'teal' },
  screening: { label: N('Being checked'), color: 'gray' },
  with_reviewer: { label: N('With the reviewer'), color: 'blue' },
  waiting_for_you: { label: N('Waiting for you'), color: 'orange' },
  rejected: { label: N('Turned down'), color: 'red' },
  superseded: { label: N('Replaced'), color: 'gray' },
};

const AUTHORS: Record<string, string> = {
  owner: N('you'), distillation: N('the company\'s own learning'), agent: N('a role'), bundle: N('a bundle or import'),
};

const TEMPLATE = `---
name: refund-policy
description: How to answer a refund request without escalating it.
---

# Refunds

Refund within 30 days of purchase.
Above Rp 3.000.000, ask the owner first.
`;

/** One phrase per line, or separated by commas. */
const phrases = (raw: string | number | undefined) => String(raw ?? '').split(/[\n,]/).map((one) => one.trim()).filter(Boolean);

function StageBadge({ skill }: { skill: Skill }) {
  const latest = skill.latest;
  if (!latest) return null;
  const stage = STAGES[latest.stage];
  return (
    <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
      {skill.activeVersion !== null && (
        <Badge color="teal" variant="light">{t('Active v{version}', { version: skill.activeVersion })}</Badge>
      )}
      {latest.stage !== 'active' && latest.stage !== 'superseded' && (
        <Badge color={stage.color} variant="light">{`v${latest.version} · ${t(stage.label)}`}</Badge>
      )}
    </Group>
  );
}

export function Skills({ ctx }: PageProps) {
  const { companyId } = ctx;
  const [division, setDivision] = useState<string | null>(null);
  const view = useLoad(async () => {
    const [skills, structure]: [{ skills: Skill[] }, Structure] = await Promise.all([
      api('GET', `/api/companies/${companyId}/skills?${new URLSearchParams(division ? { division } : {})}`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { skills: skills.skills, structure };
  }, [companyId, division]);
  const [importing, setImporting] = useState(false);
  const [writing, setWriting] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading />;
  const { skills, structure } = view.data;
  const divisions = structure.divisions.map((one) => ({ value: one.id, label: one.name }));
  const waiting = skills.filter((skill) => skill.latest?.stage === 'waiting_for_you').length;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap">
        <Select
          label={t('Division')} placeholder={t('Every division')} data={divisions} value={division}
          onChange={setDivision} clearable w={240}
        />
        <Group gap="xs">
          <Button variant="default" leftSection={<IconUpload size={16} />} onClick={() => setImporting(true)}>{t('Import a skill')}</Button>
          <Button leftSection={<IconPlus size={16} />} onClick={() => setWriting(true)}>{t('Write a skill')}</Button>
        </Group>
      </Group>

      {waiting > 0 && (
        <Alert color="orange" variant="light">
          {t('Approved by the reviewer and waiting for your yes: {count}', { count: waiting })}
        </Alert>
      )}

      {skills.length === 0 ? (
        <Paper withBorder radius="md">
          <EmptyState title={t('No skills yet')} description={t('Write one, import one, or install a bundle that brings some.')} />
        </Paper>
      ) : (
        <Stack gap="xs">
          {skills.map((skill) => (
            <UnstyledButton key={skill.id} onClick={() => setOpen(skill.id)} style={{ width: '100%' }}>
              <Paper withBorder radius="md" p="md" className="company-card">
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Group gap="sm" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
                    <IconCertificate size={20} style={{ flexShrink: 0, marginTop: 2 }} />
                    <div style={{ minWidth: 0 }}>
                      <Text fw={600} size="sm">{skill.slug}</Text>
                      <Text size="sm" c="dimmed" lineClamp={2}>{skill.summary}</Text>
                      <Group gap={6} mt={6}>
                        <Badge variant="outline" color="gray">
                          {skill.scopeType === 'division' ? skill.divisionName ?? t('One division')
                            : skill.scopeType === 'company' ? t('This company') : t('Every company')}
                        </Badge>
                        <Badge variant="outline" color={skill.checks === 0 ? 'red' : 'gray'}>
                          {t('Checks: {count}', { count: skill.checks })}
                        </Badge>
                        {skill.quarantined && <Badge color="orange" variant="light">{t('quarantined')}</Badge>}
                        {skill.origin && <Badge color="grape" variant="light">{t('from outside')}</Badge>}
                      </Group>
                    </div>
                  </Group>
                  <StageBadge skill={skill} />
                </Group>
              </Paper>
            </UnstyledButton>
          ))}
        </Stack>
      )}

      {open && (
        <SkillDrawer
          companyId={companyId} skillId={open} divisions={divisions}
          onClose={() => setOpen(null)} changed={view.reload}
          openWork={(item) => ctx.open('work', { item })}
        />
      )}

      <Modal opened={writing} onClose={() => setWriting(false)} title={t('Write a skill')} centered size="lg">
        <Text size="sm" c="dimmed" mb="md">
          {t('It is checked against the phrases you name, read by a reviewer role, and then comes back to you to switch on.')}
        </Text>
        <ActionForm
          columns={2}
          fields={[
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'refund-policy' },
            { name: 'scopeType', label: t('Applies to'), type: 'select', required: true, initial: 'division', options: [
              { value: 'division', label: t('One division') }, { value: 'company', label: t('This company') },
            ] },
            { name: 'divisionId', label: t('Division'), type: 'select', options: divisions, description: t('For a division skill') },
            { name: 'changelog', label: t('Why'), placeholder: t('What it is for, or what changed') },
            { name: 'source', label: 'SKILL.md', type: 'textarea', required: true, initial: TEMPLATE },
            { name: 'checkName', label: t('A check'), required: true, placeholder: t('names the ceiling') },
            { name: 'checkPhrases', label: t('Phrases it must contain'), type: 'textarea', required: true, description: t('One per line. Every version must still say them.') },
          ]}
          submit={({ checkName, checkPhrases, ...rest }) => api('POST', `/api/companies/${companyId}/skills`, {
            ...rest, checks: [{ name: checkName, expectContains: phrases(checkPhrases) }],
          })}
          action={t('Propose it')}
          success={t('Proposed. It is being checked.')}
          done={() => { setWriting(false); view.reload(); }}
        />
      </Modal>

      <Modal opened={importing} onClose={() => setImporting(false)} title={t('Import a skill from outside')} centered size="lg">
        <Text size="sm" c="dimmed" mb="md">{t('Unsigned means quarantined, and quarantine means one division.')}</Text>
        <ActionForm
          fields={[
            { name: 'slug', label: t('Short name'), required: true },
            { name: 'origin', label: t('Where from'), required: true, placeholder: 'https://…' },
            { name: 'divisionId', label: t('Division'), type: 'select', required: true, options: divisions },
            { name: 'source', label: 'SKILL.md', type: 'textarea', required: true },
            { name: 'signature', label: t('Signature, base64') },
            { name: 'publisherKey', label: t('Publisher key, PEM'), type: 'textarea' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/skills/import`, values)}
          action={t('Import')}
          success={t('Imported.')}
          done={() => { setImporting(false); view.reload(); }}
        />
      </Modal>
    </Stack>
  );
}

function SkillDrawer({ companyId, skillId, divisions, onClose, changed, openWork }: {
  companyId: string;
  skillId: string;
  divisions: Array<{ value: string; label: string }>;
  onClose: () => void;
  changed: () => void;
  openWork: (taskId: string) => void;
}) {
  const detail = useLoad(async (): Promise<SkillDetail> => api('GET', `/api/companies/${companyId}/skills/${skillId}`), [companyId, skillId]);
  const [shown, setShown] = useState<string | null>(null);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const reload = () => { detail.reload(); changed(); };

  const data = detail.data;
  const skill = data?.skill;
  const latest = data?.versions[0];
  const version = data?.versions.find((one) => one.id === shown) ?? latest;
  const candidate = latest && latest.state === 'candidate' ? latest : null;

  const decline = async () => {
    if (!candidate) return;
    try {
      await api('POST', `/api/companies/${companyId}/skills/versions/${candidate.id}/review`, { approved: false, reason });
      notifications.show({ color: 'teal', message: t('Turned down.') });
      setDeclining(false);
      setReason('');
      reload();
    } catch (failure) {
      notifications.show({ color: 'red', message: explain(failure) });
    }
  };

  return (
    <Drawer opened onClose={onClose} position="right" size="xl" title={<Text fw={700}>{skill?.slug ?? ''}</Text>}>
      {detail.error ? <LoadFailed message={detail.error} retry={detail.reload} /> : !data || !skill || !latest ? <Loading /> : (
        <Stack gap="md">
          <Text size="sm">{skill.summary}</Text>
          <StageBadge skill={skill} />

          {candidate?.stage === 'waiting_for_you' && (
            <Alert color="orange" variant="light" title={t('The reviewer approved version {version}', { version: candidate.version })}>
              <Stack gap="sm">
                {candidate.reviewNote && <Text size="sm">{candidate.reviewNote}</Text>}
                <Group gap="xs">
                  <ActionButton
                    label={t('Switch it on')} variant="filled" color="teal" factor={t('Activate the skill')}
                    run={(proof) => api('POST', `/api/companies/${companyId}/skills/versions/${candidate.id}/approve`, { proof })}
                    done={reload}
                  />
                  <Button variant="default" onClick={() => setDeclining(true)}>{t('Turn it down')}</Button>
                </Group>
              </Stack>
            </Alert>
          )}
          {candidate && candidate.stage !== 'waiting_for_you' && (
            <Alert color="blue" variant="light">
              <Group justify="space-between" wrap="wrap">
                <Text size="sm">
                  {candidate.stage === 'screening'
                    ? t('Version {version} is being checked against its phrases, then goes to a reviewer.', { version: candidate.version })
                    : t('Version {version} is with the reviewer. It comes to you when they approve it.', { version: candidate.version })}
                </Text>
                <Button size="xs" variant="subtle" color="red" onClick={() => setDeclining(true)}>{t('Turn it down')}</Button>
              </Group>
            </Alert>
          )}
          {latest.state === 'rejected' && (
            <Alert color="red" variant="light" title={t('Version {version} was turned down', { version: latest.version })}>
              <Text size="sm">{latest.rejectedReason}</Text>
            </Alert>
          )}
          {skill.quarantined && (
            <Alert color="orange" variant="light" title={t('Quarantined')}>
              <Group justify="space-between" wrap="wrap">
                <Text size="sm">{t('It came from {origin} and nobody here has vouched for it. It stays in one division.', { origin: skill.origin ?? t('outside') })}</Text>
                <ActionButton
                  size="xs" variant="light" label={t('Lift')} factor={t('Lift the quarantine on {skill}', { skill: skill.slug })}
                  run={(proof) => api('POST', `/api/companies/${companyId}/skills/${skill.id}/quarantine/lift`, { proof })}
                  done={reload}
                />
              </Group>
            </Alert>
          )}

          <Tabs defaultValue="text">
            <Tabs.List>
              <Tabs.Tab value="text">{t('Text')}</Tabs.Tab>
              <Tabs.Tab value="versions">{t('Versions')}</Tabs.Tab>
              <Tabs.Tab value="checks">{t('Checks')}</Tabs.Tab>
              <Tabs.Tab value="change">{t('Change it')}</Tabs.Tab>
              <Tabs.Tab value="scope">{t('Where it applies')}</Tabs.Tab>
            </Tabs.List>

            <Tabs.Panel value="text" pt="md">
              <Stack gap="sm">
                {data.versions.length > 1 && (
                  <Select
                    data={data.versions.map((one) => ({ value: one.id, label: `v${one.version} · ${t(STAGES[one.stage].label)}` }))}
                    value={version!.id} onChange={setShown} allowDeselect={false} w={260}
                  />
                )}
                <ScrollArea.Autosize mah={480}>
                  <Code block style={{ whiteSpace: 'pre-wrap' }}>{version!.body}</Code>
                </ScrollArea.Autosize>
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="versions" pt="md">
              <Timeline bulletSize={14} lineWidth={2}>
                {data.versions.map((one) => (
                  <Timeline.Item key={one.id} color={STAGES[one.stage].color}
                    title={<Group gap="xs"><Text fw={600} size="sm">v{one.version}</Text><Badge size="sm" variant="light" color={STAGES[one.stage].color}>{t(STAGES[one.stage].label)}</Badge></Group>}>
                    <Text size="xs" c="dimmed">{t('By {author}, {when}', { author: t(AUTHORS[one.author] ?? one.author), when: relative(one.createdAt) })}</Text>
                    <Text size="sm">{one.changelog}</Text>
                    {one.reviewNote && <Text size="sm" c="dimmed">{t('Reviewer: {note}', { note: one.reviewNote })}</Text>}
                    {one.rejectedReason && <Text size="sm" c="red">{one.rejectedReason}</Text>}
                    {one.reviewTaskId && (
                      <Button size="compact-xs" variant="subtle" onClick={() => openWork(one.reviewTaskId!)}>{t('Read the review')}</Button>
                    )}
                  </Timeline.Item>
                ))}
              </Timeline>
            </Tabs.Panel>

            <Tabs.Panel value="checks" pt="md">
              <Stack gap="md">
                <Text size="sm" c="dimmed">{t('Every version must still contain these phrases, or it is turned down before anyone reads it. A skill with no check can never be switched on.')}</Text>
                {data.checks.length === 0 ? <Text size="sm" c="red">{t('No checks yet.')}</Text> : data.checks.map((check) => (
                  <Paper key={check.id} withBorder radius="sm" p="sm">
                    <Text size="sm" fw={600}>{check.name}</Text>
                    <Group gap={6} mt={4}>{check.expectContains.map((phrase) => <Badge key={phrase} variant="light" color="gray">{phrase}</Badge>)}</Group>
                  </Paper>
                ))}
                <ActionForm
                  columns={1}
                  fields={[
                    { name: 'name', label: t('A check'), required: true },
                    { name: 'expectContains', label: t('Phrases it must contain'), type: 'textarea', required: true, description: t('One per line.') },
                  ]}
                  submit={({ name, expectContains }) => api('POST', `/api/companies/${companyId}/skills/${skill.id}/checks`, {
                    name, expectContains: phrases(expectContains),
                  })}
                  action={t('Add the check')}
                  success={t('Added.')}
                  done={reload}
                />
              </Stack>
            </Tabs.Panel>

            <Tabs.Panel value="change" pt="md">
              <ActionForm
                key={latest.id}
                columns={1}
                fields={[
                  { name: 'source', label: 'SKILL.md', type: 'textarea', required: true, initial: latest.body },
                  { name: 'changelog', label: t('What changed, and why'), required: true },
                ]}
                submit={(values) => api('POST', `/api/companies/${companyId}/skills`, {
                  ...values, slug: skill.slug, scopeType: skill.scopeType,
                  ...(skill.divisionId ? { divisionId: skill.divisionId } : {}),
                })}
                action={t('Propose the change')}
                success={t('Proposed. It is being checked.')}
                done={reload}
              />
            </Tabs.Panel>

            <Tabs.Panel value="scope" pt="md">
              <Stack gap="sm">
                <Text size="sm" c="dimmed">{t('Widening vouches for a skill somewhere it has not been used, so it takes your authenticator.')}</Text>
                <ActionForm
                  columns={2}
                  fields={[
                    { name: 'scopeType', label: t('Applies to'), type: 'select', required: true, initial: skill.scopeType, options: [
                      { value: 'division', label: t('One division') }, { value: 'company', label: t('This company') }, { value: 'platform', label: t('Every company') },
                    ] },
                    { name: 'scopeId', label: t('Division'), type: 'select', initial: skill.divisionId, options: divisions, description: t('For a division scope') },
                  ]}
                  submit={(values, proof) => api('POST', `/api/companies/${companyId}/skills/${skill.id}/scope`, { ...values, proof })}
                  factor={t("Change a skill's scope")}
                  action={t('Set the scope')}
                  success={t('Scope changed.')}
                  done={reload}
                />
              </Stack>
            </Tabs.Panel>
          </Tabs>
        </Stack>
      )}

      <Modal opened={declining} onClose={() => setDeclining(false)} title={t('Turn it down')} centered>
        <Stack gap="sm">
          <Textarea label={t('Why not')} value={reason} onChange={(event) => setReason(event.currentTarget.value)} autosize minRows={2} />
          <Group justify="flex-end">
            <Button color="red" onClick={() => void decline()}>{t('Turn it down')}</Button>
          </Group>
        </Stack>
      </Modal>
    </Drawer>
  );
}
