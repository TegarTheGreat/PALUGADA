/**
 * Finding what was said (F19.14; STATUS section 2.212): a search of one
 * company's rooms, the owner's search of every company's, and a room's pins.
 *
 * Every search runs as the person searching, through `withPeople`, so the
 * database's own rule of who sees which room (0150) is what limits it: a
 * private room the reader is not in, a direct conversation that is not theirs
 * -- the owner's included -- and another company are never searched, whatever
 * is typed. What is typed is taken as it is (`likePattern`): `50%` finds fifty
 * per cent and `A_B` an underscore. The words are matched in the database,
 * on what is still said; there is no model, no vector and no stemming here,
 * and the general search (`/api/search`), which the owner's assistant may
 * read, never reaches a message.
 *
 * Row security keeps PostgreSQL from using 0150's trigram indexes for it:
 * `ILIKE` is not leakproof, so the planner never puts it before the room
 * rules, and a search reads what the reader may see newest first until it
 * has a page. A word found often is found at once; one found nowhere reads
 * the whole company (STATUS 2.212).
 */
import { withControlPlane, withPeople, type TenantClient } from '../db/tenant.ts';
import { PalugadaError } from '../errors.ts';
import { likePattern } from '../owner/search.ts';
import type { FileView, MessageView, PersonRef, SearchHit } from './contract.ts';
import { isPerson } from './principal.ts';
import { roomIdOf, visibleRoom } from './rooms.ts';
import { directoryOf, drawnInline, MESSAGE_COLUMNS, messageViews, type Directory, type MessageRow, type Viewer } from './views.ts';

/** Hits on one page of a company's search. */
export const HITS_PER_PAGE = 20;
/** Hits per company in the owner's search across companies. */
export const HITS_PER_COMPANY = 8;
/** How much of a message a hit shows. */
const EXCERPT = 200;
/** How many of a room's files its details list, newest first. */
export const ROOM_FILES_LISTED = 50;

/** What a search is for: the words, taken literally, and what narrows them. No pattern: everything a person said. */
interface Asked {
  text: string;
  pattern: string | null;
  roomId: string | null;
  from: string | null;
  files: boolean;
  before: number | null;
}

/** The search's words, two to two hundred characters. */
function wordsOf(query: URLSearchParams): { text: string; pattern: string } {
  const text = (query.get('q') ?? '').trim();
  if (text.length < 2 || text.length > 200) {
    throw new PalugadaError('contract.violation', 'search for 2 to 200 characters', { field: 'q' });
  }
  return { text, pattern: likePattern(text) };
}

function askedOf(query: URLSearchParams): Asked {
  const room = query.get('room');
  const from = query.get('from');
  if (from !== null && from !== '' && !isPerson(from) && !/^former:[a-z]{2,16}:[A-Za-z0-9._-]{1,64}$/.test(from)) {
    throw new PalugadaError('contract.violation', 'from is a person: owner, or seat:<id>', { field: 'from' });
  }
  // A person named with no words is everything they said, as Slack's `from:` alone lists it (STATUS 2.218); a room
  // alone is the room itself, read where it is, and needs no search.
  const words = from !== null && from !== '' && (query.get('q') ?? '').trim() === '' ? { text: '', pattern: null } : wordsOf(query);
  const before = query.get('before');
  const position = before === null || before === '' ? null : Number(before);
  if (position !== null && (!Number.isSafeInteger(position) || position < 0)) {
    throw new PalugadaError('contract.violation', 'before is a position a search answered with', { field: 'before' });
  }
  return {
    ...words,
    roomId: room === null || room === '' ? null : roomIdOf(room),
    from: from === null || from === '' ? null : from,
    files: query.get('files') === '1',
    before: position,
  };
}

interface HitRow {
  id: string;
  room_id: string;
  thread_of: string | null;
  position: string;
  author: string;
  author_name: string | null;
  body: string | null;
  created_at: Date;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_bytes: string | null;
  file_kept: boolean | null;
}

/**
 * The newest messages, still said, whose words hold the text, or whose
 * files are named with it when files are asked for: as many as `limit`, in
 * what the reader may see.
 */
async function found(tx: TenantClient, asked: Asked, limit: number): Promise<HitRow[]> {
  const { rows } = await tx.query<HitRow>(
    `SELECT m.id, m.room_id, m.thread_of, m.position, m.author, m.author_name, m.body, m.created_at,
            f.id AS file_id, f.name AS file_name, f.mime AS file_mime, f.bytes AS file_bytes, f.path IS NOT NULL AS file_kept
       FROM room_messages m
       LEFT JOIN LATERAL (
         SELECT one.id, one.name, one.mime, one.bytes, one.path FROM room_files one
          WHERE $2 AND $1::text IS NOT NULL AND one.company_id = m.company_id AND one.message_id = m.id AND one.name ILIKE $1
          ORDER BY one.created_at, one.id LIMIT 1) f ON true
      WHERE m.kind = 'text' AND m.deleted_at IS NULL
        AND ($1::text IS NULL OR m.body ILIKE $1 OR f.id IS NOT NULL)
        AND ($3::uuid IS NULL OR m.room_id = $3)
        AND ($4::text IS NULL OR m.author = $4)
        AND ($5::bigint IS NULL OR m.position < $5)
      ORDER BY m.position DESC
      LIMIT ${limit}`,
    [asked.pattern, asked.files, asked.roomId, asked.from, asked.before]);
  return rows;
}

/** Up to two hundred characters of the words, around where the text was found. */
function excerptOf(body: string, text: string): string {
  const at = body.toLowerCase().indexOf(text.toLowerCase());
  const start = at <= 60 ? 0 : at - 60;
  const cut = body.slice(start, start + EXCERPT);
  return `${start > 0 ? '…' : ''}${cut}${start + EXCERPT < body.length ? '…' : ''}`;
}

function hitOf(row: HitRow, text: string, directory: Directory): SearchHit {
  return {
    roomId: row.room_id,
    messageId: row.id,
    threadOf: row.thread_of,
    position: Number(row.position),
    excerpt: excerptOf(row.body ?? '', text),
    author: directory.refOf(row.author, row.author_name),
    at: row.created_at.toISOString(),
    file: row.file_id === null ? null : {
      id: row.file_id, name: row.file_name!, mime: row.file_mime!, bytes: Number(row.file_bytes),
      inline: drawnInline(row.file_mime!, Number(row.file_bytes), row.file_kept === true),
    },
  };
}

/**
 * A company's rooms, searched as the person: twenty hits, newest first, and
 * the position the next page starts before, or null when there is none.
 * `room` narrows to one room (a room the reader cannot see finds nothing),
 * `from` to one person, and `files=1` also searches the files' names.
 */
export async function searchRooms(viewer: Viewer, query: URLSearchParams): Promise<{ hits: SearchHit[]; before: number | null }> {
  const asked = askedOf(query);
  const directory = await directoryOf(viewer.companyId);
  const rows = await withPeople(viewer.companyId, viewer.person, (tx) => found(tx, asked, HITS_PER_PAGE + 1));
  const page = rows.slice(0, HITS_PER_PAGE);
  return {
    hits: page.map((row) => hitOf(row, asked.text, directory)),
    before: rows.length > HITS_PER_PAGE ? Number(page.at(-1)!.position) : null,
  };
}

/**
 * The owner's search of every company's rooms: each company searched as the
 * owner, so a direct conversation the owner is not in is never found, eight
 * hits a company, the companies in the order they were made. Only the owner
 * reaches it; a seat's search is its own company's.
 */
export async function searchEveryCompany(query: URLSearchParams): Promise<Array<{ companyId: string; company: string; hits: SearchHit[] }>> {
  const asked: Asked = { ...wordsOf(query), roomId: null, from: null, files: query.get('files') === '1', before: null };
  const companies = await withControlPlane(async (tx) => (await tx.query<{ id: string; name: string }>(
    'SELECT id, name FROM companies ORDER BY created_at, id')).rows);
  const answer: Array<{ companyId: string; company: string; hits: SearchHit[] }> = [];
  for (const company of companies) {
    const directory = await directoryOf(company.id);
    const rows = await withPeople(company.id, { principal: 'owner', name: null }, (tx) => found(tx, asked, HITS_PER_COMPANY));
    if (rows.length > 0) answer.push({ companyId: company.id, company: company.name, hits: rows.map((row) => hitOf(row, asked.text, directory)) });
  }
  return answer;
}

/**
 * A room's pinned messages, in the order they were pinned, as the reader may
 * see them: what a room keeps at hand, read with its words, files and cards.
 */
export async function pinnedIn(viewer: Viewer, roomId: string): Promise<MessageView[]> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const { rows } = await tx.query<MessageRow>(
      `SELECT ${MESSAGE_COLUMNS} FROM room_pins p JOIN room_messages m ON m.company_id = p.company_id AND m.id = p.message_id
        WHERE p.room_id = $1 ORDER BY p.pinned_at, p.message_id`, [roomId]);
    return messageViews(tx, viewer, directory, rows);
  });
}

/** A file a room keeps, as its details list it: the file, and the message that carried it. */
export type RoomFileItem = FileView & { messageId: string; threadOf: string | null; author: PersonRef; at: string };

/**
 * The files a room keeps, newest first: those of messages still said, whose
 * bytes are still kept, as the reader may see the room.
 */
export async function filesIn(viewer: Viewer, roomId: string): Promise<RoomFileItem[]> {
  const directory = await directoryOf(viewer.companyId);
  return withPeople(viewer.companyId, viewer.person, async (tx) => {
    await visibleRoom(tx, viewer, roomId);
    const { rows } = await tx.query<{
      id: string; name: string; mime: string; bytes: string; message_id: string; thread_of: string | null;
      author: string; author_name: string | null; created_at: Date;
    }>(
      `SELECT f.id, f.name, f.mime, f.bytes, m.id AS message_id, m.thread_of, m.author, m.author_name, f.created_at
         FROM room_files f JOIN room_messages m ON m.company_id = f.company_id AND m.id = f.message_id
        WHERE m.room_id = $1 AND m.deleted_at IS NULL AND f.path IS NOT NULL
        ORDER BY f.created_at DESC, f.id LIMIT ${ROOM_FILES_LISTED}`, [roomId]);
    return rows.map((row) => ({
      id: row.id, name: row.name, mime: row.mime, bytes: Number(row.bytes), inline: drawnInline(row.mime, Number(row.bytes)),
      messageId: row.message_id, threadOf: row.thread_of, author: directory.refOf(row.author, row.author_name),
      at: row.created_at.toISOString(),
    }));
  });
}
