/**
 * People's notices as a test drives them (F19.13, F19.20; STATUS section
 * 2.213): the worker's notify stage plans what each person is owed and sends
 * it, and the relay loop carries what a relay was given. Each step is taken
 * here as the worker and the loop take it, at a time the test chooses.
 */
import { withControlPlane } from '../../src/db/tenant.ts';
import type { OwnerChannel } from '../../src/owner/notify.ts';
import { dispatchPeopleNotices, planNotices, type NoticeTarget } from '../../src/owner/member-notify.ts';
import { retractRemoved } from '../../src/relay/people.ts';
import type { MasterKey } from '../../src/settings/store.ts';
import type { FakeRelay, Received } from './fake-relay.ts';
import { sendOutbox, type Linked } from './relay.ts';

/** Where a notice opens, as a deployment with a public address makes it. */
export function linkFor(target: NoticeTarget): string {
  const link = new URL('https://palugada.example/');
  link.searchParams.set('company', target.companyId);
  if (target.roomId) link.searchParams.set('room', target.roomId);
  if (target.threadOf) link.searchParams.set('thread', target.threadOf);
  if (target.position) link.searchParams.set('at', String(target.position));
  if (target.itemId) link.searchParams.set('item', target.itemId);
  if (target.taskId) link.searchParams.set('task', target.taskId);
  return link.toString();
}

/** What the worker's notify stage does for people, then one pass of the relay loop. */
export async function tell(
  companyId: string,
  master: MasterKey,
  options: { now?: Date; chats?: readonly OwnerChannel[]; send?: boolean } = {},
): Promise<{ planned: number; sent: number }> {
  const now = options.now ?? new Date();
  await retractRemoved(companyId, now);
  const planned = await planNotices(companyId, { now, ...(options.chats ? { chats: options.chats } : {}) });
  const told = await dispatchPeopleNotices(companyId, { now, linkFor, ...(options.chats ? { chats: options.chats } : {}) });
  if (options.send !== false) await sendOutbox(master, now);
  return { planned: planned.planned, sent: told.sent };
}

/** What a relay was told about one person: their notices, not the link's confirmation. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toldTo(relay: FakeRelay, linked: Linked): any[] {
  return relay.received
    .filter((one: Received) => one.envelope?.to?.recipient === linked.recipient && one.envelope.type !== 'link_confirmed')
    .map((one: Received) => one.envelope);
}

export interface NoticeRow {
  id: string;
  principal: string;
  room_id: string | null;
  reason: string;
  subject: string;
  count: number;
  channel: string;
  settled_as: string | null;
  delivered_at: Date | null;
  notify_after: Date;
  attempts: number;
  created_at: Date;
}

/** The notices kept for one person, oldest first, read on the control plane. */
export async function noticesOf(companyId: string, principal: string): Promise<NoticeRow[]> {
  return withControlPlane(async (tx) => (await tx.query<NoticeRow>(
    `SELECT id, principal, room_id, reason, subject, count, channel, settled_as, delivered_at, notify_after, attempts, created_at
       FROM people_notices WHERE company_id = $1 AND principal = $2 ORDER BY created_at, id`,
    [companyId, principal])).rows);
}
