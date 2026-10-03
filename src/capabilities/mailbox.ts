/**
 * `mailbox.read` and `email.send` with a division's own mailbox, over IMAP
 * and SMTP (the tools research of 3 October, recommendation 1).
 *
 * Mail is the one thing every company does, and until this both were
 * catalogued with nothing behind them unless the operator wrote a vendor
 * entry for a sending service -- which sends, but cannot read, and sends
 * from a domain set up with that service rather than from the mailbox the
 * company already has. A standard protocol reaches any mailbox: Gmail with
 * an app password, a hosting provider's, the company's own server.
 *
 * **The mailbox is the division's key.** Aliased `mailbox`, sealed like any
 * key (F12.3) and declared with the scopes its capabilities need (F12.6), so
 * Sales can hold sales@ and Support support@. It is more than a string to
 * paste -- an address, a password and two servers -- so the console asks for
 * it in a form, and the servers are asked to take the password before
 * anything is sealed (`credentialForm`).
 *
 * **Reading leaves the mailbox as it was.** A folder is opened read-only
 * (EXAMINE) and a message fetched with BODY.PEEK, so mail a role read is
 * still unread in the owner's own mail client, and nothing a role asks can
 * move, flag or delete one. Every word of a search goes as a quoted string
 * or a counted literal, never as a line break that could start another
 * command.
 *
 * **Sending is tier 2**, as the catalogue says: a message cannot be called
 * back. Work that has read from outside -- the mailbox itself, so every
 * reply -- asks the owner first (F8.9), as can a policy for every letter;
 * the card names who it goes to and what it is about. The letter is from
 * the mailbox's own address, named for the company, in plain text. Its
 * read-back is the server's acceptance (`250 … queued`), which is all SMTP
 * gives: whether a copy is kept in Sent is the provider's (Gmail keeps one,
 * many hosts do not). Its Message-ID is made from the call's idempotency
 * key, so a call made again after a crash is the same message to a mail
 * client, which shows it once.
 *
 * Both give way to a service bound for the same name (`fallback`): a vendor
 * entry for `email.send` is the one used, as before.
 */
import { createHash } from 'node:crypto';
import type { Capability, CapabilityContext } from '../broker/registry.ts';
import { withTenant } from '../db/tenant.ts';
import { isPalugadaError, PalugadaError } from '../errors.ts';
import { FETCH_MAX_BYTES, ImapSession, MailRefused } from '../chats/imap.ts';
import { failureSaid, mailSettings, type MailOptions, type MailSettings } from '../chats/mail.ts';
import { readMail, type Mail } from '../chats/mime.ts';
import { composeMail, smtpSession } from '../chats/smtp.ts';
import { recipientDomainOf } from './vendors.ts';

/** The division's key both capabilities sign in with. */
const MAILBOX_ALIAS = 'mailbox';

/** The most messages one listing returns, and how many when none is asked for. */
const LIST_MAX = 20;
const LIST_DEFAULT = 10;
/** The most of a message's text a listing shows. */
const SNIPPET_MAX = 300;
/** The most a letter is addressed to, on To and on Cc. */
const RECIPIENTS_MAX = 10;
const TEXT_MAX = 20_000;

/** An address as SMTP takes one: no name, no list, no space, ASCII. */
const ADDRESS = "^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$";
/** Text with no control character, so none can end a line of the protocol early. */
const ONE_LINE = '^[^\\u0000-\\u001f\\u007f]+$';

interface MailboxAccount extends MailSettings {
  address: string;
  password: string;
}

function wrong(message: string, field: string): PalugadaError {
  return new PalugadaError('contract.violation', message, { field });
}

/** The account a `mailbox` key holds, from the console's form or as it was sealed. */
function accountFrom(value: string): MailboxAccount {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(value) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch {
    throw wrong('a mailbox is given in its form -- its address, its password and its two servers -- not pasted as a key', 'value');
  }
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!new RegExp(ADDRESS).test(address)) throw wrong('address is the mailbox\'s address, such as sales@yourshop.com', 'address');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length === 0 || password.length > 1_000) {
    throw wrong('password is the mailbox\'s password, or an app password where the provider asks for one, as Gmail does', 'password');
  }
  return { address, password, ...mailSettings(body, address) };
}

/** The one shape a mailbox is sealed in. */
function sealedFrom(account: MailboxAccount): string {
  const { address, password, username, imapHost, imapPort, smtpHost, smtpPort } = account;
  return JSON.stringify({ mailbox: 1, address, password, username, imapHost, imapPort, smtpHost, smtpPort });
}

async function accountOf(ctx: Pick<CapabilityContext, 'credential'>): Promise<MailboxAccount> {
  try {
    return accountFrom(await ctx.credential(MAILBOX_ALIAS));
  } catch (failure) {
    if (isPalugadaError(failure, 'capability.not_granted')) {
      throw new PalugadaError('capability.not_granted',
        'this division has no mailbox yet: ask the owner for it with owner.ask, naming key "mailbox"', { alias: MAILBOX_ALIAS });
    }
    throw failure;
  }
}

async function signIn(account: MailboxAccount, options: MailOptions): Promise<ImapSession> {
  try {
    return await ImapSession.open({ host: account.imapHost, port: account.imapPort, username: account.username, password: account.password, ...options });
  } catch (failure) {
    throw failureSaid(failure, account, 'IMAP');
  }
}

/** Signs in to both servers and opens the inbox read-only, sending and changing nothing. */
async function checkAccount(account: MailboxAccount, options: MailOptions, sides: { imap: boolean; smtp: boolean }): Promise<void> {
  if (sides.imap) {
    const session = await signIn(account, options);
    try {
      await session.examine('INBOX');
    } catch (failure) {
      throw failureSaid(failure, account, 'IMAP', false);
    } finally {
      await session.logout();
    }
  }
  if (sides.smtp) {
    try {
      await smtpSession({ host: account.smtpHost, port: account.smtpPort, username: account.username, password: account.password, ...options });
    } catch (failure) {
      throw failureSaid(failure, account, 'SMTP');
    }
  }
}

/** A preflight (F8.12): a mailbox not given yet is not a failure, one that will not open is. */
function preflightFor(name: string, options: MailOptions, sides: { imap: boolean; smtp: boolean }): NonNullable<Capability['preflight']> {
  return async (ctx) => {
    if (!ctx.credential) return { ok: false, detail: 'no secret manager to read the mailbox key with' };
    let value: string;
    try {
      value = await ctx.credential(MAILBOX_ALIAS, name);
    } catch (failure) {
      // A role whose tools include the mailbox does other work too, and is
      // not held up by a mailbox nobody has given yet; the call says so.
      if (isPalugadaError(failure, 'capability.not_granted')) return { ok: true, detail: 'no mailbox has been given to this division yet' };
      return { ok: false, detail: (failure as Error).message };
    }
    try {
      await checkAccount(accountFrom(value), options, sides);
      return { ok: true };
    } catch (failure) {
      const unreachable = isPalugadaError(failure, 'capability.unreachable');
      return { ok: false, detail: (failure as Error).message, ...(unreachable ? { transient: true } : {}) };
    }
  };
}

function credentialForm(options: MailOptions): NonNullable<Capability['credentialForm']> {
  return {
    kind: 'mailbox',
    parse: (value) => sealedFrom(accountFrom(value)),
    check: (value) => checkAccount(accountFrom(value), options, { imap: true, smtp: true }),
  };
}

function sender(from: Mail['from']): string {
  if (!from) return '';
  return from.name ? `${from.name} <${from.address}>` : from.address;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_MAX ? `${flat.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : flat;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 2026-10-02 as IMAP's SINCE takes a day: 2-Oct-2026. */
function imapDay(day: string): string {
  const at = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const date = at ? new Date(Date.UTC(Number(at[1]), Number(at[2]) - 1, Number(at[3]))) : null;
  if (!at || !date || date.getUTCDate() !== Number(at[3])) throw wrong('since is a day, such as 2026-10-02', 'since');
  return `${date.getUTCDate()}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
}

/** A word to search for: one line, so it cannot end the command it is in. */
function searchWord(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  const text = String(value);
  if (!text.trim() || text.length > 200 || !new RegExp(ONE_LINE, 'u').test(text)) {
    throw wrong(`${field} is a word or two to look for, on one line`, field);
  }
  return text.trim();
}

export interface MailboxReadInput {
  folder?: string;
  uid?: number;
  from?: string;
  subject?: string;
  since?: string;
  unread?: boolean;
  limit?: number;
}

function mailboxRead(options: MailOptions): Capability<MailboxReadInput, unknown> {
  return {
    name: 'mailbox.read',
    adapter: 'platform:mail',
    defaultTier: 0,
    readsOutside: true,
    credentialAlias: MAILBOX_ALIAS,
    credentialForm: credentialForm(options),
    requiredScopes: ['mail:read'],
    fallback: true,
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', minLength: 1, maxLength: 200, pattern: '^[\\x20-\\x7e]+$', description: 'The folder, as the mail server names it. INBOX unless given; Sent, for instance, on most servers.' },
        uid: { type: 'integer', minimum: 1, description: 'One message to read whole, by the uid a listing gave.' },
        from: { type: 'string', minLength: 1, maxLength: 200, pattern: ONE_LINE, description: 'Only mail whose sender contains this: a name, an address, a domain.' },
        subject: { type: 'string', minLength: 1, maxLength: 200, pattern: ONE_LINE, description: 'Only mail whose subject contains this.' },
        since: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only mail that arrived on this day or after, such as 2026-10-02.' },
        unread: { type: 'boolean', description: 'Only mail nobody has read yet.' },
        limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `How many, newest first; ${LIST_DEFAULT} unless given.` },
      },
      additionalProperties: false,
      description: 'Lists the division\'s mail, newest first -- each with who sent it, its subject, when, whether it is unread and how it begins -- '
        + 'or, given a uid, reads that message whole. Reading marks nothing read and changes nothing in the mailbox.',
    },
    describe: () => ({ moneyCents: 0 }),
    preflight: preflightFor('mailbox.read', options, { imap: true, smtp: false }),
    async execute(input, ctx) {
      const folder = input.folder ?? 'INBOX';
      if (!/^[\x20-\x7e]{1,200}$/.test(folder)) {
        throw wrong('folder is a folder\'s name as the mail server gives it, such as INBOX or Sent; one with letters outside ASCII cannot be opened yet', 'folder');
      }
      const from = searchWord(input.from, 'from');
      const subject = searchWord(input.subject, 'subject');
      const since = input.since === undefined ? null : imapDay(String(input.since));
      const limit = Math.min(LIST_MAX, Math.max(1, Math.floor(Number(input.limit ?? LIST_DEFAULT)) || LIST_DEFAULT));
      const account = await accountOf(ctx);
      const session = await signIn(account, options);
      try {
        try {
          await session.examine(folder);
        } catch (failure) {
          if (failure instanceof MailRefused) throw wrong(`the mailbox would not open the folder ${folder}: ${failure.message}`, 'folder');
          throw failureSaid(failure, account, 'IMAP', false);
        }
        if (input.uid !== undefined) {
          const found = await session.peek(Number(input.uid), FETCH_MAX_BYTES).catch((failure: unknown) => { throw failureSaid(failure, account, 'IMAP', false); });
          if (!found) throw wrong(`there is no message ${input.uid} in ${folder}: list the folder for the ones there are`, 'uid');
          const mail = readMail(found.raw);
          return {
            folder, uid: Number(input.uid), from: sender(mail.from), subject: mail.subject, date: mail.date, unread: !found.seen,
            messageId: mail.messageId, text: mail.text, attachments: mail.attachments, fromPerson: mail.fromPerson,
          };
        }
        const keys: Array<string | { text: string }> = [];
        if (from) keys.push('FROM', { text: from });
        if (subject) keys.push('SUBJECT', { text: subject });
        if (since) keys.push(`SINCE ${since}`);
        if (input.unread) keys.push('UNSEEN');
        const uids = await session.search(keys).catch((failure: unknown) => { throw failureSaid(failure, account, 'IMAP', false); });
        const newest = uids.slice(-limit).reverse();
        const messages: unknown[] = [];
        for (const uid of newest) {
          const found = await session.peek(uid, FETCH_MAX_BYTES).catch((failure: unknown) => { throw failureSaid(failure, account, 'IMAP', false); });
          if (!found) continue;
          const mail = readMail(found.raw);
          messages.push({
            uid, from: sender(mail.from), subject: mail.subject, date: mail.date, unread: !found.seen,
            snippet: snippet(mail.text), attachments: mail.attachments,
          });
        }
        return { folder, messages, more: uids.length - newest.length };
      } finally {
        await session.logout();
      }
    },
  };
}

export interface EmailSendInput {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
}

export interface EmailSendOutput {
  messageId: string;
  to: string[];
  cc: string[];
  subject: string;
  /** What the server said when it took the message. */
  queued: string;
}

function recipients(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  const list = Array.isArray(value) ? value : [];
  if ((required && list.length === 0) || list.length > RECIPIENTS_MAX) {
    throw wrong(`${field} is a list of 1 to ${RECIPIENTS_MAX} addresses`, field);
  }
  return list.map((one) => {
    const address = typeof one === 'string' ? one.trim() : '';
    if (!new RegExp(ADDRESS).test(address)) throw wrong(`${field} holds addresses alone, such as budi@example.com: no names, no lists`, field);
    return address;
  });
}

/** The letter as it was asked for, held to its shape: the card shows it, and nothing else may leave. */
function letterOf(input: EmailSendInput): { to: string[]; cc: string[]; subject: string; text: string; inReplyTo: string | null } {
  const to = recipients(input.to, 'to', true);
  const cc = recipients(input.cc, 'cc', false);
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!subject || subject.length > 300 || !new RegExp(ONE_LINE, 'u').test(subject)) throw wrong('subject is one line of 1 to 300 characters', 'subject');
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim() || text.length > TEXT_MAX) throw wrong(`text is the letter, 1 to ${TEXT_MAX} characters`, 'text');
  const inReplyTo = input.inReplyTo === undefined ? null : String(input.inReplyTo);
  if (inReplyTo !== null && !/^<[^<>\s]{1,995}>$/.test(inReplyTo)) throw wrong('inReplyTo is the messageId of the message this answers, as mailbox.read gave it', 'inReplyTo');
  return { to, cc, subject, text, inReplyTo };
}

function emailSend(options: MailOptions): Capability<EmailSendInput, EmailSendOutput> {
  const address = { type: 'string', maxLength: 254, pattern: ADDRESS };
  return {
    name: 'email.send',
    adapter: 'platform:mail',
    defaultTier: 2,
    credentialAlias: MAILBOX_ALIAS,
    credentialForm: credentialForm(options),
    requiredScopes: ['mail:send'],
    fallback: true,
    inputSchema: {
      type: 'object',
      required: ['to', 'subject', 'text'],
      properties: {
        to: { type: 'array', minItems: 1, maxItems: RECIPIENTS_MAX, items: address, description: 'Who it is to: addresses alone, such as budi@example.com.' },
        cc: { type: 'array', maxItems: RECIPIENTS_MAX, items: address, description: 'Who is to see it besides.' },
        subject: { type: 'string', minLength: 1, maxLength: 300, pattern: ONE_LINE },
        text: { type: 'string', minLength: 1, maxLength: TEXT_MAX, description: 'The letter, in plain text, in the language the reader writes in.' },
        inReplyTo: { type: 'string', pattern: '^<[^<>\\s]{1,995}>$', description: 'The messageId of the message this answers, so it is shown in its thread.' },
      },
      additionalProperties: false,
      description: 'Sends a letter from the division\'s mailbox, after the owner says yes. Everything a letter must carry goes in the one call.',
    },
    describe: (input) => {
      const all = [...(Array.isArray(input.to) ? input.to : []), ...(Array.isArray(input.cc) ? input.cc : [])];
      return { moneyCents: 0, recipientDomain: recipientDomainOf(all), batchSize: all.length };
    },
    summarize: (input) => {
      const to = Array.isArray(input.to) ? input.to.join(', ') : '';
      const cc = Array.isArray(input.cc) && input.cc.length > 0 ? `, cc ${input.cc.join(', ')}` : '';
      return `${to}${cc} — ${String(input.subject ?? '')}`;
    },
    preflight: preflightFor('email.send', options, { imap: false, smtp: true }),
    async execute(input, ctx) {
      const letter = letterOf(input);
      const account = await accountOf(ctx);
      const { rows: [company] } = await withTenant(ctx.companyId, (tx) => tx.query<{ name: string }>(
        'SELECT name FROM companies WHERE id = $1', [ctx.companyId]));
      const domain = account.address.split('@')[1]!;
      const key = createHash('sha256').update(`${ctx.companyId}/${ctx.taskId}/${ctx.idempotencyKey}`).digest('hex').slice(0, 32);
      const composed = composeMail({
        from: account.address, fromName: company?.name ?? null, to: letter.to, cc: letter.cc,
        subject: letter.subject, text: letter.text, inReplyTo: letter.inReplyTo, messageId: `<${key}@${domain}>`,
      });
      let queued: string | null;
      try {
        queued = await smtpSession(
          { host: account.smtpHost, port: account.smtpPort, username: account.username, password: account.password, ...options },
          { from: account.address, to: [...letter.to, ...letter.cc], raw: composed.raw },
        );
      } catch (failure) {
        if (failure instanceof MailRefused) throw wrong(`the mail server refused the letter: ${failure.message}`, 'to');
        throw failureSaid(failure, account, 'SMTP', false);
      }
      return { messageId: composed.messageId, to: letter.to, cc: letter.cc, subject: letter.subject, queued: queued ?? '' };
    },
    // SMTP's one read-back: the server took this letter, for these people.
    async verify(input, result) {
      const letter = letterOf(input);
      return /^250\b/.test(result.queued)
        && JSON.stringify([result.to, result.cc]) === JSON.stringify([letter.to, letter.cc]);
    },
  };
}

/** Both, for a deployment to bind: they need nothing of it but where to trust a private mail server. */
export function mailboxCapabilities(options: MailOptions = {}): Array<Capability<never, never>> {
  return [
    mailboxRead(options) as unknown as Capability<never, never>,
    emailSend(options) as unknown as Capability<never, never>,
  ];
}
