/**
 * A company's mailbox as a customer channel (0113): read over IMAP by the
 * workers, answered over SMTP by `chat.send`.
 *
 * A mailbox is not posted to, so it is read: every minute or so a worker
 * takes each open mailbox that is due -- claimed in the database, so two
 * workers never read one at once -- and reads what arrived after the last
 * message it read. Never its history: a mailbox is read from the moment it
 * was connected, and from the start of now again when the server renumbers
 * its messages (a new UIDVALIDITY), because a company's whole inbox arriving
 * as work at once is not something anybody asked for.
 *
 * Mail no person sent -- an auto-reply, a bounce, a list, the mailbox's own
 * -- starts nothing (`mime.ts` says which). A reading that fails is kept
 * where the owner sees it, said once as an event, and the mail it could not
 * read waits on the server for the next reading.
 */
import { appendEvent } from '../audit/event-log.ts';
import { withControlPlane, withTenant } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import type { SecretManager } from '../secrets/manager.ts';
import { receiveMessage, type ChatKind, type OpenChannel } from './chats.ts';
import { ImapSession, MailRefused } from './imap.ts';
import { readMail } from './mime.ts';
import { smtpSession } from './smtp.ts';
import { RECEIVED_FILE_MAX, RECEIVED_MESSAGE_MAX } from './attachments.ts';

/** Where a mailbox is. The password is the channel's sealed token. */
export interface MailSettings {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
}

export interface MailOptions {
  /** A certificate authority to trust besides the system's, for a server with a private one. */
  ca?: string;
  timeoutMs?: number;
  /** The folder every company's files are in (`PALUGADA_FILES_ROOT`): where a letter's attachments are found. */
  filesRoot?: string;
}

/** How often a mailbox is read. */
export const MAIL_POLL_EVERY_MS = 60_000;

/** The most messages read from one mailbox at one reading; the rest wait for the next. */
const MESSAGES_PER_READING = 20;

/** A message with files is fetched whole up to this size; over it, its text is read and its files are said not to be kept. */
const MESSAGE_FETCH_MAX = RECEIVED_MESSAGE_MAX;

/** Settings as the owner gave them, checked: hosts as names, ports as numbers. */
export function mailSettings(body: Record<string, unknown>, address: string): MailSettings {
  const host = (field: string) => {
    const value = typeof body[field] === 'string' ? (body[field] as string).trim().toLowerCase() : '';
    if (!/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(value) && !/^\[?[0-9a-f:.]+\]?$/.test(value)) {
      throw new PalugadaError('contract.violation', `${field} is the server's name, such as imap.gmail.com, without a scheme or a port`, { field });
    }
    return value;
  };
  const port = (field: string, fallback: number) => {
    const value = body[field] === undefined || body[field] === null || body[field] === '' ? fallback : Number(body[field]);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new PalugadaError('contract.violation', `${field} is a port number, ${fallback} for most providers`, { field });
    }
    return value;
  };
  const username = typeof body.username === 'string' && body.username.trim() ? body.username.trim() : address;
  return { imapHost: host('imapHost'), imapPort: port('imapPort', 993), smtpHost: host('smtpHost'), smtpPort: port('smtpPort', 587), username };
}

/**
 * A refusal said for the owner: the mailbox's own words -- at sign-in, that
 * it did not take the password -- or that it could not be reached.
 */
export function failureSaid(failure: unknown, settings: MailSettings, side: 'IMAP' | 'SMTP', signingIn = true): PalugadaError {
  if (failure instanceof PalugadaError) return failure;
  const server = `${side} at ${side === 'IMAP' ? settings.imapHost : settings.smtpHost}`;
  if (failure instanceof MailRefused) {
    return new PalugadaError('contract.violation', signingIn
      ? `the mailbox did not accept that address and password (${server}): ${failure.message}`
      : `the mailbox refused to be read (${server}): ${failure.message}`, {});
  }
  return new PalugadaError('capability.unreachable', (failure as Error).message, {});
}

/**
 * Signs in to both servers, sending nothing and reading nothing, and says
 * where the inbox's reading should start: after its last message now.
 */
export async function checkMailbox(settings: MailSettings, password: string, options: MailOptions = {}): Promise<{ uidValidity: number; lastUid: number }> {
  let imap: ImapSession;
  try {
    imap = await ImapSession.open({ host: settings.imapHost, port: settings.imapPort, username: settings.username, password, ...options });
  } catch (failure) {
    throw failureSaid(failure, settings, 'IMAP');
  }
  let start: { uidValidity: number; lastUid: number };
  try {
    const inbox = await imap.selectInbox();
    start = { uidValidity: inbox.uidValidity, lastUid: Math.max(0, inbox.uidNext - 1) };
  } catch (failure) {
    throw failureSaid(failure, settings, 'IMAP', false);
  } finally {
    await imap.logout();
  }
  try {
    await smtpSession({ host: settings.smtpHost, port: settings.smtpPort, username: settings.username, password, ...options });
  } catch (failure) {
    throw failureSaid(failure, settings, 'SMTP');
  }
  return start;
}

/** Sends one message from the mailbox. */
export async function sendFromMailbox(
  settings: MailSettings, password: string, message: { from: string; to: string | string[]; raw: Buffer }, options: MailOptions = {},
): Promise<string | null> {
  try {
    return await smtpSession({ host: settings.smtpHost, port: settings.smtpPort, username: settings.username, password, ...options }, message);
  } catch (failure) {
    if (failure instanceof MailRefused) {
      throw new PalugadaError('contract.violation', `the mail server refused the reply: ${failure.message}`, { transport: 'email' });
    }
    throw failure;
  }
}

interface DueMailbox extends OpenChannel {
  mail: MailSettings;
  tokenRef: string;
  pollState: { uidValidity: number; lastUid: number } | null;
  pollFailure: string | null;
}

/** Takes the mailboxes due a reading, marking them read now, so another worker skips them. */
async function claimDue(now: Date, everyMs: number, companyId: string | undefined): Promise<DueMailbox[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<{
      id: string; company_id: string; kind: ChatKind; account: string; project_id: string; division_id: string;
      role_id: string; goal_id: string; instruction: string; max_per_hour: number; webhook_hash: string;
      mail: MailSettings; token_ref: string; poll_state: DueMailbox['pollState']; poll_failure: string | null;
      answers_alone: boolean;
    }>(
      `SELECT id, company_id, kind, account, project_id, division_id, role_id, goal_id, instruction, max_per_hour,
              webhook_hash, mail, token_ref, poll_state, poll_failure, answers_alone
         FROM chat_channels
        WHERE kind = 'email' AND enabled AND (polled_at IS NULL OR polled_at <= $1::timestamptz - make_interval(secs => $2))
          AND ($3::uuid IS NULL OR company_id = $3)
        ORDER BY polled_at NULLS FIRST
        LIMIT 20
        FOR UPDATE SKIP LOCKED`,
      [now, everyMs / 1000, companyId ?? null],
    );
    if (rows.length > 0) {
      await tx.query('UPDATE chat_channels SET polled_at = $2 WHERE id = ANY($1::uuid[])', [rows.map((row) => row.id), now]);
    }
    return rows.map((row) => ({
      id: row.id, companyId: row.company_id, kind: row.kind, account: row.account, projectId: row.project_id,
      divisionId: row.division_id, roleId: row.role_id, goalId: row.goal_id, instruction: row.instruction,
      maxPerHour: row.max_per_hour, webhookHash: row.webhook_hash, accountId: null, secretRef: null,
      answersAlone: row.answers_alone, mail: row.mail, tokenRef: row.token_ref, pollState: row.poll_state, pollFailure: row.poll_failure,
    }));
  });
}

/** Reads one mailbox; the messages that reached the company's work. */
async function readMailbox(mailbox: DueMailbox, secrets: SecretManager, options: MailOptions): Promise<number> {
  const password = await secrets.resolve(mailbox.tokenRef);
  let imap: ImapSession;
  try {
    imap = await ImapSession.open({ host: mailbox.mail.imapHost, port: mailbox.mail.imapPort, username: mailbox.mail.username, password, ...options });
  } catch (failure) {
    throw failureSaid(failure, mailbox.mail, 'IMAP');
  }
  let received = 0;
  try {
    const inbox = await imap.selectInbox();
    let state = mailbox.pollState;
    if (!state || state.uidValidity !== inbox.uidValidity) {
      // Renumbered, or never read: from now on.
      state = { uidValidity: inbox.uidValidity, lastUid: Math.max(0, inbox.uidNext - 1) };
    } else {
      for (const uid of (await imap.uidsAfter(state.lastUid)).slice(0, MESSAGES_PER_READING)) {
        const first = await imap.fetchSized(uid);
        state = { uidValidity: state.uidValidity, lastUid: uid };
        if (!first) continue;
        let raw = first.raw;
        let mail = readMail(raw, { keep: true });
        const from = mail.from;
        if (!mail.fromPerson || !from || from.address === mailbox.account.toLowerCase()) continue;
        if (!mail.text && mail.attachments.length === 0) continue;
        // The first window shows that there are files; the rest of the message is fetched only for those, and only
        // when it is a size the platform keeps (a window cuts an attachment mid-way, which is no file at all).
        let tooBig = false;
        if (mail.files.length > 0 && first.size !== null && first.size > raw.length) {
          if (first.size <= MESSAGE_FETCH_MAX) {
            const whole = await imap.fetchSized(uid, first.size);
            if (whole && whole.raw.length >= first.size) {
              raw = whole.raw;
              mail = readMail(raw, { keep: true });
            } else {
              tooBig = true;
            }
          } else {
            tooBig = true;
          }
        }
        const outcome = await receiveMessage(mailbox, {
          chat: from.address,
          id: (mail.messageId ?? `uid:${inbox.uidValidity}:${uid}`).slice(0, 200),
          customerName: from.name?.slice(0, 200) ?? null,
          customerHandle: from.address,
          text: mail.text,
          attachment: mail.attachments[0] ?? null,
          subject: mail.subject || null,
          media: mail.files.map((file) => ({
            kind: file.kind, name: file.name, mime: file.mime, size: file.size,
            ...(tooBig || file.tooLarge
              ? {
                get: null, refusedWhy: 'too_big' as const,
                refused: tooBig ? `the message is over ${MESSAGE_FETCH_MAX / 1_048_576} MB, or was cut short, and its files are not fetched` : `it is over ${RECEIVED_FILE_MAX / 1_048_576} MB`,
              }
              : { get: async () => file.get() }),
          })),
          mediaOmitted: mail.filesOmitted,
        }, options.filesRoot ? { root: options.filesRoot } : undefined);
        if (outcome.outcome !== 'duplicate') received += 1;
      }
    }
    await withControlPlane((tx) => tx.query(
      'UPDATE chat_channels SET poll_state = $2, poll_failure = NULL WHERE id = $1', [mailbox.id, JSON.stringify(state)]));
    return received;
  } catch (failure) {
    throw failureSaid(failure, mailbox.mail, 'IMAP', false);
  } finally {
    await imap.logout();
  }
}

/**
 * Reads every open mailbox that is due, one after another. A mailbox that
 * fails keeps why, for the owner, said as an event the first time; the next
 * one is read regardless.
 */
export async function pollMailboxes(options: MailOptions & {
  secrets: SecretManager; now?: Date; everyMs?: number; companyId?: string;
}): Promise<{ polled: number; received: number; failed: number }> {
  const due = await claimDue(options.now ?? new Date(), options.everyMs ?? MAIL_POLL_EVERY_MS, options.companyId);
  let received = 0;
  let failed = 0;
  for (const mailbox of due) {
    try {
      received += await readMailbox(mailbox, options.secrets, options);
    } catch (failure) {
      failed += 1;
      const said = (failure as Error).message.slice(0, 1000);
      await withControlPlane(async (tx) => {
        await tx.query('UPDATE chat_channels SET poll_failure = $2 WHERE id = $1', [mailbox.id, said]);
      });
      if (mailbox.pollFailure === null) {
        await withTenant(mailbox.companyId, (tx) => appendEvent(tx, {
          companyId: mailbox.companyId, type: 'chat.mailbox_failed', actor: 'system',
          payload: { channelId: mailbox.id, account: mailbox.account, reason: said },
        }));
      }
    }
  }
  return { polled: due.length, received, failed };
}
