/**
 * Settings (F1.5, F9.5, F9.6, F11.5, F11.6, F12.5): your hours, the company's
 * cheap hours, retention, alert thresholds, your devices, freezing and
 * exporting the company.
 */
import { Badge, Button, Grid, Group, Stack, Table, Text, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconDownload, IconSnowflake, IconSnowflakeOff } from '@tabler/icons-react';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { day } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

const ZONES = ['UTC', 'Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
const zoneOptions = ZONES.map((zone) => ({ value: zone, label: zone }));

export function Settings({ ctx }: PageProps) {
  const { companyId } = ctx;
  const view = useLoad(async () => {
    const [window_, retention, authenticators]: [
      { timezone: string; startHour: number; endHour: number },
      { policy: { eventDays: number; traceDays: number; promptDays: number }; log: Array<{ action: string; rowsAffected: number; throughAt: string }> },
      { authenticators: Array<{ id: string; label: string; kind: string }> },
    ] = await Promise.all([
      api('GET', '/api/control/owner-window'),
      api('GET', `/api/companies/${companyId}/retention`),
      api('GET', '/api/mfa/authenticators'),
    ]);
    return { window: window_, retention, authenticators: authenticators.authenticators };
  }, [companyId]);

  if (view.error) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={4} />;
  const { retention, authenticators } = view.data;

  const exportCompany = async () => {
    const dump: unknown = await api('GET', `/api/companies/${companyId}/export`);
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${ctx.company.slug}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  return (
    <Stack gap="lg">
      <div>
        <Text size="sm" c="dimmed" fw={600}>{ctx.company.name}</Text>
        <Title order={2}>Settings</Title>
      </div>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Your hours" description="Nothing that is not an incident reaches you outside them (F9.3).">
            <ActionForm
              columns={3}
              fields={[
                { name: 'timezone', label: 'Time zone', type: 'select', required: true, initial: view.data.window.timezone, options: zoneOptions },
                { name: 'startHour', label: 'From', type: 'number', required: true, initial: view.data.window.startHour },
                { name: 'endHour', label: 'To', type: 'number', required: true, initial: view.data.window.endHour },
              ]}
              submit={(values) => api('POST', '/api/control/owner-window', values)}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Cheap hours" description="Work marked non-urgent, that only reads, waits for this window (F9.5).">
            <ActionForm
              columns={3}
              fields={[
                { name: 'timezone', label: 'Time zone', type: 'select', required: true, initial: 'UTC', options: zoneOptions },
                { name: 'startHour', label: 'From', type: 'number', required: true, initial: 2 },
                { name: 'endHour', label: 'To', type: 'number', required: true, initial: 5 },
              ]}
              submit={(values) => api('POST', `/api/companies/${companyId}/batch-window`, values)}
            />
          </Section>
        </Grid.Col>
      </Grid>

      <Section title="Retention" description="How long the company's history is kept. Events at least a year, prompts at least ninety days; the purge records what it removed (F11.5).">
        <ActionForm
          columns={3}
          fields={[
            { name: 'eventDays', label: 'Events, days', type: 'number', initial: retention.policy.eventDays },
            { name: 'traceDays', label: 'Traces, days', type: 'number', initial: retention.policy.traceDays },
            { name: 'promptDays', label: 'Prompts, days', type: 'number', initial: retention.policy.promptDays },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/retention`, values)}
        />
        {retention.log.length > 0 && (
          <Table mt="md" verticalSpacing={6}>
            <Table.Tbody>
              {retention.log.map((row, index) => (
                <Table.Tr key={index}><Table.Td>{row.action}</Table.Td><Table.Td>{row.rowsAffected} rows</Table.Td><Table.Td>through {day(row.throughAt)}</Table.Td></Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>

      <Section title="Alert thresholds" description="When the company tells you something is going wrong, before it becomes an incident (F11.4).">
        <ActionForm
          columns={3}
          fields={[
            { name: 'dailyCostCents', label: 'Daily cost, cents', type: 'number' },
            { name: 'taskFailureRate', label: 'Failure rate, 0 to 1', type: 'number' },
            { name: 'policyDenialsPerDay', label: 'Policy denials a day', type: 'number' },
          ]}
          submit={(values) => api('POST', `/api/companies/${companyId}/alert-thresholds`, values)}
        />
      </Section>

      <Section title="Your authenticators" description="What can approve a tier 3 action in your name. Revoking takes a code from a device that is staying, and ends every session the revoked one signed in (F12.5).">
        {authenticators.length === 0 ? <Text size="sm" c="red">None enrolled. No tier 3 action can be approved until one is.</Text> : (
          <Table verticalSpacing="sm">
            <Table.Tbody>
              {authenticators.map((one) => (
                <Table.Tr key={one.id}>
                  <Table.Td><Text size="sm" fw={600}>{one.label}</Text></Table.Td>
                  <Table.Td><Badge variant="light">{one.kind}</Badge></Table.Td>
                  <Table.Td ta="right">
                    <ActionButton size="xs" color="red" variant="subtle" label="Revoke" factor={`Revoke ${one.label}`}
                      run={(proof) => api('POST', `/api/mfa/authenticators/${one.id}/revoke`, { proof })} done={view.reload} />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        <Group mt="md">
          <ActionButton label="Sign out everywhere" run={() => api('POST', '/api/auth/sign-out-everywhere', {})} done={() => window.location.reload()} />
        </Group>
      </Section>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Freeze this company" description="Nothing of theirs starts while it is frozen; work in progress stops at its next step. Unfreezing takes your authenticator.">
            <Group>
              <ActionButton label="Freeze" color="red" variant="light" leftSection={<IconSnowflake size={16} />}
                run={() => api('POST', `/api/control/company/${companyId}/freeze`, { on: true })}
                done={() => { notifications.show({ color: 'red', message: `${ctx.company.name} is frozen.` }); void ctx.refreshCompanies(); }} />
              <ActionButton label="Unfreeze" leftSection={<IconSnowflakeOff size={16} />} factor="Unfreeze the company"
                run={(proof) => api('POST', `/api/control/company/${companyId}/freeze`, { on: false, proof })}
                done={() => { notifications.show({ color: 'teal', message: `${ctx.company.name} is running.` }); void ctx.refreshCompanies(); }} />
            </Group>
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title="Export" description="The whole company as one file, restorable on another installation with every reference remapped (F1.5, F16.4).">
            <Group><Button variant="default" leftSection={<IconDownload size={16} />} onClick={() => void exportCompany()}>Download as JSON</Button></Group>
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
