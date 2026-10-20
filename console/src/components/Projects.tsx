/**
 * The company's projects (0074): what each is for -- which every run in it is
 * told -- how much work it holds and has cost, and closing one when its work
 * is done. A project could only be started before.
 *
 * And the language its work is in (0100): a company that sells in Malaysia
 * and in Brazil gives each project its customers' language, while its agents
 * still write to the owner in the company's one.
 */
import { useState } from 'react';
import { Badge, Button, Group, Modal, Paper, SimpleGrid, Stack, Text } from '@mantine/core';
import { IconArchive, IconArchiveOff, IconLanguage, IconPencil, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import type { Company, Structure } from '../types.ts';
import type { Languages } from '../types.ts';
import { useLoad } from '../hooks.ts';
import { money } from '../format.ts';
import { t } from '../i18n.ts';
import { ActionButton, ActionForm, type Field, type Values } from './ActionForm.tsx';
import { EmptyState, Loading } from './ui.tsx';

type Project = Structure['projects'][number];

/** The choice that means "no language of its own": the project works in the company's. */
const COMPANYS = 'company';

/**
 * A project's work language, as a field of the forms that start and edit a
 * project, from the languages agents can be told (`supported`).
 *
 * `ready` is false until the languages have loaded, and a form waits for it:
 * an edit form drawn without the field and saved would otherwise give a
 * project with its own language back to the company's. If they cannot be
 * loaded, the forms go without the field and send nothing for it, which
 * leaves the language as it was.
 */
export function useWorkLanguage(company: Company) {
  const view = useLoad(async () => {
    const answer: Languages = await api('GET', '/api/control/languages');
    return answer;
  }, []);
  const supported = view.data?.supported ?? [];
  const nameOf = (code: string) => supported.find((one) => one.code === code)?.native ?? code;
  const companys = view.data ? t("The company's ({language})", { language: nameOf(company.workLanguage ?? view.data.agents) }) : '';
  return {
    ready: view.data !== null || view.error !== null,
    nameOf,
    fields: (initial: string | null): Field[] => (view.data ? [{
      name: 'workLanguage', label: t('Work language'), type: 'select', initial: initial ?? COMPANYS, placeholder: companys,
      description: t("What this project's work for customers is written in: documents, emails, content. Agents still write to you in the company's talk language."),
      options: [
        { value: COMPANYS, label: companys },
        ...supported.map((one) => ({ value: one.code, label: one.native === one.name ? one.name : `${one.native} · ${one.name}` })),
      ],
    }] : []),
    // Cleared, or the company's: null, which the API takes as "the company's".
    chosen: (values: Values): { workLanguage?: string | null } => (view.data
      ? { workLanguage: values.workLanguage && values.workLanguage !== COMPANYS ? String(values.workLanguage) : null }
      : {}),
  };
}

export function Projects({ companyId, company, structure, changed }: {
  companyId: string; company: Company; structure: Structure; changed: () => void;
}) {
  const [editing, setEditing] = useState<Project | null>(null);
  const [starting, setStarting] = useState(false);
  const openCount = structure.projects.filter((project) => !project.archivedAt).length;
  const language = useWorkLanguage(company);

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
                {project.workLanguage && (
                  <Badge variant="light" color="grape" leftSection={<IconLanguage size={12} />}>
                    {t('Work language: {language}', { language: language.nameOf(project.workLanguage) })}
                  </Badge>
                )}
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
        {editing && !language.ready && <Loading rows={2} />}
        {editing && language.ready && (
          <ActionForm
            columns={1}
            fields={[
              { name: 'name', label: t('Name'), required: true, initial: editing.name },
              { name: 'description', label: t('What it is for'), type: 'textarea', initial: editing.description,
                description: t('Every run in this project is told this.') },
              ...language.fields(editing.workLanguage),
            ]}
            submit={(values) => api('POST', `/api/companies/${companyId}/projects/${editing.id}`, {
              name: values.name, description: values.description ?? null, ...language.chosen(values),
            })}
            success={t('Saved.')}
            done={() => { setEditing(null); changed(); }}
          />
        )}
      </Modal>

      <Modal opened={starting} onClose={() => setStarting(false)} title={t('New project')} centered>
        {!language.ready ? <Loading rows={2} /> : (
          <ActionForm
            columns={1}
            fields={[
              { name: 'name', label: t('Name'), required: true },
              { name: 'slug', label: t('Short name'), required: true, placeholder: 'wholesale-cafes' },
              ...language.fields(null),
            ]}
            submit={(values) => api('POST', `/api/companies/${companyId}/projects`, {
              name: values.name, slug: values.slug, ...language.chosen(values),
            })}
            success={t('The project is started. Work given to the company can be put in it.')}
            done={() => { setStarting(false); changed(); }}
          />
        )}
      </Modal>
    </Stack>
  );
}
