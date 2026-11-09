/**
 * A person's own profile (F19.2, F19.22): the handle and picture a member of
 * staff chose, and the language, time zone, quiet hours and notices everyone
 * sets for themselves. The name is the owner's to give, so a seat sees its
 * own read-only; the owner has no handle or picture, and is drawn as the
 * owner, and alone chooses whether people reach them outside the inbox.
 *
 * Kept by the owner API (`/api/me/profile`), never in the browser.
 */
import { useEffect, useState } from 'react';
import {
  Alert, Avatar, Button, Divider, Drawer, Group, Modal, NumberInput, Select, SimpleGrid, Stack, Switch, Text, TextInput, UnstyledButton,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { api, explain } from '../api.ts';
import { useLoad } from '../hooks.ts';
import { LANGUAGES, t } from '../i18n.ts';
import { PEOPLE_PICTURES, peoplePicture, personPicture } from '../images.ts';

/** What `/api/me/profile` answers. */
export interface Profile {
  principal: string;
  /** The name the owner gave a seat; null for the owner, who is drawn as the owner. */
  name: string | null;
  kind?: 'viewer' | 'member' | 'approver';
  handle: string | null;
  picture: string | null;
  language: string | null;
  timezone: string | null;
  quietStart: number | null;
  quietEnd: number | null;
  notifyInTab: boolean;
  noticesPerDay: number;
  /** The owner's alone. */
  ownerHearsPeople?: boolean;
}

/** The signed-in person's profile, read once and again when it changes. */
export function useProfile() {
  return useLoad<Profile>(() => api('GET', '/api/me/profile'), []);
}

/** A seat's kind as the console names it. */
export function kindLabel(kind: 'viewer' | 'member' | 'approver'): string {
  return kind === 'approver' ? t('Approver') : kind === 'member' ? t('Member') : t('Viewer');
}

/** What a seat of each kind may do, in a sentence: said where the owner chooses one, and where the person joins. */
export function kindAbout(kind: 'viewer' | 'member' | 'approver'): string {
  return kind === 'approver'
    ? t('Also decides what waits at tier 2 and below, and calls meetings.')
    : kind === 'member'
      ? t('Also asks for work, and answers what is put to them.')
      : t('Reads and talks.');
}

/** The twelve pictures a person chooses from: a seat's own is marked, and the one given until they choose is drawn first. */
export function PicturePicker({ principal, value, onChange }: { principal: string; value: string | null; onChange: (picture: string) => void }) {
  const drawn = personPicture(principal, value);
  return (
    <SimpleGrid cols={6} spacing="xs" verticalSpacing="xs">
      {PEOPLE_PICTURES.map((picture, index) => {
        const chosen = drawn === peoplePicture(picture);
        return (
          <UnstyledButton key={picture} onClick={() => onChange(picture)} aria-pressed={chosen}
            aria-label={t('Picture {number}', { number: index + 1 })}
            style={{ borderRadius: '50%', outline: chosen ? '3px solid var(--mantine-color-brand-6)' : 'none', outlineOffset: 2 }}>
            <Avatar src={peoplePicture(picture)} alt="" size={44} radius="xl" />
          </UnstyledButton>
        );
      })}
    </SimpleGrid>
  );
}

/** The hours of a day, for quiet hours. */
const HOURS = Array.from({ length: 24 }, (_, hour) => ({ value: String(hour), label: `${String(hour).padStart(2, '0')}:00` }));

/** The time zones this browser knows, for a person to say where they are. */
function timeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  return supported ? supported('timeZone') : [];
}

/**
 * Quiet hours: off, or from one hour until another, when nothing is sent to
 * the person but what cannot wait. The two hours are labelled "Starts at" and
 * "Ends at" rather than "From" and "Until": "From" is already an email's
 * sender, and a sentence has one translation in each language.
 */
export function QuietHours({ start, end, onChange }: {
  start: number | null; end: number | null; onChange: (start: number | null, end: number | null) => void;
}) {
  const on = start !== null && end !== null;
  return (
    <Stack gap={6}>
      <Switch label={t('Quiet hours')} description={t('Notices wait until they end.')} checked={on}
        onChange={(event) => (event.currentTarget.checked ? onChange(22, 7) : onChange(null, null))} />
      {on && (
        <Group grow>
          <Select label={t('Starts at')} data={HOURS} value={String(start)} allowDeselect={false}
            onChange={(value) => { if (value !== null) onChange(Number(value), end); }} comboboxProps={{ withinPortal: true }} />
          <Select label={t('Ends at')} data={HOURS} value={String(end)} allowDeselect={false}
            onChange={(value) => { if (value !== null) onChange(start, Number(value)); }} comboboxProps={{ withinPortal: true }} />
        </Group>
      )}
    </Stack>
  );
}

/** The language a person reads the console in: theirs, or the deployment's. */
export function LanguagePicker({ value, onChange }: { value: string | null; onChange: (language: string | null) => void }) {
  return (
    <Select
      label={t('Language')}
      data={[{ value: '', label: t("The deployment's") }, ...LANGUAGES.map((one) => ({ value: one.code, label: one.name }))]}
      value={value ?? ''}
      onChange={(next) => onChange(next ? next : null)}
      allowDeselect={false}
      comboboxProps={{ withinPortal: true }}
    />
  );
}

/** The drawer a person keeps their profile in, pressed from the menu at the foot of the sidebar. */
export function ProfileDrawer({ opened, onClose, profile, changed }: {
  opened: boolean; onClose: () => void; profile: Profile | null; changed: (profile: Profile) => void;
}) {
  const [draft, setDraft] = useState<Profile | null>(profile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (opened) { setDraft(profile); setError(null); } }, [opened, profile]);
  const zones = timeZones();
  const owner = draft?.principal === 'owner';

  const save = async () => {
    if (!draft || !profile) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        ...(owner ? {} : { language: draft.language }), timezone: draft.timezone, quietStart: draft.quietStart, quietEnd: draft.quietEnd,
        notifyInTab: draft.notifyInTab, noticesPerDay: draft.noticesPerDay,
      };
      if (!owner) {
        if (draft.handle !== profile.handle && draft.handle) body.handle = draft.handle;
        if (draft.picture !== profile.picture) body.picture = draft.picture;
      } else if (draft.ownerHearsPeople !== profile.ownerHearsPeople) {
        body.ownerHearsPeople = draft.ownerHearsPeople;
      }
      const saved: Profile = await api('POST', '/api/me/profile', body);
      changed(saved);
      notifications.show({ color: 'teal', message: t('Your profile is saved.') });
      onClose();
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer opened={opened} onClose={onClose} title={t('Your profile')} position="right" size="md">
      {draft && (
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap">
            <Avatar src={personPicture(draft.principal, draft.picture)} alt="" size={56} radius="xl" />
            <div style={{ minWidth: 0 }}>
              <Text fw={600}>{draft.name ?? t('Owner')}{draft.handle ? ` @${draft.handle}` : ''}</Text>
              <Text size="xs" c="dimmed">{owner ? t('You are drawn as the owner everywhere.') : t('The owner sets names.')}</Text>
            </div>
          </Group>
          {!owner && (
            <>
              <TextInput name="handle" label={t('Handle')} description={t('How colleagues mention you, and how you sign in.')}
                leftSection="@" value={draft.handle ?? ''} maxLength={32} autoComplete="off"
                onChange={(event) => setDraft({ ...draft, handle: event.currentTarget.value.trim().replace(/^@/, '').toLowerCase() })} />
              <div>
                <Text size="sm" fw={500} mb={6}>{t('Picture')}</Text>
                <PicturePicker principal={draft.principal} value={draft.picture} onChange={(picture) => setDraft({ ...draft, picture })} />
              </div>
            </>
          )}
          <Divider />
          {/* The owner's panel is in the deployment's language, chosen from the menu. */}
          {!owner && <LanguagePicker value={draft.language} onChange={(language) => setDraft({ ...draft, language })} />}
          <Select
            label={t('Time zone')}
            data={[{ value: '', label: t("The company's") }, ...zones.map((zone) => ({ value: zone, label: zone }))]}
            value={draft.timezone ?? ''}
            onChange={(zone) => setDraft({ ...draft, timezone: zone ? zone : null })}
            searchable
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
          <QuietHours start={draft.quietStart} end={draft.quietEnd} onChange={(quietStart, quietEnd) => setDraft({ ...draft, quietStart, quietEnd })} />
          <NumberInput label={t('Notices a day')} description={t('After this many, the rest are counted, not sent.')}
            min={0} max={200} value={draft.noticesPerDay}
            onChange={(value) => setDraft({ ...draft, noticesPerDay: typeof value === 'number' ? value : draft.noticesPerDay })} />
          <Switch label={t('Notify me in this browser')} description={t('When this tab is open but hidden, and someone writes to you or mentions you.')}
            checked={draft.notifyInTab} onChange={(event) => setDraft({ ...draft, notifyInTab: event.currentTarget.checked })} />
          {owner && (
            <Switch label={t('Hear from people outside the inbox')}
              description={t('Messages from your staff can reach your phone. They are never inbox items.')}
              checked={draft.ownerHearsPeople === true} onChange={(event) => setDraft({ ...draft, ownerHearsPeople: event.currentTarget.checked })} />
          )}
          {error && <Alert color="red" variant="light">{error}</Alert>}
          <Button loading={busy} onClick={() => void save()}>{t('Save')}</Button>
        </Stack>
      )}
    </Drawer>
  );
}

/**
 * A member of staff seated before handles signs in with their code alone,
 * and is asked once signed in to choose a handle: from then on they sign in
 * with it, and colleagues mention them by it.
 */
export function ChooseHandle({ profile, chosen }: { profile: Profile; chosen: (profile: Profile) => void }) {
  const [later, setLater] = useState(false);
  const [handle, setHandle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      chosen(await api('POST', '/api/me/profile', { handle }));
      notifications.show({ color: 'teal', message: t('From now on, sign in with @{handle} and your code.', { handle }) });
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal opened={profile.handle === null && !later} onClose={() => setLater(true)} title={t('Choose your handle')} centered>
      <Stack gap="sm">
        <Text size="sm">{t('Colleagues mention you by it, and you sign in with it and your code. Your name stays the one the owner gave you.')}</Text>
        <TextInput name="handle" label={t('Handle')} leftSection="@" value={handle} maxLength={32} autoComplete="off" data-autofocus
          onChange={(event) => setHandle(event.currentTarget.value.trim().replace(/^@/, '').toLowerCase())}
          onKeyDown={(event) => { if (event.key === 'Enter' && handle.length >= 3) void save(); }} />
        {error && <Alert color="red" variant="light">{error}</Alert>}
        <Group justify="flex-end">
          <Button variant="subtle" color="gray" onClick={() => setLater(true)}>{t('Later')}</Button>
          <Button loading={busy} disabled={handle.length < 3} onClick={() => void save()}>{t('Choose')}</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
