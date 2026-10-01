/** The small pieces every page is built from. */
import type { ReactNode } from 'react';
import {
  Alert, Badge, Button, Card, Center, Group, Image, Paper, SimpleGrid, Skeleton, Stack, Text, ThemeIcon,
  Title, Tooltip, UnstyledButton,
} from '@mantine/core';
import { useNow } from '../hooks.ts';
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { STATUS_COLORS, statusLabel } from '../format.ts';
import { N, t } from '../i18n.ts';

/**
 * The top of every page: where you are (company, then page), what the page
 * is for in one line, whether it is live, and the page's own actions on the
 * right -- the same place on every page, so nobody hunts for them.
 */
export function PageHeader({
  crumbs = [], title, description, actions, live,
}: {
  crumbs?: string[];
  title: string;
  description?: string;
  actions?: ReactNode;
  live?: Date | null;
}) {
  return (
    <Group justify="space-between" align="flex-end" mb="xl" wrap="wrap" gap="md">
      <div style={{ minWidth: 0 }}>
        {crumbs.length > 0 && (
          <Group gap={6} mb={4}>
            {crumbs.map((crumb, index) => (
              <Group gap={6} key={crumb}>
                {index > 0 && <Text size="sm" c="dimmed">/</Text>}
                <Text size="sm" c="dimmed" fw={500}>{crumb}</Text>
              </Group>
            ))}
          </Group>
        )}
        <Group gap="sm" align="center">
          <Title order={1} fz={{ base: 24, sm: 28 }} fw={750} lh={1.2}>{title}</Title>
          {live !== undefined && <LiveIndicator at={live} />}
        </Group>
        {description && <Text c="dimmed" size="sm" mt={6} maw={680}>{description}</Text>}
      </div>
      {actions && <Group gap="xs">{actions}</Group>}
    </Group>
  );
}

/** "Live · updated 5s ago": the page refreshes itself, and says when it last did. */
export function LiveIndicator({ at }: { at: Date | null }) {
  const now = useNow();
  const seconds = at ? Math.max(0, Math.round((now - at.getTime()) / 1000)) : null;
  return (
    <Tooltip label={t('This page refreshes itself while it is open')}>
      <Group gap={6} wrap="nowrap">
        <span className="live-dot" />
        <Text size="xs" c="dimmed" fw={500}>
          {seconds === null ? t('Live') : seconds < 5 ? t('Live · just updated') : t('Live · {seconds}s ago', { seconds })}
        </Text>
      </Group>
    </Tooltip>
  );
}

/**
 * Figures that belong together, in one strip with dividers rather than four
 * cards competing for the eye.
 */
/**
 * Whether a figure's value is a word ("Allowed", "Paused") rather than a
 * number: drawn at a number's size, one long word in a long language --
 * Javanese "Dipunparengaken" -- is wider than a phone's half-width card.
 */
function wordy(value: ReactNode): boolean {
  return typeof value === 'string' && !/\d/.test(value);
}

export function KpiStrip({ items }: { items: Array<{ label: string; value: ReactNode; hint?: ReactNode; alert?: boolean; onClick?: () => void }> }) {
  return (
    <Paper withBorder radius="lg" shadow="xs">
      <SimpleGrid cols={{ base: 2, md: items.length }} spacing={0}>
        {items.map((item, index) => (
          <UnstyledButton
            key={item.label}
            onClick={item.onClick}
            disabled={!item.onClick}
            className="kpi"
            data-first={index === 0 || undefined}
          >
            <Text size="xs" c="dimmed" fw={600}>{item.label}</Text>
            <Text fz={wordy(item.value) ? 16 : 28} fw={750} lh={1.25} mt={4} c={item.alert ? 'red' : undefined} className="tabular kpi-value">{item.value}</Text>
            {item.hint && <Text size="xs" c="dimmed" mt={2}>{item.hint}</Text>}
          </UnstyledButton>
        ))}
      </SimpleGrid>
    </Paper>
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
          <Text fw={800} fz={wordy(value) ? 16 : 26} lh={1.2} mt={6} c={alert ? 'red' : undefined} className="kpi-value">{value}</Text>
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
    <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title={t('Could not load this')}>
      <Group justify="space-between" gap="sm">
        <Text size="sm">{message}</Text>
        <Button size="xs" variant="light" color="red" leftSection={<IconRefresh size={14} />} onClick={retry}>
          {t('Try again')}
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
      {t('Tier {tier}', { tier })}
    </Badge>
  );
}

const KIND_COLORS: Record<string, string> = { approval: 'orange', incident: 'red', escalation: 'violet' };
const KIND_LABELS: Record<string, string> = {
  approval: N('approval'), incident: N('incident'), escalation: N('question'),
  sop_candidate: N('procedure'), skill_candidate: N('skill'), fact_candidate: N('fact'), budget_alert: N('budget'),
};

export function KindBadge({ kind }: { kind: string }) {
  const label = KIND_LABELS[kind];
  return <Badge color={KIND_COLORS[kind] ?? 'gray'} variant="dot" radius="sm">{label ? t(label) : kind}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <Badge color={STATUS_COLORS[status] ?? 'gray'} variant="light" radius="sm">
      {statusLabel(status)}
    </Badge>
  );
}
