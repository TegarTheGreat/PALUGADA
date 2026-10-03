/**
 * Everything an owner sets up and rarely changes, in one place with its own
 * list of sections -- rather than seven pages in the sidebar competing with
 * the ones visited every day. Each section keeps its own address
 * (`#/c/<company>/settings/<section>`), so a link can open it directly.
 */
import { Grid, NavLink, Paper, ScrollArea, SegmentedControl, Stack, Text } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import {
  IconBuilding, IconCertificate, IconDevices, IconLanguage, IconLock, IconPackage, IconShieldCheck, IconUsers,
} from '@tabler/icons-react';
import { N, t } from '../i18n.ts';
import type { SettingsSection } from '../router.ts';
import type { PageProps } from '../App.tsx';
import { PageHeader } from '../components/ui.tsx';
import { CompanySettings, LanguageSettings, SecuritySettings } from './Settings.tsx';
import { Health } from './Health.tsx';
import { Skills } from './Skills.tsx';
import { Bundles } from './Bundles.tsx';
import { Devices } from './Devices.tsx';
import { People } from './People.tsx';

const SECTIONS: Array<{ id: SettingsSection; label: string; hint: string; icon: typeof IconBuilding }> = [
  { id: 'company', label: N('Company'), hint: N('Hours, retention, alerts, freezing, export and closing.'), icon: IconBuilding },
  { id: 'language', label: N('Languages'), hint: N('The panel, and what the agents write in.'), icon: IconLanguage },
  { id: 'safeguards', label: N('Safeguards'), hint: N('Frozen roles, reviews waiting, kill switches and who changed what.'), icon: IconShieldCheck },
  { id: 'skills', label: N('Skills'), hint: N('Procedures the agents can read, and who vouched for them.'), icon: IconCertificate },
  { id: 'bundles', label: N('Bundles'), hint: N('Packages of roles and skills, and the publishers you trust.'), icon: IconPackage },
  { id: 'devices', label: N('Devices'), hint: N('Machines that run agents for this company.'), icon: IconDevices },
  { id: 'people', label: N('People'), hint: N('Staff who can follow this company, and approve what is small.'), icon: IconUsers },
  { id: 'security', label: N('Security'), hint: N('Your authenticators and sessions.'), icon: IconLock },
];

export function SettingsHub({ ctx, route }: PageProps) {
  const narrow = useMediaQuery('(max-width: 62em)') ?? false;
  const section = SECTIONS.find((one) => one.id === route.section) ?? SECTIONS[0]!;
  const pick = (id: SettingsSection) => ctx.open('settings', { section: id });

  const body = (() => {
    switch (section.id) {
      case 'company': return <CompanySettings ctx={ctx} />;
      case 'language': return <LanguageSettings ctx={ctx} />;
      case 'safeguards': return <Health ctx={ctx} route={route} />;
      case 'skills': return <Skills ctx={ctx} route={route} />;
      case 'bundles': return <Bundles ctx={ctx} route={route} />;
      case 'devices': return <Devices ctx={ctx} route={route} />;
      case 'people': return <People ctx={ctx} />;
      case 'security': return <SecuritySettings />;
    }
  })();

  return (
    <Stack gap="lg">
      <PageHeader
        crumbs={[ctx.company.name, t('Settings')]}
        title={t(section.label)}
        description={t(section.hint)}
      />
      {narrow ? (
        <ScrollArea type="never">
          <SegmentedControl
            value={section.id}
            onChange={(value) => pick(value as SettingsSection)}
            data={SECTIONS.map((one) => ({ value: one.id, label: t(one.label) }))}
          />
        </ScrollArea>
      ) : null}
      <Grid gap="xl">
        {!narrow && (
          <Grid.Col span={3}>
            <Paper withBorder radius="lg" p="xs" pos="sticky" top={24}>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" px="sm" pt={6} pb={4}>{t('Settings')}</Text>
              {SECTIONS.map((one) => (
                <NavLink
                  key={one.id}
                  label={t(one.label)}
                  leftSection={<one.icon size={18} stroke={1.7} />}
                  active={one.id === section.id}
                  onClick={() => pick(one.id)}
                  className="nav-link"
                />
              ))}
            </Paper>
          </Grid.Col>
        )}
        <Grid.Col span={narrow ? 12 : 9}>{body}</Grid.Col>
      </Grid>
    </Stack>
  );
}
