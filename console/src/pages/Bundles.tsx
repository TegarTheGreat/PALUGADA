/**
 * Bundles and their publishers (F16): who this installation accepts
 * signatures from, what is installed, and whether it is still what was
 * signed.
 */
import { useState } from 'react';
import { Alert, Badge, Grid, Group, Stack, Table, Text } from '@mantine/core';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import type { Publisher } from '../types.ts';
import { day } from '../format.ts';
import type { PageProps } from '../App.tsx';
import { t } from '../i18n.ts';
import { LoadFailed, Loading, Section } from '../components/ui.tsx';
import { ActionButton, ActionForm } from '../components/ActionForm.tsx';

export function Bundles({ ctx }: PageProps) {
  const { companyId } = ctx;
  const publishers = useLoad(async () => {
    const answer: { publishers: Publisher[] } = await api('GET', '/api/publishers');
    return answer.publishers;
  }, []);
  const [verdict, setVerdict] = useState<{ slug: string; intact: boolean } | null>(null);

  return (
    <Stack gap="lg">
      <Section title={t('Trusted publishers')} description={t('Trusting one vouches for everything it will ever sign. Revoking only narrows, so it needs no code.')}>
        {publishers.error ? <LoadFailed message={publishers.error} retry={publishers.reload} /> : !publishers.data ? <Loading rows={1} /> : (
          publishers.data.length === 0 ? <Text size="sm" c="dimmed" mb="md">{t('None yet. Unsigned bundles install with read-only grants.')}</Text> : (
            <Table verticalSpacing="sm" mb="md">
              <Table.Tbody>
                {publishers.data.map((publisher) => (
                  <Table.Tr key={publisher.fingerprint}>
                    <Table.Td><Text size="sm" fw={600}>{publisher.label}</Text></Table.Td>
                    <Table.Td><Text size="xs" ff="monospace" c="dimmed">{publisher.fingerprint.slice(0, 16)}</Text></Table.Td>
                    <Table.Td ta="right">
                      {publisher.revokedAt ? <Badge color="gray" variant="light">revoked {day(publisher.revokedAt)}</Badge> : (
                        <ActionButton size="xs" color="red" variant="light" label={t('Revoke')}
                          run={() => api('POST', `/api/publishers/${publisher.fingerprint}/revoke`, {})} done={publishers.reload} />
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          )
        )}
        <ActionForm
          fields={[
            { name: 'label', label: t('Name'), required: true },
            { name: 'publicKeyPem', label: t('Public key, PEM'), type: 'textarea', required: true },
          ]}
          submit={(values, proof) => api('POST', '/api/publishers', { ...values, proof })}
          factor={t('Trust a publisher')}
          action={t('Trust it')}
          success={t('Publisher trusted.')}
          done={publishers.reload}
        />
      </Section>
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Install a bundle')} description={t('An install writes divisions, roles and grants, so it is yours.')}>
            <ActionForm
              fields={[
                { name: 'slug', label: t('Bundle'), required: true, placeholder: 'content-ops' },
                { name: 'version', label: t('Version'), required: true, placeholder: '1.0.0' },
              ]}
              submit={(values, proof) => api('POST', `/api/companies/${companyId}/bundles`, { ...values, proof })}
              factor={t('Install a bundle')}
              action={t('Install')}
              success={t('Installed.')}
            />
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 6 }}>
          <Section title={t('Is it still what was signed?')} description={t('The hash recorded at install, compared with what is there now.')}>
            <ActionForm
              columns={1}
              fields={[{ name: 'slug', label: t('Bundle'), required: true }]}
              submit={async ({ slug }) => {
                const answer: { intact: boolean } = await api('GET', `/api/companies/${companyId}/bundles/${slug}/verify`);
                setVerdict({ slug: String(slug), intact: answer.intact });
              }}
              action={t('Check')}
              done={() => undefined}
            />
            {verdict && (
              <Alert mt="md" color={verdict.intact ? 'teal' : 'red'} variant="light">
                <Group gap="xs">{verdict.slug} {verdict.intact ? 'is unchanged since it was installed.' : 'has been changed since it was installed.'}</Group>
              </Alert>
            )}
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
