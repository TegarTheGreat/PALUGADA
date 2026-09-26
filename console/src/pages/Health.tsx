/**
 * What might be wrong, and the switches for it (F3.7, F3.12, F4.6, F7.5,
 * F8.13): frozen roles, reviews waiting, the platform-wide kill switch for a
 * capability, correcting something the platform believes, and the governance
 * log of who changed what.
 */
import { useState } from 'react';
import {
  Alert, Badge, Grid, Group, Paper, Stack, Table, Text, TextInput, Timeline, Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSnowflake } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { dateTime } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

export function Health({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [control, reviews, governance]: [
      { frozenRoles: Array<{ roleId: string; slug: string; frozenAt: string; reason: string | null }> },
      { reviews: Array<{ reviewerRoleSlug: string; reviewTaskId: string }> },
      { log: Array<{ subject: string; action: string; actor: string }> },
    ] = await Promise.all([
      api('GET', `/api/control?companyId=${companyId}`),
      api('GET', `/api/companies/${companyId}/reviews`),
      api('GET', `/api/companies/${companyId}/governance`),
    ]);
    return { frozen: control.frozenRoles, reviews: reviews.reviews, log: governance.log };
  }, [companyId]);
  const [capability, setCapability] = useState('');

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={4} />;
  const { frozen, reviews, log } = view.data;

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>Health</Title>
      </div>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Frozen roles" description="A role that keeps being denied freezes itself and stays frozen until you look (F3.7).">
            {frozen.length === 0 ? <Text size="sm" c="dimmed">None. Every role is allowed to work.</Text> : (
              <Stack gap="sm">
                {frozen.map((role) => (
                  <Paper key={role.roleId} withBorder radius="md" p="sm">
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap="sm" wrap="nowrap">
                        <IconSnowflake size={18} color="var(--mantine-color-blue-6)" />
                        <div>
                          <Text size="sm" fw={600}>{role.slug}</Text>
                          <Text size="xs" c="dimmed">{role.reason ?? 'Repeatedly denied'} · {dateTime(role.frozenAt)}</Text>
                        </div>
                      </Group>
                      <ActionButton size="xs" variant="light" label="Resume" factor={`Resume ${role.slug}`}
                        run={(proof) => api('POST', `/api/control/company/${companyId}/role/${role.roleId}/resume`, { proof })}
                        done={view.reload} />
                    </Group>
                  </Paper>
                ))}
              </Stack>
            )}
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Reviews waiting" description="Work another role must look at before it may act (F7.1).">
            {reviews.length === 0 ? <Text size="sm" c="dimmed">None.</Text> : (
              <Table verticalSpacing={6}>
                <Table.Tbody>
                  {reviews.map((row) => (
                    <Table.Tr key={row.reviewTaskId}><Table.Td><Text size="sm" fw={600}>{row.reviewerRoleSlug}</Text></Table.Td><Table.Td><Text size="xs" c="dimmed" ff="monospace">{row.reviewTaskId.slice(0, 8)}</Text></Table.Td></Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            )}
          </Section>
        </Grid.Col>
      </Grid>

      <Section title="Disable a capability everywhere" description="Per capability and platform-wide: a vendor that has started doing something wrong is wrong for every company (F8.13). Allowing it again takes your authenticator.">
        <Group align="flex-end" gap="xs" wrap="wrap">
          <TextInput label="Capability" placeholder="email.send" value={capability} onChange={(event) => setCapability(event.currentTarget.value)} w={280} />
          <ActionButton label="Disable it" color="red" variant="light"
            run={() => api('POST', `/api/control/capability/${capability}/kill`, { on: true })}
            done={() => notifications.show({ color: 'red', message: `${capability} is off everywhere.` })} />
          <ActionButton label="Allow it again" factor="Allow the capability again"
            run={(proof) => api('POST', `/api/control/capability/${capability}/kill`, { on: false, proof })}
            done={() => notifications.show({ color: 'teal', message: `${capability} is allowed again.` })} />
        </Group>
      </Section>

      <Section title="Correct something the platform believes" description="A fact that turned out to be wrong is replaced, not deleted (F4.6).">
        <ActionForm
          fields={[
            { name: 'memoryId', label: 'Memory', required: true, description: 'Its id, from the trace that used it' },
            { name: 'body', label: 'What is true instead', type: 'textarea', required: true },
          ]}
          submit={({ memoryId, body }) => api('POST', `/api/companies/${companyId}/memories/${memoryId}/supersede`, { body })}
          action="Replace it"
          success="Replaced. The old fact is kept, marked superseded."
        />
      </Section>

      <Section title="Governance log" description="Every change to a charter, a policy, a role or a grant, and who made it.">
        {log.length === 0 ? <Text size="sm" c="dimmed">Nothing has changed yet.</Text> : (
          <Timeline bulletSize={12} lineWidth={2} active={log.length}>
            {log.slice(-30).reverse().map((row, index) => (
              <Timeline.Item key={`${row.subject}-${index}`} title={<Text size="sm" fw={600}>{row.subject}</Text>}>
                <Group gap={6}><Badge size="xs" variant="light">{row.action}</Badge><Text size="xs" c="dimmed">by {row.actor}</Text></Group>
              </Timeline.Item>
            ))}
          </Timeline>
        )}
      </Section>

      {frozen.length > 0 && <Alert color="blue" variant="light">Resuming a role takes your authenticator: a thaw is a decision about the company, not work inside it.</Alert>}
    </Stack>
  );
}
