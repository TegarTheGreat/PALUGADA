/**
 * Just enough IMAP (RFC 9051, and RFC 3501 which most servers still speak)
 * to read a mailbox's new mail -- sign in, open the inbox, ask which messages
 * came after the last one read, fetch each, sign out -- and to look through
 * one for a role (`capabilities/mailbox.ts`): a folder opened read-only, a
 * search, a message with whether it was read.
 *
 * Over TLS only, on the port the provider gives for it (993 almost
 * everywhere): a password sent in the clear is a password given away, and
 * every provider a small business uses offers TLS. Written here rather than
 * taken from a library, like the platform's other transports: this is five
 * commands, and the one part with any subtlety -- a message arrives as a
 * literal, `{n}` and then n bytes -- is a few lines.
 *
 * Messages are fetched with BODY.PEEK, so reading one does not mark it read
 * in the owner's own mail client, and only their first 256 KB: enough for
 * any text a person writes, and a bound on what one message can cost.
 */
import { connect, getCACertificates, type ConnectionOptions, type TLSSocket } from 'node:tls';
import { PalugadaError } from '../errors.ts';
import { redactor } from '../secrets/manager.ts';

export interface MailLogin {
  host: string;
  port: number;
  username: string;
  password: string;
  /** A certificate authority to trust besides the system's, for a server with a private one. */
  ca?: string;
  timeoutMs?: number;
}

/** How much of a message is fetched. */
export const FETCH_MAX_BYTES = 256 * 1024;

/** A refusal by the server itself, as opposed to not reaching it. */
export class MailRefused extends Error {}

/**
 * Bytes from a socket, as lines or as a counted run of bytes: IMAP and SMTP
 * are both lines, and IMAP's literals are counted bytes in the middle of one.
 */
export class LineReader {
  #buffer = Buffer.alloc(0);
  #waiting: (() => void) | null = null;
  #failure: Error | null = null;

  constructor(socket: TLSSocket | import('node:net').Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      this.#wake();
    });
    socket.on('error', (error: Error) => { this.#failure = error; this.#wake(); });
    socket.on('close', () => { this.#failure ??= new Error('the server closed the connection'); this.#wake(); });
  }

  /** Data that arrived after a point the caller handed the socket over, such as STARTTLS. */
  take(): Buffer {
    const left = this.#buffer;
    this.#buffer = Buffer.alloc(0);
    return left;
  }

  #wake(): void {
    const waiting = this.#waiting;
    this.#waiting = null;
    waiting?.();
  }

  async #more(): Promise<void> {
    if (this.#failure) throw this.#failure;
    await new Promise<void>((resolve) => { this.#waiting = resolve; });
    if (this.#failure && this.#buffer.length === 0) throw this.#failure;
  }

  async line(): Promise<string> {
    for (;;) {
      const at = this.#buffer.indexOf('\r\n');
      if (at >= 0) {
        const line = this.#buffer.subarray(0, at).toString('latin1');
        this.#buffer = this.#buffer.subarray(at + 2);
        return line;
      }
      if (this.#buffer.length > 1_048_576) throw new Error('the server sent a line over a megabyte long');
      await this.#more();
    }
  }

  async bytes(count: number): Promise<Buffer> {
    while (this.#buffer.length < count) await this.#more();
    const taken = this.#buffer.subarray(0, count);
    this.#buffer = this.#buffer.subarray(count);
    return Buffer.from(taken);
  }
}

/** A TLS connection, or a refusal naming the server that could not be reached and why. */
export async function secureSocket(host: string, port: number, options: { ca?: string; timeoutMs?: number; socket?: import('node:net').Socket }): Promise<TLSSocket> {
  return new Promise<TLSSocket>((resolve, reject) => {
    const settings: ConnectionOptions = {
      host, port,
      // A name to check the certificate against; an address is checked as itself.
      ...(/^[\d.]+$|:/.test(host) ? {} : { servername: host }),
      ...(options.socket ? { socket: options.socket } : {}),
      // Given a `ca`, Node trusts it *instead of* its own authorities; a
      // private one is meant besides them, so they are named as well --
      // the system's, and any the machine adds with NODE_EXTRA_CA_CERTS.
      ...(options.ca ? { ca: [...getCACertificates('default'), options.ca] } : {}),
    };
    const socket = connect(settings);
    socket.setTimeout(options.timeoutMs ?? 20_000, () => socket.destroy(new Error(`no answer in ${Math.round((options.timeoutMs ?? 20_000) / 1000)} seconds`)));
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', (error) => reject(new PalugadaError('capability.unreachable',
      `the mail server at ${host}:${port} could not be reached over TLS: ${error.message}`, { host, port })));
  });
}

function quoted(text: string): string {
  return `"${text.replace(/[\\"]/g, '\\$&')}"`;
}

export class ImapSession {
  readonly #socket: TLSSocket;
  readonly #reader: LineReader;
  readonly #where: string;
  #tag = 0;

  private constructor(socket: TLSSocket, where: string) {
    this.#socket = socket;
    this.#reader = new LineReader(socket);
    this.#where = where;
  }

  /** Connected and signed in, or refused with what the server said. */
  static async open(login: MailLogin): Promise<ImapSession> {
    redactor.register(login.password);
    const socket = await secureSocket(login.host, login.port, login);
    const session = new ImapSession(socket, `${login.host}:${login.port}`);
    try {
      const greeting = await session.#reader.line();
      if (!/^\* (OK|PREAUTH)\b/i.test(greeting)) throw new MailRefused(`the server greeted with ${greeting.slice(0, 200)}`);
      if (/[^\x20-\x7e]/.test(login.username + login.password)) {
        // LOGIN takes quoted ASCII; anything else goes as SASL PLAIN, in base64.
        const plain = Buffer.from(`\0${login.username}\0${login.password}`, 'utf8').toString('base64');
        await session.#command('AUTHENTICATE PLAIN', { continuation: plain });
      } else {
        await session.#command(`LOGIN ${quoted(login.username)} ${quoted(login.password)}`);
      }
      return session;
    } catch (failure) {
      session.close();
      throw session.#said(failure);
    }
  }

  /** A failure as the owner should read it: the server's own words when it refused. */
  #said(failure: unknown): Error {
    if (failure instanceof PalugadaError) return failure;
    if (failure instanceof MailRefused) return failure;
    return new PalugadaError('capability.unreachable', `the mail server at ${this.#where} stopped answering: ${(failure as Error).message}`, {});
  }

  /**
   * Runs one command; the untagged lines it answered with, and each literal
   * they carried. A command given in pieces sends each Buffer among them as
   * a literal of its own -- `{n}`, the server's go-ahead, then the bytes --
   * which is how IMAP takes text that is not ASCII.
   */
  async #command(text: string | Array<string | Buffer>, options: { continuation?: string } = {}): Promise<Array<{ line: string; literal: Buffer | null }>> {
    this.#tag += 1;
    const tag = `P${this.#tag}`;
    const untagged: Array<{ line: string; literal: Buffer | null }> = [];
    const pieces = typeof text === 'string' ? [text] : text;
    this.#socket.write(`${tag} `);
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        this.#socket.write(piece);
        continue;
      }
      this.#socket.write(`{${piece.length}}\r\n`);
      for (;;) {
        const line = await this.#reader.line();
        if (line.startsWith('+')) break;
        if (line.startsWith(`${tag} `)) throw new MailRefused(redactor.redact(line.slice(tag.length + 1).replace(/^(NO|BAD)\s*/i, '').slice(0, 300)));
        untagged.push({ line, literal: null });
      }
      this.#socket.write(piece);
    }
    this.#socket.write('\r\n');
    for (;;) {
      let line = await this.#reader.line();
      if (line.startsWith('+') && options.continuation !== undefined) {
        this.#socket.write(`${options.continuation}\r\n`);
        continue;
      }
      if (line.startsWith(`${tag} `)) {
        const status = line.slice(tag.length + 1);
        if (!/^OK\b/i.test(status)) throw new MailRefused(redactor.redact(status.replace(/^(NO|BAD)\s*/i, '').slice(0, 300)));
        return untagged;
      }
      let literal: Buffer | null = null;
      const counted = /\{(\d+)\}$/.exec(line);
      if (counted) {
        literal = await this.#reader.bytes(Number(counted[1]));
        line += ` ${await this.#reader.line()}`;
      }
      untagged.push({ line, literal });
    }
  }

  /** Opens the inbox, read-only as far as this platform is concerned. */
  async selectInbox(): Promise<{ uidValidity: number; uidNext: number }> {
    try {
      const lines = await this.#command('SELECT INBOX');
      const number = (name: string) => Number(lines.map((one) => new RegExp(`\\[${name} (\\d+)\\]`, 'i').exec(one.line)?.[1]).find(Boolean) ?? NaN);
      const uidValidity = number('UIDVALIDITY');
      if (!Number.isFinite(uidValidity)) throw new MailRefused('the inbox has no UIDVALIDITY, so new mail cannot be told from old');
      return { uidValidity, uidNext: Number.isFinite(number('UIDNEXT')) ? number('UIDNEXT') : 1 };
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  /**
   * Opens a folder read-only (EXAMINE): nothing done in it can mark a
   * message read or move it, whatever a later command asks.
   */
  async examine(folder: string): Promise<{ uidValidity: number; exists: number }> {
    try {
      const lines = await this.#command(`EXAMINE ${quoted(folder)}`);
      const exists = Number(lines.map((one) => /^\* (\d+) EXISTS\b/i.exec(one.line)?.[1]).find(Boolean) ?? 0);
      const uidValidity = Number(lines.map((one) => /\[UIDVALIDITY (\d+)\]/i.exec(one.line)?.[1]).find(Boolean) ?? NaN);
      return { uidValidity, exists };
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  /**
   * The UIDs of the messages a search finds, oldest first. Each key is an
   * atom (`UNSEEN`, `SINCE 2-Oct-2026`) or, as `{ text }`, what a FROM or a
   * SUBJECT is to contain: quoted when it is plain ASCII, else sent as a
   * literal in UTF-8, which the search then says it is in.
   */
  async search(keys: Array<string | { text: string }>): Promise<number[]> {
    try {
      const plain = (value: string) => /^[\x20-\x7e]*$/.test(value);
      const wide = keys.some((key) => typeof key !== 'string' && !plain(key.text));
      const pieces: Array<string | Buffer> = [wide ? 'UID SEARCH CHARSET UTF-8' : 'UID SEARCH'];
      for (const key of keys.length > 0 ? keys : ['ALL']) {
        if (typeof key === 'string') pieces.push(` ${key}`);
        else if (plain(key.text)) pieces.push(` ${quoted(key.text)}`);
        else pieces.push(' ', Buffer.from(key.text, 'utf8'));
      }
      const lines = await this.#command(pieces);
      const uids = lines.flatMap((one) => /^\* SEARCH\b(.*)$/i.exec(one.line)?.[1]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? []);
      return [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > 0).sort((a, b) => a - b);
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  /** The start of one message and whether it has been read, without marking it read; null when it is gone. */
  async peek(uid: number, maxBytes = FETCH_MAX_BYTES): Promise<{ raw: Buffer; seen: boolean } | null> {
    try {
      const lines = await this.#command(`UID FETCH ${uid} (UID FLAGS BODY.PEEK[]<0.${maxBytes}>)`);
      const found = lines.find((one) => one.literal !== null && /\bFETCH\b/i.test(one.line));
      if (!found?.literal) return null;
      const flags = /\bFLAGS \(([^)]*)\)/i.exec(found.line)?.[1] ?? '';
      return { raw: found.literal, seen: /(^|\s)\\Seen\b/i.test(flags) };
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  /** The UIDs of the messages after `last`, oldest first. */
  async uidsAfter(last: number): Promise<number[]> {
    try {
      const lines = await this.#command(`UID SEARCH UID ${last + 1}:*`);
      const uids = lines.flatMap((one) => /^\* SEARCH\b(.*)$/i.exec(one.line)?.[1]?.trim().split(/\s+/).filter(Boolean).map(Number) ?? []);
      // `n:*` names the last message even when it is below n.
      return [...new Set(uids)].filter((uid) => Number.isInteger(uid) && uid > last).sort((a, b) => a - b);
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  /** The start of one message, without marking it read; null when it is gone. */
  async fetch(uid: number, maxBytes = FETCH_MAX_BYTES): Promise<Buffer | null> {
    try {
      const lines = await this.#command(`UID FETCH ${uid} (UID BODY.PEEK[]<0.${maxBytes}>)`);
      return lines.find((one) => one.literal !== null && /\bFETCH\b/i.test(one.line))?.literal ?? null;
    } catch (failure) {
      throw this.#said(failure);
    }
  }

  async logout(): Promise<void> {
    await this.#command('LOGOUT').catch(() => undefined);
    this.close();
  }

  close(): void {
    this.#socket.destroy();
  }
}
