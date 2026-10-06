/**
 * Just enough SMTP (RFC 5321) to send one reply from a company's own
 * mailbox, and the reply itself (RFC 5322): sign in, name the sender and the
 * recipient, hand over the message, leave.
 *
 * Over TLS only: implicitly on port 465, or upgraded with STARTTLS on any
 * other (587 almost everywhere), and refused when a server offers neither.
 * The owner's own email goes through a sending service's API (owner/email.ts),
 * since that mail is the platform's; a customer's reply goes from the
 * company's mailbox, so it is in the thread the customer started and in the
 * mailbox's own Sent mail, which only the mailbox's server can do.
 */
import { createHash, randomUUID } from 'node:crypto';
import { connect as plainConnect, type Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';
import { LineReader, MailRefused, secureSocket, type MailLogin } from './imap.ts';

/** A reply as it is sent: its bytes, and the Message-ID a customer's answer will name. */
export interface Composed {
  raw: Buffer;
  messageId: string;
}

/** A header that may hold more than ASCII, as RFC 2047's encoded words of UTF-8. */
function encodedHeader(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let piece = '';
  for (const char of text) {
    // 45 bytes of UTF-8 is 60 of base64, which keeps a word under RFC 2047's 75.
    if (Buffer.byteLength(piece + char) > 45) {
      words.push(piece);
      piece = '';
    }
    piece += char;
  }
  if (piece) words.push(piece);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, 'utf8').toString('base64')}?=`).join(' ');
}

/** "Re: " once, however many the subject already had. */
export function replySubject(subject: string | null): string {
  const bare = (subject ?? '').replace(/^\s*((re|aw|bls|balas)\s*:\s*)+/i, '').trim();
  return bare ? `Re: ${bare}` : 'Re:';
}

/** A name beside an address in From, quoted, or as encoded words when it is not ASCII. */
function named(name: string, address: string): string {
  const clean = name.replace(/[\r\n"\\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return address;
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}" <${address}>` : `${encodedHeader(clean)} <${address}>`;
}

/**
 * A letter in plain text. Base64, so no line of it is too long for a server
 * and no character is lost to an 8-bit relay. Nothing here checks the
 * addresses or the subject for a line break: the caller has, since what it
 * refuses it must say to whoever asked.
 */
export function composeMail(input: {
  from: string; fromName?: string | null; to: string[]; cc?: string[]; subject: string; text: string;
  inReplyTo?: string | null; messageId?: string; now?: Date; attachments?: Attachment[];
}): Composed {
  const domain = input.from.split('@')[1] ?? 'palugada.invalid';
  const messageId = input.messageId ?? `<${randomUUID()}@${domain}>`;
  const date = (input.now ?? new Date()).toUTCString().replace(/GMT$/, '+0000');
  const wrapped = (bytes: Buffer) => bytes.toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const body = wrapped(Buffer.from(`${input.text.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8'));
  const files = input.attachments ?? [];
  // The boundary is made from the message's own id, so a letter made again
  // after a crash is the same bytes; it begins `=_`, which no line of base64
  // can, so no part can hold it.
  const boundary = `=_palugada_${createHash('sha256').update(messageId).digest('hex').slice(0, 24)}`;
  const headers = [
    `From: ${input.fromName ? named(input.fromName, input.from) : input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc && input.cc.length > 0 ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodedHeader(input.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    ...(files.length === 0
      ? ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64']
      : [`Content-Type: multipart/mixed; boundary="${boundary}"`]),
  ];
  if (files.length === 0) return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8'), messageId };

  const parts = [
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${body}`,
    ...files.map((file) => {
      // A name is one plain name: a line break or a quote in it would end the header it is in.
      if (/[\r\n"\\\u0000]/.test(file.name) || file.name.length === 0) throw new PalugadaError('contract.violation', 'an attachment\'s name is a plain file name', { field: 'attachments' });
      const fallback = file.name.replace(/[^\x20-\x7e]/g, '_');
      const encoded = encodeURIComponent(file.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
      // A `message/*` part may not be encoded (RFC 2046), and a file is not read as a message here: it is bytes.
      const mime = file.mime.startsWith('message/') ? 'application/octet-stream' : file.mime;
      return `--${boundary}\r\nContent-Type: ${mime}; name="${fallback}"\r\nContent-Transfer-Encoding: base64\r\n`
        + `Content-Disposition: attachment; filename="${fallback}"; filename*=UTF-8''${encoded}\r\n\r\n${wrapped(file.bytes)}`;
    }),
    `--${boundary}--\r\n`,
  ];
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${parts.join('')}`, 'utf8'), messageId };
}

/** A file a letter carries: the name it is saved under, what it is, and its bytes. */
export interface Attachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

/**
 * A reply in plain text, in the customer's thread: In-Reply-To and
 * References name the message it answers.
 */
export function composeReply(input: {
  from: string; to: string; subject: string; text: string; inReplyTo: string | null; now?: Date;
}): Composed {
  return composeMail({ ...input, to: [input.to] });
}

/** One conversation with a server: its replies read whole, a refusal named. */
class Conversation {
  #socket: Socket | TLSSocket;
  #reader: LineReader;

  constructor(socket: Socket | TLSSocket) {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
  }

  upgraded(socket: TLSSocket): void {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
  }

  /** A reply, all its lines: `250-…` continues, `250 …` ends. */
  async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.#reader.line();
      lines.push(line.slice(4));
      if (!/^\d{3}-/.test(line)) return { code: Number(line.slice(0, 3)), lines };
    }
  }

  async send(command: string, expected: number[], shown = command): Promise<{ code: number; lines: string[] }> {
    this.#socket.write(`${command}\r\n`);
    const answer = await this.reply();
    if (!expected.includes(answer.code)) {
      throw new MailRefused(redactor.redact(`${shown.split(' ')[0]} was answered ${answer.code} ${answer.lines.join(' ')}`.slice(0, 300)));
    }
    return answer;
  }

  write(data: Buffer): void {
    this.#socket.write(data);
  }

  /** How long the line may be silent before the conversation is given up: more while a large message is taken. */
  patience(ms: number): void {
    this.#socket.setTimeout(ms);
  }

  close(): void {
    this.#socket.destroy();
  }
}

/** The data of a message as DATA takes it: every line that starts with a dot gets another. */
function stuffed(raw: Buffer): Buffer {
  return Buffer.from(raw.toString('latin1').replace(/(^|\r\n)\./g, '$1..'), 'latin1');
}

async function plainSocket(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = plainConnect({ host, port });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} seconds`)));
    socket.once('connect', () => resolve(socket));
    socket.once('error', (error) => reject(new PalugadaError('capability.unreachable',
      `the mail server at ${host}:${port} could not be reached: ${error.message}`, { host, port })));
  });
}

/**
 * Signs in to the server, and sends `message` from `from` to each of `to`
 * when one is given: without one, a check that the server takes the
 * password. Answers with what the server said when it took the message --
 * `250 2.0.0 OK queued as …` -- the one read-back SMTP has.
 */
export async function smtpSession(login: MailLogin, message?: { from: string; to: string | string[]; raw: Buffer }): Promise<string | null> {
  redactor.register(login.password);
  const timeoutMs = login.timeoutMs ?? 20_000;
  const where = `${login.host}:${login.port}`;
  const implicit = login.port === 465;
  const first = implicit ? await secureSocket(login.host, login.port, login) : await plainSocket(login.host, login.port, timeoutMs);
  const talk = new Conversation(first);
  const name = login.username.split('@')[1] ?? 'palugada.invalid';
  try {
    if ((await talk.reply()).code !== 220) throw new MailRefused('the server did not greet');
    let offered = await talk.send(`EHLO ${name}`, [250]);
    if (!implicit) {
      if (!offered.lines.some((line) => /^STARTTLS\b/i.test(line))) {
        throw new MailRefused(`it offers no STARTTLS on port ${login.port}, and PALUGADA sends mail only over TLS; use port 465 or 587`);
      }
      await talk.send('STARTTLS', [220]);
      // What arrives from here on is TLS, for the upgraded socket alone.
      first.removeAllListeners('data');
      talk.upgraded(await secureSocket(login.host, login.port, { ...login, socket: first as Socket }));
      offered = await talk.send(`EHLO ${name}`, [250]);
    }
    const mechanisms = offered.lines.find((line) => /^AUTH\b/i.test(line))?.toUpperCase() ?? '';
    if (mechanisms.includes('PLAIN') || !mechanisms.includes('LOGIN')) {
      const plain = Buffer.from(`\0${login.username}\0${login.password}`, 'utf8').toString('base64');
      await talk.send(`AUTH PLAIN ${plain}`, [235], 'AUTH PLAIN');
    } else {
      await talk.send('AUTH LOGIN', [334]);
      await talk.send(Buffer.from(login.username, 'utf8').toString('base64'), [334], 'AUTH LOGIN');
      await talk.send(Buffer.from(login.password, 'utf8').toString('base64'), [235], 'AUTH LOGIN');
    }
    let taken: string | null = null;
    if (message) {
      // A server says how large a message it takes (RFC 1870): said before the
      // message is sent, and not after the whole of it has gone for nothing.
      const limit = Number(offered.lines.map((line) => /^SIZE\s+(\d+)/i.exec(line)?.[1]).find((one) => one !== undefined));
      if (Number.isFinite(limit) && limit > 0 && message.raw.length > limit) {
        throw new MailRefused(`the mail server takes messages up to ${(limit / 1_048_576).toFixed(1)} MB; this one is ${(message.raw.length / 1_048_576).toFixed(1)} MB`);
      }
      await talk.send(`MAIL FROM:<${message.from}>`, [250]);
      for (const to of Array.isArray(message.to) ? message.to : [message.to]) await talk.send(`RCPT TO:<${to}>`, [250, 251]);
      await talk.send('DATA', [354]);
      // A large letter takes longer than a line to be accepted, and a timeout
      // after the server took it would invite a second send of the same letter.
      if (message.raw.length > 1_048_576) talk.patience(Math.max(timeoutMs, 60_000));
      talk.write(stuffed(message.raw));
      const answer = await talk.send('.', [250], 'DATA');
      talk.patience(timeoutMs);
      taken = `${answer.code} ${answer.lines.join(' ')}`.slice(0, 300);
    }
    await talk.send('QUIT', [221]).catch(() => undefined);
    return taken;
  } catch (failure) {
    if (failure instanceof PalugadaError || failure instanceof MailRefused) throw failure;
    throw new PalugadaError('capability.unreachable', `the mail server at ${where} stopped answering: ${(failure as Error).message}`, {});
  } finally {
    talk.close();
  }
}
