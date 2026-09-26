/**
 * F3.9: a piece of configuration's versions, and the one click that puts one
 * back.
 *
 * Every change to a role or a policy was recorded, and nothing showed the
 * record or could act on it. Putting a version back goes through the same
 * write as a change, so it is itself a new version; it can widen what a role
 * may do, so it takes the owner's device.
 */
import { Badge, Code, Group, Spoiler, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { dateTime } from '../format.ts';
import { t } from '../i18n.ts';
import type { ConfigVersion } from '../types.ts';
import { LoadFailed, Loading } from './ui.tsx';
import { ActionButton } from './ActionForm.tsx';

export function ConfigHistory({ companyId, kind, subjectId, changed }: {
  companyId: string;
  kind: 'role' | 'policy';
  subjectId: string;
  changed: () => void;
}) {
  const view = useLoad(async () => {
    const answer: { versions: ConfigVersion[] } =
      await api('GET', `/api/companies/${companyId}/config/${kind}/history?subject=${subjectId}`);
    return answer.versions;
  }, [companyId, kind, subjectId]);

  if (view.error && !view.data) return <LoadFailed message={view.error} retry={view.reload} />;
  if (!view.data) return <Loading rows={2} />;
  if (view.data.length === 0) return <Text size="sm" c="dimmed">{t('No change has been recorded yet.')}</Text>;

  return (
    <Stack gap="sm">
      <Text size="xs" c="dimmed">
        {kind === 'role'
          ? t('Each version is the role as it was before that change. Putting one back is a change of its own, and is recorded.')
          : t('Each version is the policy as that change left it. Putting one back is a change of its own, and is recorded.')}
      </Text>
      {view.data.map((version, index) => (
        <Stack key={version.id} gap={4} p="sm" style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 8 }}>
          <Group justify="space-between" wrap="nowrap">
            <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
              <Badge variant="light" color={index === 0 ? 'brand' : 'gray'}>v{version.version}</Badge>
              <Text size="sm" fw={600} truncate>{version.summary}</Text>
            </Group>
            <ActionButton
              size="xs"
              variant="subtle"
              label={t('Put this back')}
              factor={t('Put back version {version}', { version: version.version })}
              run={(proof) => api('POST', `/api/companies/${companyId}/config/${kind}/rollback`, {
                subjectId, version: version.version, proof,
              })}
              done={() => {
                notifications.show({ color: 'teal', message: t('Version {version} is live again.', { version: version.version }) });
                view.reload();
                changed();
              }}
            />
          </Group>
          <Text size="xs" c="dimmed">{dateTime(version.createdAt)} · {version.changedBy}</Text>
          <Spoiler maxHeight={0} showLabel={t('What it held')} hideLabel={t('Hide')}>
            <Code block style={{ maxHeight: 220, overflow: 'auto' }}>{JSON.stringify(version.snapshot, null, 2)}</Code>
          </Spoiler>
        </Stack>
      ))}
    </Stack>
  );
}
