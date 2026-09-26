/**
 * Inbound triggers (0054): the URLs other services post events to.
 *
 * Opening one lets something outside the company start work, so it takes the
 * owner's device; the token it answers with is shown here once and nowhere
 * else. What an event says reaches the role as data, and anything at tier 2 or
 * above that the work then wants still comes to the owner (F8.9) -- the page
 * says so, because that is what makes opening one a reasonable thing to do.
 */
import { useState } from 'react';
import {
  Alert, Badge, Button, Code, CopyButton, Group, Modal, Stack, Table, Text, Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconCopy, IconPlus } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { relative } from '../format.ts';
import { t } from '../i18n.ts';
import type { Structure, Trigger } from '../types.ts';
import { LoadFailed, Loading, Section } from './ui.tsx';
import { ActionButton, ActionForm } from './ActionForm.tsx';

const urlOf = (publicId: string) => `${window.location.origin}/api/hooks/${publicId}`;

export function Triggers({ companyId, structure }: { companyId: string; structure: Structure }) {
  const view = useLoad(async () => {
    const answer: { triggers: Trigger[] } = await api('GET', `/api/companies/${companyId}/triggers`);
    return answer.triggers;
  }, [companyId], { every: 30_000 });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ url: string; token: string } | null>(null);

  return (
    <Section
      title={t('Triggers')}
      description={t('Let another service start work: a payment received, a form filled in, a message relayed. Each event becomes a task for the role you choose. What it says is treated as data, and anything at tier 2 or above that the work then wants still asks you.')}
      actions={<Button size="xs" leftSection={<IconPlus size={14} />} onClick={() => setAdding(true)}>{t('New trigger')}</Button>}
      padding="lg"
    >
      {view.error && !view.data ? <LoadFailed message={view.error} retry={view.reload} /> : !view.data ? <Loading rows={2} /> : view.data.length === 0 ? (
        <Text size="sm" c="dimmed">{t('No triggers. Work starts only from you, schedules and other roles.')}</Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('Trigger')}</Table.Th><Table.Th>{t('Role')}</Table.Th><Table.Th>{t('Last hour')}</Table.Th>
                <Table.Th>{t('State')}</Table.Th><Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {view.data.map((trigger) => (
                <Table.Tr key={trigger.id}>
                  <Table.Td maw={300}>
                    <Text size="sm" fw={600}>{trigger.slug}</Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>{trigger.instruction}</Text>
                  </Table.Td>
                  <Table.Td><Text size="sm">{trigger.roleSlug}</Text></Table.Td>
                  <Table.Td>
                    <Text size="sm" className="tabular">{trigger.deliveriesLastHour} / {trigger.maxPerHour}</Text>
                    {trigger.lastDeliveryAt && <Text size="xs" c="dimmed">{t('Last {when}', { when: relative(trigger.lastDeliveryAt) })}</Text>}
                  </Table.Td>
                  <Table.Td>
                    {!trigger.hasToken ? <Badge color="orange" variant="light">{t('Needs a token')}</Badge>
                      : trigger.enabled ? <Badge color="teal" variant="light">{t('Open')}</Badge>
                        : <Badge color="gray" variant="light">{t('Closed')}</Badge>}
                  </Table.Td>
                  <Table.Td>
                    <Group gap={6} justify="flex-end" wrap="nowrap">
                      <CopyButton value={urlOf(trigger.publicId)}>
                        {({ copied, copy }) => (
                          <Tooltip label={copied ? t('Copied') : t('Copy the URL')}>
                            <Button size="compact-xs" variant="subtle" onClick={copy} leftSection={<IconCopy size={12} />}>{t('URL')}</Button>
                          </Tooltip>
                        )}
                      </CopyButton>
                      <ActionButton
                        size="xs"
                        variant="subtle"
                        label={trigger.hasToken ? t('New token') : t('Make a token')}
                        run={async () => {
                          const answer: { token: string } = await api('POST', `/api/companies/${companyId}/triggers/${trigger.id}/rotate`, {});
                          setSecret({ url: urlOf(trigger.publicId), token: answer.token });
                        }}
                        done={view.reload}
                      />
                      {trigger.enabled ? (
                        <ActionButton
                          size="xs"
                          variant="subtle"
                          color="red"
                          label={t('Close')}
                          run={() => api('POST', `/api/companies/${companyId}/triggers/${trigger.id}`, { enabled: false })}
                          done={() => { notifications.show({ message: t('Closed. Events to it are refused.') }); view.reload(); }}
                        />
                      ) : (
                        <ActionButton
                          size="xs"
                          variant="subtle"
                          label={t('Open')}
                          factor={t('Open {trigger} again', { trigger: trigger.slug })}
                          run={(proof) => api('POST', `/api/companies/${companyId}/triggers/${trigger.id}`, { enabled: true, proof })}
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

      <Modal opened={adding} onClose={() => setAdding(false)} title={t('New trigger')} centered size="lg">
        <ActionForm
          fields={[
            { name: 'roleId', label: t('Role'), type: 'select', required: true, options: structure.roles.map((role) => ({
              value: role.id, label: `${role.slug} · ${structure.divisions.find((d) => d.id === role.divisionId)?.name ?? ''}`,
            })) },
            { name: 'goalId', label: t('Serves'), type: 'select', required: true, options: structure.goals.map((goal) => ({ value: goal.id, label: goal.statement })) },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'new-orders' },
            { name: 'maxPerHour', label: t('At most, per hour'), type: 'number', initial: 30 },
            { name: 'instruction', label: t('What to do with each event'), type: 'textarea', required: true, wide: true,
              placeholder: t('e.g. Confirm the order, thank the customer, and note it in the CRM.') },
          ]}
          factor={t('Let outside events start work')}
          submit={(values, proof) => api('POST', `/api/companies/${companyId}/triggers`, { ...values, proof })}
          action={t('Open it')}
          done={(result) => {
            const opened = result as { publicId: string; token: string };
            setAdding(false);
            setSecret({ url: urlOf(opened.publicId), token: opened.token });
            view.reload();
          }}
        />
      </Modal>

      <Modal opened={secret !== null} onClose={() => setSecret(null)} title={t('Give these to the other service')} centered size="lg">
        {secret && (
          <Stack>
            <Alert color="orange" variant="light">{t('Copy the token now. It is not shown again; if it is lost, make a new one.')}</Alert>
            <Secret label={t('URL')} value={secret.url} />
            <Secret label={t('Token')} value={secret.token} />
            <Text size="sm" c="dimmed">{t('The service posts JSON to the URL with the token as a bearer token. A delivery id header makes a retried delivery count once.')}</Text>
            <Code block>{curlExample(secret.url, secret.token)}</Code>
          </Stack>
        )}
      </Modal>
    </Section>
  );
}

/** A command the owner can paste to see the trigger work, built from its parts. */
function curlExample(url: string, token: string): string {
  const headers: Array<[string, string]> = [
    ['Authorization', `Bearer ${token}`], ['Content-Type', 'application/json'], ['X-Delivery-Id', 'evt_1'],
  ];
  return [
    `curl -X POST ${url}`,
    ...headers.map(([name, value]) => `  -H '${name}: ${value}'`),
    `  -d '${JSON.stringify({ order: 'A-1001' })}'`,
  ].join(' \\\n');
}

function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb={4}>{label}</Text>
      <Group wrap="nowrap" gap="xs">
        <Code style={{ flex: 1, overflowWrap: 'anywhere' }}>{value}</Code>
        <CopyButton value={value}>
          {({ copied, copy }) => (
            <Button size="compact-sm" variant="light" color={copied ? 'teal' : undefined} onClick={copy}>{copied ? t('Copied') : t('Copy')}</Button>
          )}
        </CopyButton>
      </Group>
    </div>
  );
}
