/**
 * A Slack workspace's history brought in (F19.23; STATUS section 2.214).
 *
 * The owner uploads a Slack export in parts, each kept until the export is
 * read under `<companyId>.people/imports/<importId>/part-NN`, in the people
 * folder that no agent capability and not the owner's Files page reaches. When
 * the last part arrives the import waits to be read, and the worker reads it
 * (`readImports`): each channel becomes a topic room -- a private one stays
 * private, with the owner and the seats its people are linked to -- each
 * thread a thread one level deep, each reaction a reaction, each person an
 * author of the old workspace (`former:slack:<id>`) named in
 * `room_former_people`, and each file its name alone: no file's bytes are in
 * an export, and nothing is fetched from where Slack kept them. Direct
 * conversations are counted and left out, since every person in one would
 * have to be linked to a seat before anyone could be shown it.
 *
 * Everything is written on the control plane in importing mode (0150), so the
 * database writes no feed row, mention or follow for any message: nothing old
 * is new to anyone, and each room changes once, after its messages are in.
 * What came from Slack keeps its Slack id (0159), so a second import of the
 * same export finds everything already there and adds nothing. The parts go
 * when the import is done or failed, after seven days in any case
 * (`sweepImportParts`, from the retention stage), and with the company.
 *
 * Nothing here reaches a model: an imported message given as work is carried
 * as outside words by the doors (STATUS 2.206), whoever presses.
 */
import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { roomsOnControlPlane, withControlPlane, type TenantClient } from '../db/tenant.ts';
import { isPalugadaError, PalugadaError } from '../errors.ts';
import { peopleFolderOf, type PeopleRoots } from './files.ts';
import { assertPeopleOf } from './principal.ts';
import { openZip, type RandomAccess, type ZipEntry, type ZipReader } from './zip.ts';

/** What one part may carry, and how many parts an export may be: a gigabyte of ZIP at most. */
export const PART_BYTES = 16 * 1024 * 1024;
const PARTS_MOST = 64;
/** How long the parts of an import that never ended are kept. */
const PARTS_KEPT_DAYS = 7;
/** How long a worker holds an import it reads before another may take it up: renewed with every room. */
const READING_MINUTES = 30;
/** How many problems one import reports; the table holds two hundred. */
const PROBLEMS_MOST = 200;
/** How many rows one statement writes. */
const BATCH = 500;
/** A message is at most this long in a room (0150). */
const BODY_MOST = 8000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORMER = /^former:[a-z]{2,16}:[A-Za-z0-9._-]{1,64}$/;
const SLACK_ID = /^[A-Za-z0-9._-]{1,64}$/;
const TS = /^(\d{1,12})\.(\d{1,6})$/;
const DAY_FILE = /^([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/;

/** One line of an import's report: what went wrong or was left out, as a code the console says in words. */
export interface Problem {
  code: string;
  /** The entry or folder of the export it is about. */
  entry?: string;
  count?: number;
  /** The name a room was given instead, when a room here already had the channel's. */
  name?: string;
}

/** An import as the owner reads it. */
export interface ImportView {
  id: string;
  source: 'slack';
  status: 'receiving' | 'reading' | 'done' | 'failed';
  parts: number;
  received: number;
  counts: Record<string, number>;
  problems: Problem[];
  createdAt: string;
  finishedAt: string | null;
  /** Whether the uploaded parts are deleted. */
  partsGone: boolean;
}

/** An author of the old workspace, and the seat they were linked to. */
export interface FormerPerson {
  former: string;
  name: string;
  seat: { id: string; name: string } | null;
  linkedAt: string | null;
  /** How many private rooms they were in, which a link would give their seat. */
  rooms: number;
}

/** A room a link would give a seat, or an unlink took back. */
export interface LinkedRoom {
  id: string;
  name: string;
  archived: boolean;
}

interface ImportRow {
  id: string;
  source: 'slack';
  status: ImportView['status'];
  parts: number;
  received: number;
  counts: Record<string, number>;
  problems: Problem[];
  created_at: Date;
  finished_at: Date | null;
  parts_gone_at: Date | null;
}

const IMPORT_COLUMNS = 'id, source, status, parts, received, counts, problems, created_at, finished_at, parts_gone_at';

function viewOf(row: ImportRow): ImportView {
  return {
    id: row.id,
    source: row.source,
    status: row.status,
    parts: row.parts,
    received: row.received,
    counts: row.counts,
    problems: row.problems,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    partsGone: row.parts_gone_at !== null,
  };
}

function importIdOf(value: unknown): string {
  const id = String(value ?? '').toLowerCase();
  if (!UUID.test(id)) throw new PalugadaError('contract.violation', 'an import is named by its id', { importId: value ?? null });
  return id;
}

/** The part's file name: two digits, as there are at most sixty-four. */
function partName(index: number): string {
  return `part-${String(index).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Where the parts are kept.

async function lstatOf(at: string): Promise<Stats | null> {
  try {
    return await lstat(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The folder an import's parts are kept in, under the company's people
 * folder, made one level at a time when `make` says so. Anything but a folder
 * where one goes -- a link above all -- is refused before anything is written
 * through it, so nobody points an export's parts into a company's own folder,
 * which agents read. Null when it is not there.
 */
async function partsFolder(folder: string, importId: string, make: boolean): Promise<string | null> {
  let here = folder;
  for (const part of ['', 'imports', importId]) {
    here = part ? join(here, part) : here;
    let found = await lstatOf(here);
    if (found === null) {
      if (!make) return null;
      try {
        await mkdir(here, { recursive: part === '', mode: 0o700 });
        continue;
      } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure;
        found = await lstatOf(here);
      }
    }
    if (!found?.isDirectory()) {
      throw new PalugadaError('contract.violation',
        "the people folder has something other than a folder where an import's parts go, so nothing is written through it", {});
    }
  }
  return here;
}

/** The folder an import's parts are in, or null: not there, or something other than a folder where one goes. */
async function partsThere(folder: string, importId: string): Promise<string | null> {
  try {
    return await partsFolder(folder, importId, false);
  } catch {
    return null;
  }
}

/** Removes an import's parts, whatever is left of them. */
async function removeParts(folder: string, importId: string): Promise<void> {
  const at = await partsThere(folder, importId);
  if (at !== null) await rm(at, { recursive: true, force: true });
}

/** The parts, laid end to end, read where a ZIP reader asks. */
async function partsAsOne(at: string, parts: number): Promise<RandomAccess & { close(): Promise<void> }> {
  const handles: FileHandle[] = [];
  const starts: number[] = [];
  let size = 0;
  try {
    for (let index = 0; index < parts; index += 1) {
      const handle = await open(join(at, partName(index)), constants.O_RDONLY | constants.O_NOFOLLOW);
      handles.push(handle);
      starts.push(size);
      size += (await handle.stat()).size;
    }
  } catch (error) {
    for (const handle of handles) await handle.close();
    throw new PalugadaError('import.part_missing', `a part of the export is not kept: ${(error as Error).message}`, {});
  }
  return {
    size,
    read: async (position, length) => {
      const out = Buffer.alloc(Math.max(0, Math.min(length, size - position)));
      let filled = 0;
      let part = starts.findLastIndex((start) => start <= position);
      while (filled < out.length && part >= 0 && part < handles.length) {
        const from = position + filled - starts[part]!;
        const { bytesRead } = await handles[part]!.read(out, filled, out.length - filled, from);
        filled += bytesRead;
        if (bytesRead === 0 || position + filled >= (starts[part + 1] ?? size)) part += 1;
      }
      return out.subarray(0, filled);
    },
    close: async () => {
      for (const handle of handles) await handle.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Uploading.

/** An import begun: how many parts the export comes in. Nothing is read until every part has arrived. */
export async function startImport(companyId: string, folder: string | null, body: Record<string, unknown>): Promise<ImportView> {
  if (body.source !== 'slack') {
    throw new PalugadaError('contract.violation', "source is the workspace the export came from, and only 'slack' is read", { field: 'source' });
  }
  const parts = body.parts;
  if (typeof parts !== 'number' || !Number.isInteger(parts) || parts < 1 || parts > PARTS_MOST) {
    throw new PalugadaError('contract.violation', `parts is how many parts the export comes in, 1 to ${PARTS_MOST} of ${PART_BYTES} bytes each`,
      { field: 'parts' });
  }
  if (folder === null) {
    throw new PalugadaError('contract.violation', 'this deployment keeps no files: PALUGADA_FILES_ROOT is not set, so an export has nowhere to wait', {});
  }
  const { rows } = await withControlPlane((tx) => tx.query<ImportRow>(
    `INSERT INTO room_imports (company_id, source, parts) VALUES ($1, 'slack', $2) RETURNING ${IMPORT_COLUMNS}`, [companyId, parts]));
  return viewOf(rows[0]!);
}

/**
 * One part of an export, kept until the export is read. Parts come in order:
 * one ahead of what has arrived is refused (`import.part_missing`), and one
 * sent again, after a connection dropped, takes the place of what arrived
 * before. The last makes the import wait for the worker to read it.
 */
export async function receivePart(
  companyId: string, folder: string | null, importValue: unknown, body: Record<string, unknown>,
): Promise<ImportView> {
  const importId = importIdOf(importValue);
  if (typeof body.base64 !== 'string' || body.base64.length === 0 || body.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) {
    throw new PalugadaError('contract.violation', 'base64 is the part, in base64', { field: 'base64' });
  }
  const bytes = Buffer.from(body.base64, 'base64');
  if (bytes.length > PART_BYTES) {
    throw new PalugadaError('contract.violation', `a part is ${PART_BYTES} bytes at most`, { field: 'base64' });
  }
  const index = body.index;
  if (folder === null) {
    throw new PalugadaError('contract.violation', 'this deployment keeps no files: PALUGADA_FILES_ROOT is not set, so an export has nowhere to wait', {});
  }
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<ImportRow>(
      `SELECT ${IMPORT_COLUMNS} FROM room_imports WHERE company_id = $1 AND id = $2 FOR UPDATE`, [companyId, importId]);
    const row = rows[0];
    if (!row) throw new PalugadaError('contract.violation', 'no such import in this company', { importId });
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= row.parts) {
      throw new PalugadaError('contract.violation', `index is the part's place, 0 to ${row.parts - 1}`, { field: 'index' });
    }
    if (row.status === 'failed' || row.parts_gone_at !== null) {
      throw new PalugadaError('import.part_missing', 'the parts of this export are gone: start the import again', { importId });
    }
    if (row.status !== 'receiving') {
      throw new PalugadaError('contract.violation', 'every part of this export has arrived, and it is read as it is', { importId });
    }
    if (index > row.received) {
      throw new PalugadaError('import.part_missing', `part ${row.received} has not arrived yet: parts come in order`,
        { importId, expected: row.received });
    }
    // Written beside its place and moved into it, so a part is there whole or not at all.
    const at = (await partsFolder(folder, importId, true))!;
    const writing = join(at, `${partName(index)}.${randomUUID()}`);
    const handle = await open(writing, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    await rename(writing, join(at, partName(index)));
    const received = Math.max(row.received, index + 1);
    const { rows: changed } = await tx.query<ImportRow>(
      `UPDATE room_imports SET received = $3, status = CASE WHEN $3 = parts THEN 'reading' ELSE status END
        WHERE company_id = $1 AND id = $2 RETURNING ${IMPORT_COLUMNS}`, [companyId, importId, received]);
    return viewOf(changed[0]!);
  });
}

/** One import, as the owner reads it. */
export async function importOf(companyId: string, importValue: unknown): Promise<ImportView> {
  const importId = importIdOf(importValue);
  const { rows } = await withControlPlane((tx) => tx.query<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM room_imports WHERE company_id = $1 AND id = $2`, [companyId, importId]));
  if (!rows[0]) throw new PalugadaError('contract.violation', 'no such import in this company', { importId });
  return viewOf(rows[0]);
}

/** The company's latest imports, newest first. */
export async function importsOf(companyId: string): Promise<ImportView[]> {
  const { rows } = await withControlPlane((tx) => tx.query<ImportRow>(
    `SELECT ${IMPORT_COLUMNS} FROM room_imports WHERE company_id = $1 ORDER BY created_at DESC, id LIMIT 10`, [companyId]));
  return rows.map(viewOf);
}

// ---------------------------------------------------------------------------
// The old workspace's people, and the seats they became.

interface FormerRow {
  former: string;
  name: string;
  seat_id: string | null;
  seat_name: string | null;
  linked_at: Date | null;
  rooms: string[];
  gave: string[];
}

function formerOf(row: FormerRow, privateRooms: number): FormerPerson {
  return {
    former: row.former,
    name: row.name,
    seat: row.seat_id ? { id: row.seat_id, name: row.seat_name ?? row.name } : null,
    linkedAt: row.linked_at?.toISOString() ?? null,
    rooms: privateRooms,
  };
}

/**
 * The company's room clock, taken first on the control plane as every room
 * write takes it (0150): an import and a link both write room members and
 * former people, and taking the clock before either keeps them from waiting
 * on each other in opposite orders.
 */
async function clockFirst(tx: TenantClient, companyId: string, importing = false): Promise<void> {
  await roomsOnControlPlane(tx, companyId, { importing });
  await tx.query('INSERT INTO room_clock (company_id) VALUES ($1) ON CONFLICT DO NOTHING', [companyId]);
  await tx.query('SELECT 1 FROM room_clock WHERE company_id = $1 FOR UPDATE', [companyId]);
}

const FORMER_COLUMNS = `f.former, f.name, f.seat_id, s.name AS seat_name, f.linked_at, f.rooms::text[] AS rooms, f.gave::text[] AS gave`;

/** Every author an import brought, with the seat each is linked to, by name. */
export async function formerPeopleOf(companyId: string): Promise<FormerPerson[]> {
  return withControlPlane(async (tx) => {
    const { rows } = await tx.query<FormerRow & { private_rooms: number }>(
      `SELECT ${FORMER_COLUMNS},
              (SELECT count(*)::int FROM rooms r WHERE r.company_id = f.company_id AND r.id = ANY(f.rooms) AND r.private) AS private_rooms
         FROM room_former_people f LEFT JOIN staff_seats s ON s.company_id = f.company_id AND s.id = f.seat_id
        WHERE f.company_id = $1 ORDER BY lower(f.name), f.former`, [companyId]);
    return rows.map((row) => formerOf(row, row.private_rooms));
  });
}

function formerFrom(value: unknown): string {
  if (typeof value !== 'string' || !FORMER.test(value)) {
    throw new PalugadaError('contract.violation', "former is an imported author, 'former:slack:<id>'", { field: 'former' });
  }
  return value;
}

async function formerRow(tx: TenantClient, companyId: string, former: string): Promise<FormerRow> {
  const { rows } = await tx.query<FormerRow>(
    `SELECT ${FORMER_COLUMNS} FROM room_former_people f LEFT JOIN staff_seats s ON s.company_id = f.company_id AND s.id = f.seat_id
      WHERE f.company_id = $1 AND f.former = $2 FOR UPDATE OF f`, [companyId, former]);
  if (!rows[0]) throw new PalugadaError('contract.violation', 'nobody of that name came with an import here', { former });
  return rows[0];
}

/** The private rooms of `ids` a seat is not in now, by name. */
async function privateRoomsWithout(tx: TenantClient, companyId: string, ids: readonly string[], principal: string): Promise<LinkedRoom[]> {
  if (ids.length === 0) return [];
  const { rows } = await tx.query<{ id: string; name: string; archived: boolean }>(
    `SELECT r.id, r.name, r.archived_at IS NOT NULL AS archived FROM rooms r
      WHERE r.company_id = $1 AND r.id = ANY($2::uuid[]) AND r.private
        AND NOT EXISTS (SELECT 1 FROM room_members m WHERE m.company_id = r.company_id AND m.room_id = r.id
                         AND m.principal = $3 AND m.left_at IS NULL)
      ORDER BY lower(r.name), r.id`, [companyId, ids, principal]);
  return rows;
}

/**
 * Links an author of the old workspace to a seat: what they said is drawn
 * under the seat's name, and the seat joins the private rooms they were in.
 * Without `confirm` nothing changes, and the answer is the private rooms the
 * seat would gain, which the owner is shown first. One link a person: a
 * person linked to another seat is refused (`import.former_linked`) until
 * unlinked.
 */
export async function linkFormer(
  companyId: string, body: Record<string, unknown>,
): Promise<{ person: FormerPerson; rooms: LinkedRoom[]; linked: boolean }> {
  const former = formerFrom(body.former);
  const seatId = String(body.seatId ?? '').toLowerCase();
  if (!UUID.test(seatId)) throw new PalugadaError('contract.violation', 'seatId is the seat to link them to', { field: 'seatId' });
  const principal = `seat:${seatId}`;
  // Seated, joined and not ended, in this company.
  const [seat] = await assertPeopleOf(companyId, [principal]);
  return withControlPlane(async (tx) => {
    // Each membership is told to whoever has the room open: not importing.
    await clockFirst(tx, companyId);
    const row = await formerRow(tx, companyId, former);
    if (row.seat_id !== null && row.seat_id !== seatId) {
      throw new PalugadaError('import.former_linked', `${row.name} is linked to ${row.seat_name ?? 'a seat'} already: unlink them first`,
        { former });
    }
    const gaining = await privateRoomsWithout(tx, companyId, row.rooms, principal);
    if (body.confirm !== true || row.seat_id === seatId) {
      const linked = row.seat_id === seatId;
      return { person: formerOf(row, row.rooms.length), rooms: linked ? [] : gaining, linked };
    }
    const gave: string[] = [];
    for (const room of gaining) {
      const { rowCount } = await tx.query(
        `INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, $3, $4, 'member', 'owner')
         ON CONFLICT (company_id, room_id, principal) DO UPDATE SET left_at = NULL, left_by = NULL, joined_at = clock_timestamp(),
                                                                   name = EXCLUDED.name, added_by = 'owner'
           WHERE room_members.left_at IS NOT NULL`,
        [companyId, room.id, principal, seat!.name]);
      if (rowCount) gave.push(room.id);
    }
    await tx.query(
      'UPDATE room_former_people SET seat_id = $3, linked_at = now(), gave = $4::uuid[] WHERE company_id = $1 AND former = $2',
      [companyId, former, seatId, gave]);
    const linked = await formerRow(tx, companyId, former);
    return { person: formerOf(linked, linked.rooms.length), rooms: gaining.filter((room) => gave.includes(room.id)), linked: true };
  });
}

/**
 * Undoes a link: what they said is drawn under their old name again, and the
 * seat leaves the private rooms the link gave it, as removed by the owner. A
 * room the seat was in apart from the link stays its own.
 */
export async function unlinkFormer(companyId: string, body: Record<string, unknown>): Promise<{ person: FormerPerson; rooms: LinkedRoom[] }> {
  const former = formerFrom(body.former);
  return withControlPlane(async (tx) => {
    await clockFirst(tx, companyId);
    const row = await formerRow(tx, companyId, former);
    if (row.seat_id === null) return { person: formerOf(row, row.rooms.length), rooms: [] };
    const { rows: taken } = await tx.query<{ room_id: string }>(
      `UPDATE room_members SET left_at = clock_timestamp(), left_by = 'owner'
        WHERE company_id = $1 AND room_id = ANY($2::uuid[]) AND principal = $3 AND left_at IS NULL
        RETURNING room_id`, [companyId, row.gave, `seat:${row.seat_id}`]);
    await tx.query(
      "UPDATE room_former_people SET seat_id = NULL, linked_at = NULL, gave = '{}' WHERE company_id = $1 AND former = $2",
      [companyId, former]);
    const { rows: rooms } = await tx.query<LinkedRoom>(
      `SELECT id, name, archived_at IS NOT NULL AS archived FROM rooms WHERE company_id = $1 AND id = ANY($2::uuid[])
        ORDER BY lower(name), id`, [companyId, taken.map((one) => one.room_id)]);
    const unlinked = await formerRow(tx, companyId, former);
    return { person: formerOf(unlinked, unlinked.rooms.length), rooms };
  });
}

// ---------------------------------------------------------------------------
// Reading an export.

/** What a report holds: lines, in the order they were found, two hundred at most. */
class Problems {
  readonly lines: Problem[] = [];
  #more = 0;

  add(problem: Problem): void {
    if (this.lines.length < PROBLEMS_MOST - 1) this.lines.push(problem);
    else this.#more += 1;
  }

  report(): Problem[] {
    return this.#more === 0 ? this.lines : [...this.lines, { code: 'more', count: this.#more }];
  }
}

/** What the report counts. */
interface Counts {
  entries: number;
  channels: number;
  rooms: number;
  messages: number;
  replies: number;
  reactions: number;
  files: number;
  people: number;
  already: number;
  skipped: number;
  direct: number;
  groups: number;
  directMessages: number;
}

interface Channel {
  id: string;
  name: string;
  private: boolean;
  archived: boolean;
  created: Date | null;
  about: string | null;
  members: string[];
}

interface Export {
  users: Map<string, string>;
  channels: Channel[];
  /** Each channel's day files, by the channel's id. */
  days: Map<string, ZipEntry[]>;
}

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value : null);

/** An export's entry as JSON, or nothing and a line of the report. A refusal for size ends the whole import. */
async function jsonOf(zip: ZipReader, entry: ZipEntry, problems: Problems): Promise<unknown> {
  let bytes: Buffer;
  try {
    bytes = await zip.read(entry);
  } catch (error) {
    if (isPalugadaError(error, 'import.zip')) {
      problems.add({ code: 'unreadable', entry: entry.name });
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));
  } catch {
    problems.add({ code: 'not_json', entry: entry.name });
    return undefined;
  }
}

/** A list from one of the export's lists, or an empty one and a line of the report. */
async function listOf(zip: ZipReader, entry: ZipEntry | undefined, problems: Problems): Promise<Raw[] | null> {
  if (!entry) return null;
  const value = await jsonOf(zip, entry, problems);
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    problems.add({ code: 'not_json', entry: entry.name });
    return [];
  }
  return value.filter(isObject);
}

/** A person's name as the export gives it: their full name, else what they chose, else their handle. */
function nameOfUser(user: Raw): string | null {
  const profile = isObject(user.profile) ? user.profile : {};
  return text(profile.real_name) ?? text(user.real_name) ?? text(profile.display_name) ?? text(user.name);
}

function slackTime(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

/** A Slack timestamp as a time, and as a pair that orders messages exactly. */
function tsOf(value: unknown): { at: Date; order: [number, number]; ts: string } | null {
  if (typeof value !== 'string') return null;
  const parts = TS.exec(value);
  if (!parts) return null;
  const seconds = Number(parts[1]);
  const micro = Number(parts[2]!.padEnd(6, '0'));
  return { at: new Date(seconds * 1000 + Math.floor(micro / 1000)), order: [seconds, micro], ts: value };
}

function channelOf(raw: Raw, isPrivate: boolean): Channel | null {
  const id = text(raw.id);
  const name = text(raw.name);
  if (!id || !name || !SLACK_ID.test(id)) return null;
  const purpose = isObject(raw.purpose) ? text(raw.purpose.value) : null;
  const topic = isObject(raw.topic) ? text(raw.topic.value) : null;
  return {
    id,
    name,
    private: isPrivate || raw.is_private === true,
    archived: raw.is_archived === true,
    created: slackTime(raw.created),
    about: (purpose ?? topic)?.slice(0, 500) ?? null,
    members: Array.isArray(raw.members) ? raw.members.filter((one): one is string => typeof one === 'string' && SLACK_ID.test(one)) : [],
  };
}

/**
 * Reads what an export says of itself: its people, its channels, and which
 * day files are whose. Every entry it will read is unpacked once first, so
 * an entry past a cap refuses the import before anything is written, and a
 * damaged one is a line of the report rather than a stop half way.
 */
async function readExport(zip: ZipReader, problems: Problems, counts: Counts): Promise<Export> {
  const named = new Map(zip.entries.map((entry) => [entry.name, entry]));
  const days = new Map<string, ZipEntry[]>();
  for (const entry of zip.entries) {
    const day = DAY_FILE.exec(entry.name);
    if (!day) continue;
    const list = days.get(day[1]!) ?? [];
    list.push(entry);
    days.set(day[1]!, list);
  }
  const lists = ['users.json', 'channels.json', 'groups.json', 'dms.json', 'mpims.json'];
  const broken = new Set<number>();
  for (const entry of [...lists.map((name) => named.get(name)), ...[...days.values()].flat()]) {
    if (!entry) continue;
    try {
      await zip.read(entry);
    } catch (error) {
      if (!isPalugadaError(error, 'import.zip')) throw error;
      broken.add(entry.index);
    }
  }
  // A damaged entry is said once, and left out wherever it would be read.
  const usable = (entry: ZipEntry | undefined): ZipEntry | undefined => {
    if (!entry || !broken.has(entry.index)) return entry;
    problems.add({ code: 'unreadable', entry: entry.name });
    return undefined;
  };

  const users = new Map<string, string>();
  for (const user of await listOf(zip, usable(named.get('users.json')), problems) ?? []) {
    const id = text(user.id);
    const name = nameOfUser(user);
    if (id && name && SLACK_ID.test(id)) users.set(id, name.slice(0, 120));
  }
  const open = await listOf(zip, usable(named.get('channels.json')), problems);
  const closed = await listOf(zip, usable(named.get('groups.json')), problems);
  if (open === null && closed === null) {
    throw new PalugadaError('import.zip', 'that is not a Slack export: it has no list of channels', { code: 'not_slack' });
  }
  const channels: Channel[] = [];
  const seen = new Set<string>();
  for (const [list, isPrivate] of [[open ?? [], false], [closed ?? [], true]] as const) {
    for (const raw of list) {
      const channel = channelOf(raw, isPrivate);
      if (!channel || seen.has(channel.id)) continue;
      seen.add(channel.id);
      channels.push(channel);
    }
  }
  counts.channels = channels.length;

  // Direct conversations: counted, read only to count their messages, and left out.
  const dms = await listOf(zip, usable(named.get('dms.json')), problems) ?? [];
  const groups = await listOf(zip, usable(named.get('mpims.json')), problems) ?? [];
  counts.direct = dms.length;
  counts.groups = groups.length;
  const direct = new Set([...dms, ...groups].flatMap((raw) => [text(raw.id), text(raw.name)]).filter((one): one is string => one !== null));

  const byFolder = new Map(channels.map((channel) => [channel.name, channel]));
  const ofChannels = new Map<string, ZipEntry[]>();
  for (const [folder, entries] of [...days].sort(([a], [b]) => a.localeCompare(b))) {
    const channel = byFolder.get(folder) ?? channels.find((one) => one.id === folder);
    if (channel) {
      ofChannels.set(channel.id, entries.filter((entry) => usable(entry) !== undefined).sort((a, b) => a.name.localeCompare(b.name)));
    } else if (direct.has(folder) || /^(D[A-Z0-9]+|mpdm-.+)$/.test(folder)) {
      for (const entry of entries) {
        const said = usable(entry) ? await jsonOf(zip, entry, problems) : undefined;
        if (Array.isArray(said)) counts.directMessages += said.filter(isObject).length;
      }
    } else {
      problems.add({ code: 'unknown_folder', entry: folder });
    }
  }
  if (counts.direct + counts.groups > 0) problems.add({ code: 'direct_skipped', count: counts.direct + counts.groups });
  return { users, channels, days: ofChannels };
}

/**
 * What people said: a message with no subtype, a bot's, a file shared, a
 * reply sent to the channel too, a `/me`. Every other subtype is Slack
 * writing about the channel -- a join, a leave, a topic -- which nobody said.
 */
const SAID = new Set([undefined, 'bot_message', 'file_share', 'thread_broadcast', 'reply_broadcast', 'me_message']);

/** Reactions by their Slack names, as the emoji they draw; any other is kept as its name. */
const EMOJI: Readonly<Record<string, string>> = {
  '+1': '👍', thumbsup: '👍', '-1': '👎', thumbsdown: '👎', tada: '🎉', heart: '❤️', joy: '😂', smile: '😄',
  slightly_smiling_face: '🙂', grinning: '😀', laughing: '😆', sweat_smile: '😅', sob: '😭', thinking_face: '🤔', eyes: '👀',
  pray: '🙏', fire: '🔥', rocket: '🚀', clap: '👏', ok_hand: '👌', raised_hands: '🙌', wave: '👋', muscle: '💪', '100': '💯',
  white_check_mark: '✅', heavy_check_mark: '✔️', x: '❌', warning: '⚠️', star: '⭐', sparkles: '✨', bulb: '💡',
  point_up: '☝️', point_right: '👉', handshake: '🤝', partying_face: '🥳', heart_eyes: '😍', relieved: '😌', cry: '😢',
};

/** A reaction's emoji: the one Slack's name draws, or the name itself, short enough for a room (0150). */
function emojiOf(name: string): string {
  const bare = name.replace(/::skin-tone-\d$/, '');
  return EMOJI[bare] ?? `:${bare.slice(0, 14)}:`;
}

/**
 * Slack's markup, made plain enough to read here: a person named by id is
 * named by name, a channel by `#name`, a link by Markdown, and the three
 * escaped characters are themselves. `@channel` and its kin stay words: an
 * old announcement tells nobody anything now.
 */
function fromMrkdwn(said: string, users: ReadonlyMap<string, string>, channels: ReadonlyMap<string, string>): string {
  return said
    .replace(/<([^<>]+)>/g, (whole, inside: string) => {
      const [target = '', label] = inside.split('|', 2);
      if (target.startsWith('@')) return `@${label ?? users.get(target.slice(1)) ?? target.slice(1)}`;
      if (target.startsWith('#')) return `#${label ?? channels.get(target.slice(1)) ?? target.slice(1)}`;
      if (target.startsWith('!subteam^')) return label ?? '@team';
      // A date Slack drew in each reader's own time: the words it falls back to.
      if (target.startsWith('!date^')) return label ?? '';
      if (target.startsWith('!')) return `@${(label ?? target.slice(1)).replace(/^@/, '')}`;
      if (/^(https?|mailto|tel):/i.test(target)) return label && label !== target ? `[${label}](${target})` : target;
      return whole;
    })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** One message as it will be written. */
interface Message {
  id: string;
  ext: string;
  at: Date;
  order: [number, number];
  threadTs: string | null;
  alsoInRoom: boolean;
  author: string;
  name: string;
  body: string;
  reactions: Array<{ principal: string; emoji: string }>;
  files: Array<{ name: string; mime: string; bytes: number }>;
}

/** A channel's messages from its day files, in the order they were said; what cannot be one is counted or reported. */
async function messagesOf(
  zip: ZipReader, entries: readonly ZipEntry[], slack: Export, channelNames: ReadonlyMap<string, string>,
  problems: Problems, counts: Counts,
): Promise<Message[]> {
  const messages: Message[] = [];
  for (const entry of entries) {
    const said = await jsonOf(zip, entry, problems);
    if (said === undefined) continue;
    if (!Array.isArray(said)) {
      problems.add({ code: 'not_json', entry: entry.name });
      continue;
    }
    let skipped = 0;
    for (const raw of said) {
      if (!isObject(raw)) {
        skipped += 1;
        continue;
      }
      if (!SAID.has(raw.subtype as string | undefined)) {
        counts.skipped += 1;
        continue;
      }
      const ts = tsOf(raw.ts);
      // A bot's message is the bot's, whoever it posted for; anyone else's is the person's.
      const user = text(raw.user);
      const bot = text(raw.bot_id);
      const person = user && SLACK_ID.test(user) ? user : null;
      const machine = bot && SLACK_ID.test(bot) ? bot : null;
      const who = raw.subtype === 'bot_message' ? machine ?? person : person ?? machine;
      if (!ts || !who) {
        skipped += 1;
        continue;
      }
      const profile = isObject(raw.user_profile) ? raw.user_profile : {};
      const botProfile = isObject(raw.bot_profile) ? raw.bot_profile : {};
      const name = (slack.users.get(who) ?? text(profile.real_name) ?? text(profile.display_name) ?? text(raw.username)
        ?? text(botProfile.name) ?? who).slice(0, 120);
      const files = (Array.isArray(raw.files) ? raw.files : []).filter(isObject).map((file) => ({
        name: (text(file.name) ?? text(file.title) ?? 'file').slice(0, 200),
        mime: typeof file.mimetype === 'string' && /^[\w.+-]{1,49}\/[\w.+-]{1,49}$/.test(file.mimetype) ? file.mimetype : 'application/octet-stream',
        bytes: typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0 && file.size <= 25_165_824 ? file.size : 0,
      })).slice(0, 20);
      let body = fromMrkdwn(typeof raw.text === 'string' ? raw.text : '', slack.users, channelNames);
      if (body.trim() === '' && files.length === 0) {
        counts.skipped += 1;
        continue;
      }
      if ([...body].length > BODY_MOST) body = `${[...body].slice(0, BODY_MOST - 1).join('')}…`;
      const reactions: Message['reactions'] = [];
      for (const reaction of (Array.isArray(raw.reactions) ? raw.reactions : []).filter(isObject)) {
        if (typeof reaction.name !== 'string' || reaction.name === '') continue;
        const emoji = emojiOf(reaction.name);
        for (const by of Array.isArray(reaction.users) ? reaction.users : []) {
          if (typeof by === 'string' && SLACK_ID.test(by)) reactions.push({ principal: `former:slack:${by}`, emoji });
        }
      }
      const threadTs = typeof raw.thread_ts === 'string' && raw.thread_ts !== ts.ts ? raw.thread_ts : null;
      messages.push({
        id: randomUUID(),
        ext: `slack:${ts.ts}`,
        at: ts.at,
        order: ts.order,
        threadTs,
        alsoInRoom: threadTs !== null && (raw.subtype === 'thread_broadcast' || raw.subtype === 'reply_broadcast'),
        author: `former:slack:${who}`,
        name,
        body,
        reactions,
        files,
      });
    }
    if (skipped > 0) problems.add({ code: 'message_skipped', entry: entry.name, count: skipped });
  }
  return messages.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
}

/** A name for a channel's room no live room of the company has: its own, or with `(slack)` after it. */
async function freeName(tx: TenantClient, companyId: string, name: string): Promise<string> {
  const base = name.slice(0, 70);
  const candidates = [name.slice(0, 80), `${base} (slack)`, ...Array.from({ length: 18 }, (_, n) => `${base} (slack ${n + 2})`)];
  const { rows } = await tx.query<{ name: string }>(
    `SELECT lower(name) AS name FROM rooms WHERE company_id = $1 AND kind = 'topic' AND archived_at IS NULL
        AND lower(name) = ANY($2::text[])`, [companyId, candidates.map((one) => one.toLowerCase())]);
  const taken = new Set(rows.map((row) => row.name));
  const free = candidates.find((one) => !taken.has(one.toLowerCase()));
  if (!free) throw new PalugadaError('contract.violation', `no free name for the channel ${name}`, {});
  return free;
}

/**
 * One channel into its room, in one transaction on the control plane: the
 * room when it is new, then the messages, reactions and files it does not
 * have yet, the owner and the seats linked to its people, the threads
 * counted, and one change for whoever has the room open. Answers nothing;
 * the counts say what was written.
 */
async function writeChannel(
  companyId: string, importId: string, channel: Channel, messages: readonly Message[], users: ReadonlyMap<string, string>,
  problems: Problems, counts: Counts,
): Promise<void> {
  await withControlPlane(async (tx) => {
    // The clock first: whether a room or a message is already here is then
    // read once nobody else can add one.
    await clockFirst(tx, companyId, true);
    await tx.query('UPDATE room_imports SET reading_until = now() + make_interval(mins => $3) WHERE company_id = $1 AND id = $2',
      [companyId, importId, READING_MINUTES]);
    let wrote = false;

    const external = `slack:${channel.id}`;
    const { rows: found } = await tx.query<{ id: string; last: string | null }>(
      `SELECT r.id, (SELECT max(position) FROM room_messages m WHERE m.company_id = r.company_id AND m.room_id = r.id) AS last
         FROM rooms r WHERE r.company_id = $1 AND r.external_id = $2`, [companyId, external]);
    let roomId = found[0]?.id;
    const lastBefore = Number(found[0]?.last ?? 0);
    if (roomId === undefined) {
      roomId = randomUUID();
      // An archived room's name is nobody's to keep free: only live rooms hold a name (0150).
      const name = channel.archived ? channel.name.slice(0, 80) : await freeName(tx, companyId, channel.name);
      if (name !== channel.name.slice(0, 80)) problems.add({ code: 'renamed', entry: channel.name, name });
      await tx.query(
        `INSERT INTO rooms (id, company_id, kind, name, about, private, created_by, created_at, archived_at, archived_by, external_id)
         VALUES ($1, $2, 'topic', $3, $4, $5, 'owner', $6, $7, $8, $9)`,
        [roomId, companyId, name, channel.about, channel.private, channel.created ?? new Date(),
          channel.archived ? new Date() : null, channel.archived ? 'owner' : null, external]);
      counts.rooms += 1;
      wrote = true;
    }

    // The people it names: those who said something, and a private channel's members.
    const people = new Map<string, string>();
    for (const message of messages) people.set(message.author, message.name);
    const members = channel.private ? channel.members.map((member) => `former:slack:${member}`) : [];
    if (people.size > 0 || members.length > 0) {
      const named = [...new Set([...people.keys(), ...members])];
      const { rowCount } = await tx.query(
        `INSERT INTO room_former_people (company_id, former, name)
         SELECT $1, u.former, u.name FROM unnest($2::text[], $3::text[]) AS u(former, name)
         ON CONFLICT (company_id, former) DO UPDATE SET name = EXCLUDED.name WHERE room_former_people.name <> EXCLUDED.name`,
        [companyId, named, named.map((former) => people.get(former) ?? nameOfFormer(former, users))]);
      counts.people += rowCount ?? 0;
    }
    if (members.length > 0) {
      await tx.query(
        `UPDATE room_former_people SET rooms = array_append(rooms, $3::uuid)
          WHERE company_id = $1 AND former = ANY($2::text[]) AND NOT ($3::uuid = ANY(rooms))`, [companyId, members, roomId]);
    }

    // The messages not here yet, in the order they were said.
    const { rows: had } = await tx.query<{ id: string; external_id: string }>(
      'SELECT id, external_id FROM room_messages WHERE company_id = $1 AND room_id = $2 AND external_id IS NOT NULL', [companyId, roomId]);
    const idOf = new Map(had.map((row) => [row.external_id, row.id]));
    const fresh: Message[] = [];
    for (const message of messages) {
      const there = idOf.get(message.ext);
      if (there !== undefined) {
        counts.already += 1;
        message.id = there;
        continue;
      }
      idOf.set(message.ext, message.id);
      fresh.push(message);
    }
    for (let at = 0; at < fresh.length; at += BATCH) {
      const batch = fresh.slice(at, at + BATCH);
      // A reply to a message the export does not carry is kept at the top of the room.
      const roots = batch.map((message) => (message.threadTs ? idOf.get(`slack:${message.threadTs}`) ?? null : null));
      await tx.query(
        `INSERT INTO room_messages (id, company_id, room_id, thread_of, also_in_room, kind, author, author_name, body, via, created_at, external_id)
         SELECT u.id, $1, $2, u.thread_of, u.also, 'text', u.author, u.name, u.body, 'import', u.at, u.ext
           FROM unnest($3::uuid[], $4::uuid[], $5::boolean[], $6::text[], $7::text[], $8::text[], $9::timestamptz[], $10::text[])
                WITH ORDINALITY AS u(id, thread_of, also, author, name, body, at, ext, n)
          ORDER BY u.n`,
        [companyId, roomId, batch.map((one) => one.id), roots,
          batch.map((one, index) => one.alsoInRoom && roots[index] !== null), batch.map((one) => one.author),
          batch.map((one) => one.name), batch.map((one) => one.body), batch.map((one) => one.at), batch.map((one) => one.ext)]);
      counts.messages += batch.length;
      counts.replies += roots.filter((one) => one !== null).length;
      wrote = true;
    }
    // A file's name, kind and size, and never its bytes: the export has none.
    const files = fresh.flatMap((message) => message.files.map((file) => ({ ...file, message: message.id, at: message.at })));
    for (let at = 0; at < files.length; at += BATCH) {
      const batch = files.slice(at, at + BATCH);
      await tx.query(
        `INSERT INTO room_files (company_id, message_id, name, mime, bytes, created_at)
         SELECT $1, u.message, u.name, u.mime, u.bytes, u.at
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::bigint[], $6::timestamptz[]) AS u(message, name, mime, bytes, at)`,
        [companyId, batch.map((one) => one.message), batch.map((one) => one.name), batch.map((one) => one.mime),
          batch.map((one) => one.bytes), batch.map((one) => one.at)]);
      counts.files += batch.length;
    }
    // Reactions, on every message the export carries: one added in Slack
    // since an earlier export is added, and one already here is not again.
    // Each is a millisecond after the one before it on its message, so they
    // are drawn in the order Slack gave them.
    const reactions = messages.flatMap((message) => message.reactions.map((reaction, index) => ({
      ...reaction, message: message.id, at: new Date(message.at.getTime() + index),
    })));
    for (let at = 0; at < reactions.length; at += BATCH) {
      const batch = reactions.slice(at, at + BATCH);
      const { rowCount } = await tx.query(
        `INSERT INTO room_reactions (company_id, message_id, principal, emoji, created_at)
         SELECT $1, u.message, u.principal, u.emoji, u.at
           FROM unnest($2::uuid[], $3::text[], $4::text[], $5::timestamptz[]) AS u(message, principal, emoji, at)
         ON CONFLICT DO NOTHING`,
        [companyId, batch.map((one) => one.message), batch.map((one) => one.principal), batch.map((one) => one.emoji),
          batch.map((one) => one.at)]);
      counts.reactions += rowCount ?? 0;
      if (rowCount) wrote = true;
    }

    // The owner, who imported it; and in a private room, each seat its people are linked to.
    const { rowCount: ownerJoined } = await tx.query(
      `INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, 'owner', NULL, 'member', 'owner')
       ON CONFLICT DO NOTHING`, [companyId, roomId]);
    if (ownerJoined) wrote = true;
    if (members.length > 0) {
      const { rows: linked } = await tx.query<{ former: string; seat_id: string; name: string }>(
        `SELECT f.former, f.seat_id, s.name FROM room_former_people f
           JOIN staff_seats s ON s.company_id = f.company_id AND s.id = f.seat_id
          WHERE f.company_id = $1 AND f.former = ANY($2::text[]) AND s.joined_at IS NOT NULL AND s.revoked_at IS NULL
          ORDER BY f.former`, [companyId, members]);
      for (const one of linked) {
        const { rowCount } = await tx.query(
          `INSERT INTO room_members (company_id, room_id, principal, name, role, added_by) VALUES ($1, $2, $3, $4, 'member', 'owner')
           ON CONFLICT DO NOTHING`, [companyId, roomId, `seat:${one.seat_id}`, one.name]);
        if (!rowCount) continue;
        wrote = true;
        await tx.query(
          `UPDATE room_former_people SET gave = array_append(gave, $3::uuid)
            WHERE company_id = $1 AND former = $2 AND NOT ($3::uuid = ANY(gave))`, [companyId, one.former, roomId]);
      }
    }

    if (!wrote) return;
    // Each thread counts its replies, which the triggers left alone while importing.
    await tx.query(
      `UPDATE room_messages m SET reply_count = c.n, last_reply_position = c.last
         FROM (SELECT thread_of, count(*)::int AS n, max(position) AS last FROM room_messages
                WHERE company_id = $1 AND room_id = $2 AND thread_of IS NOT NULL GROUP BY thread_of) c
        WHERE m.company_id = $1 AND m.id = c.thread_of
          AND (m.reply_count <> c.n OR m.last_reply_position IS DISTINCT FROM c.last)`, [companyId, roomId]);
    // Whoever had read all of the room has read what came from Slack too:
    // what was said there long ago is nobody's news.
    await tx.query(
      `UPDATE room_places p SET read_position = c.position FROM room_clock c
        WHERE p.company_id = $1 AND p.room_id = $2 AND c.company_id = $1
          AND p.read_position >= $3 AND p.read_position < c.position`, [companyId, roomId, lastBefore]);
    // The import of this room is over: one change, for whoever has it open.
    await roomsOnControlPlane(tx, companyId);
    await tx.query('UPDATE rooms SET name = name WHERE company_id = $1 AND id = $2', [companyId, roomId]);
  });
}

/** A private channel's member who said nothing: named as the export's people name them, or by their id. */
function nameOfFormer(former: string, users: ReadonlyMap<string, string>): string {
  const id = former.slice('former:slack:'.length);
  return users.get(id) ?? id;
}

/** What a failure of the whole import says in its report. */
function failureOf(error: unknown): Problem {
  if (isPalugadaError(error, 'import.too_large')) {
    return typeof error.details.entry === 'string' ? { code: 'too_large', entry: error.details.entry } : { code: 'too_large' };
  }
  if (isPalugadaError(error, 'import.part_missing')) return { code: 'part_missing' };
  if (isPalugadaError(error, 'import.zip')) return { code: error.details.code === 'not_slack' ? 'not_slack' : 'not_a_zip' };
  return { code: 'stopped' };
}

/** Reads one import whose parts have all arrived, and ends it, done or failed; its parts go either way. */
async function readOne(companyId: string, folder: string, importId: string, parts: number): Promise<void> {
  const problems = new Problems();
  const counts: Counts = {
    entries: 0, channels: 0, rooms: 0, messages: 0, replies: 0, reactions: 0, files: 0, people: 0, already: 0, skipped: 0,
    direct: 0, groups: 0, directMessages: 0,
  };
  let failed: Problem | null = null;
  let unexpected: unknown = null;
  const at = await partsThere(folder, importId);
  let source: Awaited<ReturnType<typeof partsAsOne>> | null = null;
  try {
    if (at === null) throw new PalugadaError('import.part_missing', 'the parts of this export are gone', {});
    source = await partsAsOne(at, parts);
    const zip = await openZip(source);
    counts.entries = zip.entries.length;
    const slack = await readExport(zip, problems, counts);
    // Each channel by id, for `<#C…>` in what any channel says.
    const channelNames = new Map(slack.channels.map((one) => [one.id, one.name]));
    const inOrder = [...slack.channels]
      .sort((a, b) => (a.created?.getTime() ?? 0) - (b.created?.getTime() ?? 0) || a.name.localeCompare(b.name));
    for (const channel of inOrder) {
      const messages = await messagesOf(zip, slack.days.get(channel.id) ?? [], slack, channelNames, problems, counts);
      await writeChannel(companyId, importId, channel, messages, slack.users, problems, counts);
    }
  } catch (error) {
    failed = failureOf(error);
    if (failed.code === 'stopped') unexpected = error;
  } finally {
    await source?.close();
  }
  await withControlPlane((tx) => tx.query(
    `UPDATE room_imports SET status = $3, counts = $4::jsonb, problems = $5::jsonb, finished_at = now(), reading_until = NULL
      WHERE company_id = $1 AND id = $2`,
    [companyId, importId, failed ? 'failed' : 'done', JSON.stringify(counts), JSON.stringify(failed ? [failed] : problems.report())]));
  await removeParts(folder, importId);
  await withControlPlane((tx) => tx.query(
    'UPDATE room_imports SET parts_gone_at = now() WHERE company_id = $1 AND id = $2', [companyId, importId]));
  // A failure nobody foresaw is ended in the report, and still said where the worker logs it.
  if (unexpected !== null) throw unexpected;
}

/**
 * The worker's reading step: every import of the company whose parts have
 * all arrived, one at a time, each taken by one worker for half an hour at a
 * time, renewed with every room, so another takes it up only after a worker
 * that stopped. Answers how many it read.
 */
export async function readImports(companyId: string, roots: PeopleRoots): Promise<number> {
  const folder = peopleFolderOf(roots, companyId);
  if (folder === null) return 0;
  let read = 0;
  for (;;) {
    const { rows } = await withControlPlane((tx) => tx.query<{ id: string; parts: number }>(
      `UPDATE room_imports SET reading_until = now() + make_interval(mins => $2)
        WHERE id = (SELECT id FROM room_imports
                     WHERE company_id = $1 AND status = 'reading' AND (reading_until IS NULL OR reading_until < now())
                     ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING id, parts`, [companyId, READING_MINUTES]));
    const claimed = rows[0];
    if (!claimed) return read;
    await readOne(companyId, folder, claimed.id, claimed.parts);
    read += 1;
  }
}

/**
 * The retention stage's sweep of import parts: an import that never ended
 * fails after seven days, and the parts of every import that ended go, with
 * any folder under `imports/` no import names once it is an hour old. Answers
 * how many imports' parts went.
 */
export async function sweepImportParts(companyId: string, folder: string | null, now = new Date()): Promise<number> {
  if (folder === null) return 0;
  const { rows } = await withControlPlane(async (tx) => {
    await tx.query(
      `UPDATE room_imports SET status = 'failed', finished_at = now(), reading_until = NULL, problems = '[{"code":"parts_expired"}]'
        WHERE company_id = $1 AND status IN ('receiving', 'reading') AND created_at <= $2::timestamptz - make_interval(days => $3)
          AND (reading_until IS NULL OR reading_until < now())`, [companyId, now, PARTS_KEPT_DAYS]);
    return tx.query<{ id: string; ended: boolean; gone: boolean }>(
      `SELECT id, status IN ('done', 'failed') AS ended, parts_gone_at IS NOT NULL AS gone FROM room_imports WHERE company_id = $1`,
      [companyId]);
  });
  const known = new Map(rows.map((row) => [row.id, row]));
  let swept = 0;
  const imports = join(folder, 'imports');
  const there = await lstatOf(imports);
  const folders = there?.isDirectory() ? await readdir(imports) : [];
  for (const name of folders) {
    const row = known.get(name);
    if (row && !row.ended) continue;
    if (!row) {
      const age = await lstatOf(join(imports, name));
      if (age === null || now.getTime() - age.mtimeMs < 60 * 60 * 1000) continue;
      await rm(join(imports, name), { recursive: true, force: true });
      continue;
    }
    await removeParts(folder, name);
    swept += 1;
  }
  const ended = rows.filter((row) => row.ended && !row.gone).map((row) => row.id);
  if (ended.length > 0) {
    await withControlPlane((tx) => tx.query(
      'UPDATE room_imports SET parts_gone_at = now() WHERE company_id = $1 AND id = ANY($2::uuid[]) AND parts_gone_at IS NULL',
      [companyId, ended]));
  }
  return swept;
}
