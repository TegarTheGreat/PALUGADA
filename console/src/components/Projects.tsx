/**
 * The company's projects (0074): what each is for -- which every run in it is
 * told -- how much work it holds and has cost, and closing one when its work
 * is done. A project could only be started before.
 */
import { useState } from 'react';
import { Badge, Button, Group, Modal, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArchive, IconArchiveOff, IconPencil, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import type { Structure } from '../types.ts';
import { money } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton, ActionForm } from './ActionForm.tsx';
import { EmptyState } from './ui.tsx';

type Project = Structure['projects'][number];

export function Projects({ companyId, structure, changed }: { companyId: string; structure: Structure; changed: () => void }) {
  const [editing, setEditing] = useState<Project | null>(null);
  const [starting, setStarting] = useState(false);
  const openCount = structure.projects.filter((project) => !project.archivedAt).length;

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">{t('Work given to the company belongs to a project. Say what each is for: every run in it is told.')}</Text>
        <Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setStarting(true)}>{t('New project')}</Button>
      </Group>
      {structure.projects.length === 0 ? <EmptyState title={t('No projects yet')} description={t('Start one to group the work.')} /> : (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
          {structure.projects.map((project) => (
            <Paper key={project.id} withBorder radius="md" p="md" style={project.archivedAt ? { opacity: 0.7 } : undefined}>
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Group gap="xs">
                    <Text fw={700}>{project.name}</Text>
                    {project.archivedAt && <Badge color="gray" variant="light">{t('Archived')}</Badge>}
                  </Group>
                  <Text size="sm" c={project.description ? undefined : 'dimmed'} mt={4}>
                    {project.description ?? t('No description yet. Runs in it are told only its name.')}
                  </Text>
                </div>
              </Group>
              <Group gap="xs" mt="sm">
                <Badge variant="light" color="blue">{t('{count} under way', { count: project.openTasks })}</Badge>
                <Badge variant="light" color="teal">{t('{count} done', { count: project.doneTasks })}</Badge>
                <Badge variant="light" color="gray">{money(project.costCents)}</Badge>
              </Group>
              <Group gap="xs" mt="sm">
                <Button size="compact-sm" variant="subtle" leftSection={<IconPencil size={14} />} onClick={() => setEditing(project)}>{t('Edit')}</Button>
                {project.archivedAt ? (
                  <ActionButton size="xs" variant="subtle" label={t('Open again')} leftSection={<IconArchiveOff size={14} />}
                    run={() => api('POST', `/api/companies/${companyId}/projects/${project.id}`, { archived: false })} done={changed} />
                ) : openCount > 1 && (
                  <ActionButton size="xs" variant="subtle" label={t('Archive')} leftSection={<IconArchive size={14} />}
                    run={() => api('POST', `/api/companies/${companyId}/projects/${project.id}`, { archived: true })} done={changed} />
                )}
              </Group>
            </Paper>
          ))}
        </SimpleGrid>
      )}

      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={t('Edit the project')} centered>
        {editing && (
          <ActionForm
            columns={1}
            fields={[
              { name: 'name', label: t('Name'), required: true, initial: editing.name },
              { name: 'description', label: t('What it is for'), type: 'textarea', initial: editing.description,
                description: t('Every run in this project is told this.') },
            ]}
            submit={(values) => api('POST', `/api/companies/${companyId}/projects/${editing.id}`, {
              name: values.name, description: values.description ?? null,
            })}
            success={t('Saved.')}
            done={() => { setEditing(null); changed(); }}
          />
        )}
      </Modal>

      <Modal opened={starting} onClose={() => setStarting(false)} title={t('New project')} centered>
        <ActionForm
          columns={1}
          fields={[
            { name: 'name', label: t('Name'), required: true },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'wholesale-cafes' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/projects`, values)}
          success={t('The project is started. Work given to the company can be put in it.')}
          done={() => { setStarting(false); changed(); }}
        />
      </Modal>
    </Stack>
  );
}
