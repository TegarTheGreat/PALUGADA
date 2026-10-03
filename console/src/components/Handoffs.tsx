/**
 * Handoffs (0058): when one role finishes, another takes over.
 *
 * The owner's sentence, "when the researcher finishes, the writer takes over,
 * with this brief", instead of a rule somebody had to write in code. The next
 * role is handed what the last one produced as material beside the brief, and
 * works under its own division's grants. Making one starts work without the
 * owner asking each time, so it takes the device; switching one off does not.
 */
import { useState } from 'react';
import { Badge, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconArrowRight, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { t } from '../i18n.ts';
import { roleLabel } from '../format.ts';
import type { HandoffRule, Structure } from '../types.ts';
import { LoadFailed, Loading, Section } from './ui.tsx';
import { ActionButton, ActionForm } from './ActionForm.tsx';

export function Handoffs({ companyId, structure }: { companyId: string; structure: Structure }) {
  const view = useLoad(async () => {
    const answer: { handoffs: HandoffRule[] } = await api('GET', `/api/companies/${companyId}/handoffs`);
    return answer.handoffs;
  }, [companyId], { every: 30_000 });
  const [adding, setAdding] = useState(false);
  const roles = structure.roles.map((role) => ({
    value: role.id, label: `${roleLabel(role)} · ${structure.divisions.find((division) => division.id === role.divisionId)?.name ?? ''}`,
  }));

  return (
    <Section
      title={t('Handoffs')}
      description={t('When one role finishes, another takes over with your brief and what the first one produced. Each finished task is handed on once, and the next role works under its own division\'s grants.')}
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('New handoff')}</Button>}
      padding="lg"
    >
      {view.error && !view.data ? <LoadFailed message={view.error} retry={view.reload} /> : !view.data ? <Loading rows={2} /> : view.data.length === 0 ? (
        <Text size="sm" c="dimmed">{t('No handoffs. A finished task hands nothing on unless its role delegated the next step.')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm">
            <Table.Tbody>
              {view.data.map((rule) => (
                <Table.Tr key={rule.id}>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm" fw={600}>{rule.fromRoleName ?? rule.fromRoleSlug}</Text>
                      <IconArrowRight size={14} />
                      <Text size="sm" fw={600}>{rule.toRoleName ?? rule.toRoleSlug}</Text>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={2}>{rule.brief}</Text>
                  </Table.Td>
                  <Table.Td w={90}>
                    {rule.enabled ? <Badge color="teal" variant="light">{t('On')}</Badge> : <Badge color="gray" variant="light">{t('Off')}</Badge>}
                  </Table.Td>
                  <Table.Td w={120}>
                    <Group justify="flex-end">
                      {rule.enabled ? (
                        <ActionButton
                          size="xs" variant="subtle" color="red" label={t('Switch off')}
                          run={() => api('POST', `/api/companies/${companyId}/handoffs/${rule.id}`, { enabled: false })}
                          done={view.reload}
                        />
                      ) : (
                        <ActionButton
                          size="xs" variant="subtle" label={t('Switch on')}
                          factor={t('Switch the handoff to {role} back on', { role: rule.toRoleName ?? rule.toRoleSlug })}
                          run={(proof) => api('POST', `/api/companies/${companyId}/handoffs/${rule.id}`, { enabled: true, proof })}
                          done={view.reload}
                        />
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}

      <Modal opened={adding} onClose={() => setAdding(false)} title={t('New handoff')} centered size="lg">
        <Stack>
          <ActionForm
            fields={[
              { name: 'fromRoleId', label: t('When this role finishes'), type: 'select', required: true, options: roles },
              { name: 'toRoleId', label: t('This role takes over'), type: 'select', required: true, options: roles },
              { name: 'brief', label: t('With this brief'), type: 'textarea', required: true, wide: true,
                placeholder: t('e.g. Turn the findings into a one-page brief for the owner, with the three numbers that matter.') },
            ]}
            factor={t('Let one role start work for another')}
            submit={(values, proof) => api('POST', `/api/companies/${companyId}/handoffs`, { ...values, proof })}
            action={t('Chain them')}
            done={() => {
              setAdding(false);
              notifications.show({ color: 'teal', message: t('Chained. The next finished task is handed on.') });
              view.reload();
            }}
          />
        </Stack>
      </Modal>
    </Section>
  );
}
