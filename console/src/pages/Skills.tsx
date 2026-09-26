/**
 * Skills (F15): what the company's roles know how to do, where each may be
 * used, and the gate a new one passes -- an eval case, a reviewer, and you.
 */
import { useState } from 'react';
import { Badge, Group, Modal, Paper, Button, Stack, Table, Tabs, Text, Title } from '@mantine/core';
import { IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Skill, Structure } from '../types.ts';
import type { PageProps } from '../App.tsx';
import { EmptyState, LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

export function Skills({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [skills, structure]: [{ skills: Skill[] }, Structure] = await Promise.all([
      api('GET', `/api/companies/${companyId}/skills`),
      api('GET', `/api/companies/${companyId}/structure`),
    ]);
    return { skills: skills.skills, structure };
  }, [companyId]);
  const [importing, setImporting] = useState(false);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading />;
  const { skills, structure } = view.data;
  const divisions = structure.divisions.map((one) => ({ value: one.id, label: one.name }));

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end">
        <div>
          <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
          <Title order={2}>Skills</Title>
        </div>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setImporting(true)}>Import a skill</Button>
      </Group>

      <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
        {skills.length === 0 ? <EmptyState title="No skills yet" description="Candidates arrive from the roles' own work, or you import one." /> : (
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm" horizontalSpacing="md" highlightOnHover>
              <Table.Thead><Table.Tr><Table.Th>Skill</Table.Th><Table.Th>Scope</Table.Th><Table.Th>Version</Table.Th><Table.Th>Origin</Table.Th><Table.Th /></Table.Tr></Table.Thead>
              <Table.Tbody>
                {skills.map((skill) => (
                  <Table.Tr key={skill.id}>
                    <Table.Td><Text size="sm" fw={600}>{skill.slug}</Text></Table.Td>
                    <Table.Td><Badge variant="light" color="blue">{skill.scopeType}</Badge></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{skill.activeVersion ?? '—'}</Text></Table.Td>
                    <Table.Td><Text size="sm" c="dimmed">{skill.origin ?? 'here'}</Text></Table.Td>
                    <Table.Td ta="right">
                      {skill.quarantined ? (
                        <Group gap="xs" justify="flex-end">
                          <Badge color="orange" variant="light">quarantined</Badge>
                          <ActionButton size="xs" variant="light" label="Lift" factor={`Lift the quarantine on ${skill.slug}`}
                            run={(proof) => api('POST', `/api/companies/${companyId}/skills/${skill.id}/quarantine/lift`, { proof })}
                            done={view.reload} />
                        </Group>
                      ) : <Badge color="teal" variant="light">active</Badge>}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>

      <Tabs defaultValue="review">
        <Tabs.List mb="md">
          <Tabs.Tab value="review">Review a version</Tabs.Tab>
          <Tabs.Tab value="scope">Widen or narrow a scope</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="review">
          <Section description="A candidate needs a reviewer and you, and no eval case means no activation -- the database refuses it (F15.3, F15.4).">
            <Stack gap="lg">
              <ActionForm
                columns={1}
                fields={[{ name: 'versionId', label: 'Version', required: true, description: 'From the decision that proposed it' }]}
                submit={async ({ versionId }, proof) => {
                  await api('POST', `/api/companies/${companyId}/skills/versions/${versionId}/review`, { approved: true });
                  await api('POST', `/api/companies/${companyId}/skills/versions/${versionId}/approve`, { proof });
                }}
                factor="Activate the skill"
                action="Approve and activate"
                success="Activated."
                done={view.reload}
              />
              <ActionForm
                fields={[
                  { name: 'versionId', label: 'Version', required: true },
                  { name: 'reason', label: 'Why not', required: true },
                ]}
                submit={({ versionId, reason }) => api('POST', `/api/companies/${companyId}/skills/versions/${versionId}/review`, { approved: false, reason })}
                action="Reject"
                success="Rejected."
                done={view.reload}
              />
            </Stack>
          </Section>
        </Tabs.Panel>
        <Tabs.Panel value="scope">
          <Section description="Widening vouches for a skill somewhere it has not been used, so it takes your authenticator (F15.5).">
            <ActionForm
              fields={[
                { name: 'skillId', label: 'Skill', type: 'select', required: true, options: skills.map((skill) => ({ value: skill.id, label: skill.slug })) },
                { name: 'scopeType', label: 'Scope', type: 'select', required: true, options: [
                  { value: 'division', label: 'One division' }, { value: 'company', label: 'This company' }, { value: 'platform', label: 'Every company' },
                ] },
                { name: 'scopeId', label: 'Division', type: 'select', description: 'For a division scope', options: divisions },
              ]}
              submit={({ skillId, ...rest }, proof) => api('POST', `/api/companies/${companyId}/skills/${skillId}/scope`, { ...rest, proof })}
              factor="Change a skill's scope"
              action="Set the scope"
              success="Scope changed."
              done={view.reload}
            />
          </Section>
        </Tabs.Panel>
      </Tabs>

      <Modal opened={importing} onClose={() => setImporting(false)} title="Import a skill from outside" centered size="lg">
        <Text size="sm" c="dimmed" mb="md">Unsigned means quarantined, and quarantine means one division (F15.8, F12.10).</Text>
        <ActionForm
          fields={[
            { name: 'slug', label: 'Short name', required: true },
            { name: 'origin', label: 'Where from', required: true, placeholder: 'https://…' },
            { name: 'divisionId', label: 'Division', type: 'select', required: true, options: divisions },
            { name: 'source', label: 'SKILL.md', type: 'textarea', required: true },
            { name: 'signature', label: 'Signature, base64' },
            { name: 'publisherKey', label: 'Publisher key, PEM', type: 'textarea' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/skills/import`, values)}
          action="Import"
          success="Imported."
          done={() => { setImporting(false); view.reload(); }}
        />
      </Modal>
    </Stack>
  );
}
