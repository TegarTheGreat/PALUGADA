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
import { randomUUID } from 'node:crypto';
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

/**
 * A reply in plain text, in the customer's thread: In-Reply-To and
 * References name the message it answers. Base64, so no line of it is too
 * long for a server and no character is lost to an 8-bit relay.
 */
export function composeReply(input: {
  from: string; to: string; subject: string; text: string; inReplyTo: string | null; now?: Date;
}): Composed {
  const domain = input.from.split('@')[1] ?? 'palugada.invalid';
  const messageId = `<${randomUUID()}@${domain}>`;
  const date = (input.now ?? new Date()).toUTCString().replace(/GMT$/, '+0000');
  const body = Buffer.from(`${input.text.replace(/\r?\n/g, '\r\n')}\r\n`, 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${encodedHeader(input.subject)}`,
    `Date: ${date}`,
    `Message-ID: ${messageId}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
  ];
  return { raw: Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8'), messageId };
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
 * Signs in to the server, and sends `message` from `from` to `to` when one is
 * given: without one, a check that the server takes the password.
 */
export async function smtpSession(login: MailLogin, message?: { from: string; to: string; raw: Buffer }): Promise<void> {
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
    if (message) {
      await talk.send(`MAIL FROM:<${message.from}>`, [250]);
      await talk.send(`RCPT TO:<${message.to}>`, [250, 251]);
      await talk.send('DATA', [354]);
      talk.write(stuffed(message.raw));
      await talk.send('.', [250], 'DATA');
    }
    await talk.send('QUIT', [221]).catch(() => undefined);
  } catch (failure) {
    if (failure instanceof PalugadaError || failure instanceof MailRefused) throw failure;
    throw new PalugadaError('capability.unreachable', `the mail server at ${where} stopped answering: ${(failure as Error).message}`, {});
  } finally {
    talk.close();
  }
}
