/**
 * A message as a mailbox holds it (RFC 5322 and MIME), read as a person
 * reads it: who sent it, its subject, its text, what was attached -- and
 * whether a person sent it at all.
 *
 * Written here rather than taken from a library, like the platform's other
 * transports: what is needed is narrow -- headers, encoded words, the two
 * transfer encodings, charsets, and the parts of a multipart -- and what a
 * customer wrote reaches a run as data either way, so a part this reads
 * imperfectly costs a run some words, not the platform its safety.
 *
 * Two readings are deliberate:
 *
 *   - **The text, not the thread.** A reply carries the history it answers,
 *     quoted, and the run already has that history in `chat.read`. What
 *     follows "On ... wrote:" (or its Indonesian, "Pada ... menulis:") and
 *     the lines quoted with ">" are left out.
 *   - **A person, or not.** An auto-reply, a bounce and a mailing list are
 *     mail no person sent, and answering one is how two machines reply to
 *     each other for ever. Each says so in a header (RFC 3834's
 *     Auto-Submitted, Precedence, List-Id) or in who it is from.
 */

export interface Mail {
  from: { name: string | null; address: string } | null;
  subject: string;
  /** With its angle brackets, as a reply's In-Reply-To names it. */
  messageId: string | null;
  references: string[];
  /** What the sender wrote, without the history a reply quotes. */
  text: string;
  /** What was attached, by the kind the other transports use: photo, voice, video, document. */
  attachments: string[];
  /** False for mail no person sent: an auto-reply, a bounce, a list. */
  fromPerson: boolean;
}

interface Part {
  headers: Map<string, string>;
  body: Buffer;
}

/** The most text kept from one message, past which it is cut. */
const TEXT_MAX = 20_000;

const latin1 = (bytes: Buffer) => bytes.toString('latin1');

/** Headers and body: the first empty line divides them; a header folded over lines is one line. */
function split(raw: Buffer): Part {
  let at = raw.indexOf('\r\n\r\n');
  let gap = 4;
  if (at < 0) {
    at = raw.indexOf('\n\n');
    gap = 2;
  }
  const head = latin1(at < 0 ? raw : raw.subarray(0, at));
  const body = at < 0 ? Buffer.alloc(0) : raw.subarray(at + gap);
  const headers = new Map<string, string>();
  let last: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      headers.set(last, `${headers.get(last)} ${line.trim()}`);
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    last = line.slice(0, colon).trim().toLowerCase();
    // The first of a header that is repeated; the rest are a relay's.
    if (!headers.has(last)) headers.set(last, line.slice(colon + 1).trim());
  }
  return { headers, body };
}

function decodeCharset(bytes: Buffer, charset: string | null): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '');
  try {
    return new TextDecoder(label === 'us-ascii' ? 'utf-8' : label).decode(bytes);
  } catch {
    // A charset the runtime does not know: read as UTF-8, which is what
    // most of them turn out to be.
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function quotedPrintable(text: string, header = false): Buffer {
  const source = header ? text.replace(/_/g, ' ') : text.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]!;
    const hex = source.slice(i + 1, i + 3);
    if (char === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(source.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/**
 * A header as text: its bytes read as UTF-8 where they are (a header sent
 * unencoded, these days, is), then RFC 2047's encoded words decoded --
 * `=?UTF-8?B?…?=` and `=?ISO-8859-1?Q?…?=`.
 */
export function decodeHeader(value: string): string {
  let text = value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'latin1'));
  } catch {
    // Not UTF-8: Latin-1, as it was read.
  }
  // Whitespace between two encoded words is not part of the text.
  const joined = text.replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?)/g, '$1');
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, encoded: string) => {
    const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(encoded, 'base64') : quotedPrintable(encoded, true);
    return decodeCharset(bytes, charset.split('*')[0]!);
  });
}

/** A header's value and its parameters: `text/plain; charset="utf-8"`. */
function parameters(value: string): { value: string; params: Map<string, string> } {
  const [first = '', ...rest] = value.split(';');
  const params = new Map<string, string>();
  for (const part of rest) {
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    params.set(part.slice(0, equals).trim().toLowerCase(), part.slice(equals + 1).trim().replace(/^"|"$/g, ''));
  }
  return { value: first.trim().toLowerCase(), params };
}

/** One address: `"Name" <a@b>`, `Name <a@b>` or `a@b`; the address in lower case. */
export function address(value: string): { name: string | null; address: string } | null {
  const decoded = decodeHeader(value).trim();
  const angled = /^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/.exec(decoded);
  const bare = /([^\s<>",;]+@[^\s<>",;]+)/.exec(decoded);
  const found = angled?.[2] ?? bare?.[1];
  if (!found) return null;
  const name = angled?.[1]?.trim().replace(/^"|"$/g, '').trim() ?? '';
  return { name: name && name.toLowerCase() !== found.toLowerCase() ? name : null, address: found.toLowerCase() };
}

function transferDecoded(part: Part): Buffer {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  if (encoding === 'base64') return Buffer.from(latin1(part.body).replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (encoding === 'quoted-printable') return quotedPrintable(latin1(part.body));
  return part.body;
}

/** HTML as the words it shows: blocks and breaks as lines, entities as their characters. */
function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&');
}

function attachmentKind(type: string): string {
  if (type.startsWith('image/')) return 'photo';
  if (type.startsWith('audio/')) return 'voice';
  if (type.startsWith('video/')) return 'video';
  return 'document';
}

/** The text of a part and what it carries, walking a multipart's parts; plain text before HTML. */
function walk(part: Part, found: { plain: string[]; html: string[]; attachments: string[] }, depth = 0): void {
  const type = parameters(part.headers.get('content-type') ?? 'text/plain');
  const disposition = parameters(part.headers.get('content-disposition') ?? '').value;
  if (type.value.startsWith('multipart/') && depth < 8) {
    const boundary = type.params.get('boundary');
    if (!boundary) return;
    const text = latin1(part.body);
    const pieces = text.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*(?:\\r?\\n|$)`));
    // The first piece is the preamble; the last, after the closing line, the epilogue.
    for (const piece of pieces.slice(1)) {
      if (!piece.trim()) continue;
      walk(split(Buffer.from(piece, 'latin1')), found, depth + 1);
    }
    return;
  }
  if (disposition === 'attachment' || !type.value.startsWith('text/')) {
    if (type.value !== 'message/delivery-status') found.attachments.push(attachmentKind(type.value));
    return;
  }
  const decoded = decodeCharset(transferDecoded(part), type.params.get('charset') ?? null);
  if (type.value === 'text/html') found.html.push(htmlText(decoded));
  else found.plain.push(decoded);
}

/**
 * What a reply's writer wrote: the lines before the history it quotes.
 * "On <date>, <name> wrote:" is how Gmail, Apple Mail and Thunderbird
 * introduce it; "Pada <date> <name> menulis:" is Gmail in Indonesian.
 */
function withoutHistory(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const joined = `${line} ${lines[i + 1] ?? ''}`.trim();
    if (/^(On\s.+\swrote:|Pada\s.+\smenulis:)$/i.test(line.trim()) || /^(On\s.+\swrote:|Pada\s.+\smenulis:)$/i.test(joined)) break;
    if (/^-{2,}\s*(Original Message|Pesan Asli|Forwarded message)\s*-{2,}$/i.test(line.trim())) break;
    if (/^>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Whether a person sent it: not an auto-reply, a bounce, a list, or a machine's own address. */
function fromPerson(headers: Map<string, string>, from: Mail['from']): boolean {
  const auto = (headers.get('auto-submitted') ?? 'no').trim().toLowerCase();
  if (auto !== 'no') return false;
  if (/^(bulk|list|junk|auto_reply)$/i.test((headers.get('precedence') ?? '').trim())) return false;
  if (headers.has('list-id') || headers.has('list-unsubscribe')) return false;
  if (headers.has('x-autoreply') || headers.has('x-autorespond')) return false;
  if (!from) return false;
  return !/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/i.test(from.address);
}

export function readMail(raw: Buffer): Mail {
  const top = split(raw);
  const found = { plain: [] as string[], html: [] as string[], attachments: [] as string[] };
  walk(top, found);
  const text = found.plain.length > 0 ? found.plain.join('\n\n') : found.html.join('\n\n');
  const from = address(top.headers.get('from') ?? '');
  const ids = (value: string | undefined) => [...(value ?? '').matchAll(/<[^<>\s]+>/g)].map((match) => match[0]);
  return {
    from,
    subject: decodeHeader(top.headers.get('subject') ?? '').replace(/\s+/g, ' ').trim().slice(0, 998),
    messageId: ids(top.headers.get('message-id'))[0] ?? null,
    references: [...ids(top.headers.get('references')), ...ids(top.headers.get('in-reply-to'))],
    text: withoutHistory(text).slice(0, TEXT_MAX),
    attachments: found.attachments,
    fromPerson: fromPerson(top.headers, from),
  };
}
