/**
 * A mailbox as the owner gives one: its address, its password and its two
 * servers. The same form for the mailbox customers write to (Customers) and
 * for a division's own (Team, its keys), so it reads the same in both.
 */
import { Group, NumberInput, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { t } from '../i18n.ts';

export interface Mailbox {
  address: string;
  password: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

export const EMPTY_MAILBOX: Mailbox = { address: '', password: '', imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587 };

/** Whether there is enough to try: the servers say whether it is right. */
export function mailboxFilled(mailbox: Mailbox): boolean {
  return Boolean(mailbox.address.trim() && mailbox.password && mailbox.imapHost.trim() && mailbox.smtpHost.trim());
}

/** As the API takes it. */
export function mailboxSent(mailbox: Mailbox): Mailbox {
  return { ...mailbox, address: mailbox.address.trim(), imapHost: mailbox.imapHost.trim(), smtpHost: mailbox.smtpHost.trim() };
}

export function MailboxFields({ value, onChange }: { value: Mailbox; onChange: (next: Mailbox) => void }) {
  const set = (change: Partial<Mailbox>) => onChange({ ...value, ...change });
  return (
    <Stack gap="sm">
      <TextInput label={t('The mailbox\'s address')} type="email" autoComplete="off" value={value.address}
        onChange={(event) => set({ address: event.currentTarget.value })} />
      <PasswordInput label={t('The mailbox\'s password')} autoComplete="new-password" value={value.password}
        description={t('An app password where the provider asks for one, as Gmail does. It is checked with the mail servers, then kept sealed; nobody sees it again.')}
        onChange={(event) => set({ password: event.currentTarget.value })} />
      <Group grow align="flex-start" wrap="wrap">
        <TextInput label={t('IMAP server')} placeholder="imap.gmail.com" value={value.imapHost} style={{ minWidth: 180 }}
          onChange={(event) => set({ imapHost: event.currentTarget.value })} />
        <NumberInput label={t('Port')} min={1} max={65535} value={value.imapPort} maw={110}
          onChange={(port) => set({ imapPort: typeof port === 'number' ? port : 993 })} />
      </Group>
      <Group grow align="flex-start" wrap="wrap">
        <TextInput label={t('SMTP server')} placeholder="smtp.gmail.com" value={value.smtpHost} style={{ minWidth: 180 }}
          onChange={(event) => set({ smtpHost: event.currentTarget.value })} />
        <NumberInput label={t('Port')} min={1} max={65535} value={value.smtpPort} maw={110}
          onChange={(port) => set({ smtpPort: typeof port === 'number' ? port : 587 })} />
      </Group>
      <Text size="xs" c="dimmed">{t('For Gmail: imap.gmail.com, port 993, and smtp.gmail.com, port 587.')}</Text>
    </Stack>
  );
}
