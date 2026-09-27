/**
 * Inbound triggers (0054, 0056): the URLs other services post events to.
 *
 * Opening one lets something outside the company start work, so it takes the
 * owner's device. A caller proves itself with a token the platform makes --
 * shown here once and nowhere else -- or, for the senders that sign their
 * deliveries (Stripe, GitHub, Slack, Standard Webhooks), with its signature,
 * checked with a secret the owner keeps in the deployment's secret store and
 * names here by reference. What an event says reaches the role as data, and
 * anything at tier 2 or above that the work then wants still comes to the
 * owner (F8.9) -- the page says so, because that is what makes opening one a
 * reasonable thing to do.
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
import type { Structure, Trigger, TriggerScheme } from '../types.ts';
import { LoadFailed, Loading, Section } from './ui.tsx';
import { ActionButton, ActionForm } from './ActionForm.tsx';
import { openGoals } from '../goals.ts';

const urlOf = (publicId: string) => `${window.location.origin}/api/hooks/${publicId}`;

/** Who can call, as the owner picks it. */
const schemes = (): Array<{ value: TriggerScheme; label: string }> => [
  { value: 'bearer', label: t('A token, from any service') },
  { value: 'stripe', label: t('Stripe payments') },
  { value: 'github', label: t('GitHub events') },
  { value: 'slack', label: t('Slack events and commands') },
  { value: 'standard', label: t('Standard Webhooks (Svix, Resend, Clerk)') },
];

/** A trigger's scheme in a word, for the list. */
const shortName = (scheme: TriggerScheme): string => ({
  bearer: t('Token'), stripe: t('Stripe'), github: t('GitHub'), slack: t('Slack'), standard: t('Standard Webhooks'),
})[scheme];

/** Where, in the sender's own settings, the URL goes. */
function whereItGoes(scheme: TriggerScheme): string {
  switch (scheme) {
    case 'stripe': return t('In Stripe: Developers, Webhooks, Add endpoint. Paste the URL, then put the signing secret Stripe shows where the reference you gave points.');
    case 'github': return t('In GitHub: Settings, Webhooks, Add webhook. Paste the URL, choose application/json, and set the secret to the value the reference you gave points to.');
    case 'slack': return t('In Slack: your app\'s Event Subscriptions or slash command. Paste the URL; the signing secret on the app\'s Basic Information page must be what the reference you gave points to.');
    case 'standard': return t('In the sender\'s webhook settings: paste the URL, then put the signing secret it shows (whsec_…) where the reference you gave points.');
    default: return t('The service posts JSON, a form or text to the URL with the token as a bearer token. A delivery id header makes a retried delivery count once.');
  }
}

export function Triggers({ companyId, structure }: { companyId: string; structure: Structure }) {
  const view = useLoad(async () => {
    const answer: { triggers: Trigger[] } = await api('GET', `/api/companies/${companyId}/triggers`);
    return answer.triggers;
  }, [companyId], { every: 30_000 });
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ url: string; token: string | null; scheme: TriggerScheme } | null>(null);
  const [moving, setMoving] = useState<Trigger | null>(null);

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
                    <Group gap={6}>
                      <Text size="sm" fw={600}>{trigger.slug}</Text>
                      <Badge size="xs" variant="outline" color="gray">{shortName(trigger.scheme)}</Badge>
                    </Group>
                    <Text size="xs" c="dimmed" lineClamp={2}>{trigger.instruction}</Text>
                    {trigger.secretRef && <Text size="xs" c="dimmed" ff="monospace">{trigger.secretRef}</Text>}
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
                      {trigger.scheme === 'bearer' ? (
                        <ActionButton
                          size="xs"
                          variant="subtle"
                          label={trigger.hasToken ? t('New token') : t('Make a token')}
                          run={async () => {
                            const answer: { token: string } = await api('POST', `/api/companies/${companyId}/triggers/${trigger.id}/rotate`, {});
                            setSecret({ url: urlOf(trigger.publicId), token: answer.token, scheme: trigger.scheme });
                          }}
                          done={view.reload}
                        />
                      ) : (
                        <Button size="compact-xs" variant="subtle" onClick={() => setMoving(trigger)}>{t('Secret')}</Button>
                      )}
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
            { name: 'goalId', label: t('Serves'), type: 'select', required: true, options: openGoals(structure.goals).map((goal) => ({ value: goal.id, label: goal.statement })) },
            { name: 'slug', label: t('Short name'), required: true, placeholder: 'new-orders' },
            { name: 'maxPerHour', label: t('At most, per hour'), type: 'number', initial: 30 },
            { name: 'scheme', label: t('Who calls it'), type: 'select', required: true, initial: 'bearer', options: schemes() },
            { name: 'secretRef', label: t('Where the signing secret is kept'), placeholder: 'env://PALUGADA_SECRET_STRIPE_HOOK',
              description: t('Only for a service that signs. A reference to the deployment\'s secret store, never the secret itself; it is read now to check it is there.') },
            { name: 'instruction', label: t('What to do with each event'), type: 'textarea', required: true, wide: true,
              placeholder: t('e.g. Confirm the order, thank the customer, and note it in the CRM.') },
          ]}
          factor={t('Let outside events start work')}
          submit={async (values, proof) => ({
            ...((await api('POST', `/api/companies/${companyId}/triggers`, { ...values, proof })) as { publicId: string; token: string | null }),
            scheme: values.scheme as TriggerScheme,
          })}
          action={t('Open it')}
          done={(result) => {
            const opened = result as { publicId: string; token: string | null; scheme: TriggerScheme };
            setAdding(false);
            setSecret({ url: urlOf(opened.publicId), token: opened.token, scheme: opened.scheme });
            view.reload();
          }}
        />
      </Modal>

      <Modal opened={secret !== null} onClose={() => setSecret(null)} title={t('Give these to the other service')} centered size="lg">
        {secret && (
          <Stack>
            {secret.token && <Alert color="orange" variant="light">{t('Copy the token now. It is not shown again; if it is lost, make a new one.')}</Alert>}
            <Secret label={t('URL')} value={secret.url} />
            {secret.token && <Secret label={t('Token')} value={secret.token} />}
            <Text size="sm" c="dimmed">{whereItGoes(secret.token ? 'bearer' : secret.scheme)}</Text>
            {secret.token && <Code block>{curlExample(secret.url, secret.token)}</Code>}
          </Stack>
        )}
      </Modal>

      <Modal opened={moving !== null} onClose={() => setMoving(null)} title={t('Where the signing secret is kept')} centered>
        {moving && (
          <Stack>
            <Text size="sm" c="dimmed">{t('Change the secret in the store itself and deliveries are checked with the new one at once. Give a new reference only if the secret has moved.')}</Text>
            <Text size="sm">{whereItGoes(moving.scheme)}</Text>
            <ActionForm
              columns={1}
              fields={[{ name: 'secretRef', label: t('Reference'), required: true, initial: moving.secretRef ?? '' }]}
              submit={(values) => api('POST', `/api/companies/${companyId}/triggers/${moving.id}/rotate`, values)}
              action={t('Save')}
              done={() => { setMoving(null); view.reload(); }}
            />
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
