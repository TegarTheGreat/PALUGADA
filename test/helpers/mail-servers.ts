/**
 * A mailbox to test against: an IMAP server over TLS and an SMTP server that
 * upgrades with STARTTLS, both speaking only as much of their protocol as a
 * client reading new mail and sending a reply needs, and a certificate made
 * for 127.0.0.1 by openssl for the run.
 *
 * Written rather than borrowed, like the clients they test (src/chats/imap.ts,
 * src/chats/smtp.ts): a fake that came with a library would agree with that
 * library, not with the protocol.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createPlainServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createTlsServer, TLSSocket } from 'node:tls';

export interface Certificate {
  key: string;
  cert: string;
  /** Where the certificate is kept as a file, for a setting that names one. */
  certPath: string;
}

/** A certificate for 127.0.0.1, valid for a day; null where openssl is not installed. */
export function certificate(): Certificate | null {
  try {
    const dir = mkdtempSync(join(tmpdir(), 'palugada-mail-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    return { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8'), certPath: join(dir, 'cert.pem') };
  } catch {
    return null;
  }
}

/** Writes a certificate somewhere a setting can name, for a test that needs another file. */
export function writeCertificate(certificate: Certificate, path: string): void {
  writeFileSync(path, certificate.cert);
}

/** IMAP's arguments: atoms and quoted strings, with their escapes undone. */
function words(text: string): string[] {
  const found: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    found.push(match[1] !== undefined ? match[1].replace(/\\(.)/g, '$1') : match[2]!);
  }
  return found;
}

export interface Imap {
  port: number;
  /** The inbox, oldest first; add to it to deliver mail. */
  messages: Array<{ uid: number; raw: string }>;
  uidValidity: number;
  /** Who signed in, and with what. */
  logins: Array<{ user: string; password: string }>;
  /** Set to refuse every sign-in, as a server does after the password changed. */
  refuse: boolean;
  deliver(raw: string): number;
  close(): Promise<void>;
}

export async function imapServer(certificate: Certificate, account: { user: string; password: string }): Promise<Imap> {
  const state: Imap = {
    port: 0,
    messages: [],
    uidValidity: 777,
    logins: [],
    refuse: false,
    deliver(raw: string) {
      const uid = (state.messages.at(-1)?.uid ?? 100) + 1;
      state.messages.push({ uid, raw });
      return uid;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  const server = createTlsServer({ key: certificate.key, cert: certificate.cert }, (socket) => {
    let buffer = '';
    let authed = false;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say('* OK IMAP4rev1 test server ready');
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        const [tag, command, ...rest] = words(line);
        const verb = (command ?? '').toUpperCase();
        if (verb === 'CAPABILITY') {
          say('* CAPABILITY IMAP4rev1 AUTH=PLAIN');
          say(`${tag} OK CAPABILITY completed`);
        } else if (verb === 'LOGIN') {
          const [user = '', password = ''] = rest;
          state.logins.push({ user, password });
          if (!state.refuse && user === account.user && password === account.password) {
            authed = true;
            say(`${tag} OK LOGIN completed`);
          } else {
            say(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)`);
          }
        } else if (!authed && verb !== 'LOGOUT') {
          say(`${tag} BAD Sign in first`);
        } else if (verb === 'SELECT') {
          say(`* ${state.messages.length} EXISTS`);
          say(`* OK [UIDVALIDITY ${state.uidValidity}] UIDs valid`);
          say(`* OK [UIDNEXT ${(state.messages.at(-1)?.uid ?? 100) + 1}] Predicted next UID`);
          say(`${tag} OK [READ-WRITE] SELECT completed`);
        } else if (verb === 'UID' && (rest[0] ?? '').toUpperCase() === 'SEARCH') {
          // UID a:* -- and, as servers do, the last message when none is at a or above.
          const from = Number(/^(\d+):\*$/.exec(rest[2] ?? '')?.[1] ?? 1);
          const found = state.messages.filter((message) => message.uid >= from).map((message) => message.uid);
          const last = state.messages.at(-1);
          say(`* SEARCH${(found.length > 0 ? found : last ? [last.uid] : []).map((uid) => ` ${uid}`).join('')}`);
          say(`${tag} OK SEARCH completed`);
        } else if (verb === 'UID' && (rest[0] ?? '').toUpperCase() === 'FETCH') {
          const uid = Number(rest[1]);
          const index = state.messages.findIndex((message) => message.uid === uid);
          const partial = /BODY\.PEEK\[\]<0\.(\d+)>/i.exec(line);
          if (index >= 0) {
            const body = Buffer.from(state.messages[index]!.raw, 'utf8').subarray(0, partial ? Number(partial[1]) : undefined);
            socket.write(`* ${index + 1} FETCH (UID ${uid} BODY[]${partial ? '<0>' : ''} {${body.length}}\r\n`);
            socket.write(body);
            socket.write(')\r\n');
          }
          say(`${tag} OK FETCH completed`);
        } else if (verb === 'LOGOUT') {
          say('* BYE IMAP4rev1 server logging out');
          say(`${tag} OK LOGOUT completed`);
          socket.end();
        } else {
          say(`${tag} BAD Unknown command`);
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  return state;
}

export interface Smtp {
  port: number;
  /** Every message accepted: who it was from, to, and the data as sent. */
  sent: Array<{ from: string; to: string[]; data: string; user: string }>;
  close(): Promise<void>;
}

/** An SMTP server on a plain port that a client must upgrade with STARTTLS before it may sign in. */
export async function smtpServer(certificate: Certificate, account: { user: string; password: string }): Promise<Smtp> {
  const state: Smtp = { port: 0, sent: [], close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  const server: Server = createPlainServer((plain) => {
    let socket: Socket = plain;
    let secure = false;
    let buffer = '';
    let user = '';
    let from = '';
    let to: string[] = [];
    let data: string | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    const listen = (on: Socket) => {
      on.on('error', () => undefined);
      on.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('latin1');
        let at: number;
        while ((at = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          if (data !== null) {
            if (line === '.') {
              state.sent.push({ from, to, data: Buffer.from(data, 'latin1').toString('utf8'), user });
              data = null;
              say('250 2.0.0 OK queued as T1');
            } else {
              data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
            }
            continue;
          }
          const verb = line.split(' ')[0]!.toUpperCase();
          if (verb === 'EHLO') {
            say('250-smtp.test greets you');
            say(secure ? '250 AUTH PLAIN LOGIN' : '250 STARTTLS');
          } else if (verb === 'STARTTLS' && !secure) {
            say('220 2.0.0 Ready to start TLS');
            const upgraded = new TLSSocket(plain, { isServer: true, key: certificate.key, cert: certificate.cert });
            plain.removeAllListeners('data');
            socket = upgraded;
            secure = true;
            buffer = '';
            listen(upgraded);
            return;
          } else if (verb === 'AUTH') {
            const [, mechanism, initial] = line.split(' ');
            const [, name = '', password = ''] = Buffer.from(initial ?? '', 'base64').toString('utf8').split('\0');
            if (!secure) say('530 5.7.0 Must issue a STARTTLS command first');
            else if (mechanism?.toUpperCase() === 'PLAIN' && name === account.user && password === account.password) {
              user = name;
              say('235 2.7.0 Authentication successful');
            } else say('535 5.7.8 Username and Password not accepted');
          } else if (verb === 'MAIL') {
            if (!user) { say('530 5.7.0 Authentication Required'); continue; }
            from = /<([^>]*)>/.exec(line)?.[1] ?? '';
            to = [];
            say('250 2.1.0 OK');
          } else if (verb === 'RCPT') {
            to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
            say('250 2.1.5 OK');
          } else if (verb === 'DATA') {
            data = '';
            say('354 Go ahead');
          } else if (verb === 'QUIT') {
            say('221 2.0.0 closing connection');
            socket.end();
          } else {
            say('502 5.5.1 Unrecognized command');
          }
        }
      });
    };
    listen(plain);
    say('220 smtp.test ESMTP ready');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as { port: number }).port;
  return state;
}
