/** The small pieces every page is built from. */
import type { ReactNode } from 'react';
import {
  Alert, Badge, Button, Card, Center, Group, Image, Paper, Skeleton, Stack, Text, ThemeIcon, Title,
} from '@mantine/core';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { STATUS_COLORS, STATUS_LABELS, humanize } from '../format.ts';

export function PageHeader({
  title, description, actions,
}: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <Group justify="space-between" align="flex-end" mb="lg" wrap="wrap" gap="md">
      <div>
        <Title order={2} fw={800}>{title}</Title>
        {description && <Text c="dimmed" size="sm" mt={4} maw={640}>{description}</Text>}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

export function Section({
  title, description, actions, children, padding = 'lg',
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  padding?: 'md' | 'lg' | 0;
}) {
  return (
    <Card withBorder radius="md" padding={padding} shadow="xs">
      {(title || actions) && (
        <Group justify="space-between" align="flex-start" mb="md" gap="sm" px={padding === 0 ? 'lg' : 0} pt={padding === 0 ? 'lg' : 0}>
          <div>
            {title && <Text fw={700}>{title}</Text>}
            {description && <Text c="dimmed" size="sm" mt={2}>{description}</Text>}
          </div>
          {actions}
        </Group>
      )}
      {children}
    </Card>
  );
}

export function StatCard({
  label, value, hint, icon, color = 'blue', alert = false,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  color?: string;
  alert?: boolean;
}) {
  return (
    <Paper withBorder radius="md" p="md" shadow="xs">
      <Group justify="space-between" align="flex-start" wrap="nowrap">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={700}>{label}</Text>
          <Text fw={800} fz={26} lh={1.2} mt={6} c={alert ? 'red' : undefined}>{value}</Text>
        </div>
        {icon && <ThemeIcon variant="light" color={color} size={38} radius="md">{icon}</ThemeIcon>}
      </Group>
      {hint && <Text size="xs" c="dimmed" mt="xs">{hint}</Text>}
    </Paper>
  );
}

export function EmptyState({
  title, description, image, action,
}: { title: string; description?: string; image?: string; action?: ReactNode }) {
  return (
    <Center py={48} px="md">
      <Stack align="center" gap="xs" maw={420} ta="center">
        {image && <Image src={image} alt="" w={240} h="auto" mb="sm" />}
        <Text fw={700} size="lg">{title}</Text>
        {description && <Text c="dimmed" size="sm">{description}</Text>}
        {action && <div style={{ marginTop: 8 }}>{action}</div>}
      </Stack>
    </Center>
  );
}

export function LoadFailed({ message, retry }: { message: string; retry: () => void }) {
  return (
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title="Could not load this">
      <Group justify="space-between" gap="sm">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" color="red" leftSection={<IconRefresh size={14} />} onClick={retry}>
          Try again
        </Button>
      </Group>
    </Alert>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <Stack gap="sm">
      {Array.from({ length: rows }, (_, index) => <Skeleton key={index} height={64} radius="md" />)}
    </Stack>
  );
}

/*
 * The tier is the single most important thing on a decision: it is the
 * difference between a question and a payment that cannot be recalled. So it
 * is the badge that carries colour, and tier 3 is the only filled one.
 */
export function TierBadge({ tier }: { tier: number | null }) {
  if (tier === null) return null;
  const tone = ['gray', 'blue', 'orange', 'red'][tier] ?? 'gray';
  return (
    <Badge color={tone} variant={tier === 3 ? 'filled' : 'light'} radius="sm">
      Tier {tier}
    </Badge>
  );
}

const KIND_COLORS: Record<string, string> = { approval: 'orange', incident: 'red', escalation: 'violet' };

export function KindBadge({ kind }: { kind: string }) {
  return <Badge color={KIND_COLORS[kind] ?? 'gray'} variant="dot" radius="sm">{kind}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge color={STATUS_COLORS[status] ?? 'gray'} variant="light" radius="sm">
      {STATUS_LABELS[status] ?? humanize(status)}
    </Badge>
  );
}
