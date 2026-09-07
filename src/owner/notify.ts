/**
 * Getting an item in front of the owner (PRD v2 F10.5, F10.9, F10.10).
 *
 * Three requirements meet here and they answer three different questions.
 * `notify_after` answers *when* the owner may be shown something — F10.5 lets
 * an incident and a tier 3 approval through their window and makes everything
 * else wait. `channelDelivery` answers *what they may press* — F10.9 names the
 * three kinds a message channel is an action surface for, and F10.10 cuts tier
 * 3 down to a link. This module answers the third: *through which pipe*, and
 * exactly once.
 *
 * The transports are interfaces with one method, and that is deliberate. What
 * is expensive to get right is not talking HTTP to a vendor — it is the
 * decisions above it: which items are push-worthy at all, what a channel may
 * offer, and not sending the same incident every thirty seconds until the
 * owner wakes up. Those live here and are tested here; a transport is a
 * `fetch` call and a shape.
 *
 * **Exactly once is the part that would have been discovered in production.**
 * An inbox item stays open until the owner decides, so "open and past its
 * `notify_after`" is true for as long as they take to answer. A dispatcher
 * without a delivery record pushes on every tick, and the first real
 * deployment would have woken its owner every tick until they gave in. The
 * record is a row per item per channel, and the uniqueness constraint on that
 * pair is the rule rather than a nicety.
 *
 * **Two surfaces, not one.** An incident is push-worthy under F10.5 and, being
 * absent from F10.9's list of three, reaches the chat as a link with nothing
 * to press. Both are correct for the same item, so a delivery record keyed on
 * the item alone would have let whichever ran first silence the other.
 */
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { redactor } from '../secrets/manager.ts';
import { channelDelivery, type ChannelDelivery } from '../inbox/inbox.ts';

/** One item, as a transport needs to see it. */
export interface NotifiableItem {
  id: string;
  companyId: string;
  kind: string;
  tier: number | null;
  title: string;
  actionSummary: string;
  consequenceIfDenied: string | null;
  /** What the owner may do with it here (F10.9, F10.10). */
  delivery: Exclude<ChannelDelivery, 'none'>;
  /** Deep link into the owner's app, when the deployment has one. */
  url: string | null;
}

export interface DeliveryResult {
  /** The transport's own id for the message, kept so it can be found again. */
  ref?: string;
}

/**
 * A pipe to the owner.
 *
 * `name` is stored on the delivery record and must be stable across restarts:
 * it is what stops a second run from re-sending everything the first run
 * already sent. `push:webhook`, `chat:telegram`.
 */
export interface OwnerChannel {
  readonly name: string;
  /**
   * True when this channel carries this item at all.
   *
   * Separate from `deliver` so the decision can be read — and tested —
   * without a transport. F10.5's "push only for an incident or a tier 3
   * approval" is a rule about *which items*, and a rule buried inside an HTTP
   * call is a rule nobody can check.
   */
  carries(item: NotifiableItem): boolean;
  deliver(item: NotifiableItem): Promise<DeliveryResult>;
}

/**
 * F10.5, as a predicate.
 *
 * "Push hanya `incident` dan approval Tier 3" — push reaches the owner outside
 * their window, so the list of things allowed to do that is short and closed.
 * Everything else waits for the window, which `notify_after` already enforces;
 * this is the second half, and without it a budget alert at 03:00 would be a
 * ringing phone.
 */
export function isPushWorthy(item: { kind: string; tier: number | null }): boolean {
  if (item.kind === 'incident') return true;
  return item.kind === 'approval' && (item.tier ?? 0) >= 3;
}

/**
 * Reads the items a channel has not been given yet.
 *
 * The `notify_after` filter is F10.5's *when* and the anti-join is the exactly-
 * once rule. Both in one statement rather than two round trips, because a
 * dispatcher that read the list and then filtered it in memory would re-send
 * everything the moment two dispatchers ran at once.
 */
export async function undelivered(
  companyId: string,
  channel: string,
  now = new Date(),
): Promise<NotifiableItem[]> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      kind: string;
      tier: number | null;
      title: string;
      action_summary: string;
      consequence_if_denied: string | null;
    }>(
      `SELECT i.id, i.kind, i.tier, i.title, i.action_summary, i.consequence_if_denied
         FROM inbox_items i
    LEFT JOIN owner_notifications n
           ON n.inbox_item_id = i.id AND n.channel = $2 AND n.company_id = $1
        WHERE i.status = 'open'
          AND i.notify_after <= $3
          AND n.id IS NULL
        ORDER BY i.created_at`,
      [companyId, channel, now],
    );

    return rows.flatMap((row) => {
      const delivery = channelDelivery(row);
      // `none` is not a failure and not a deferral: F10.9 says this kind is
      // not something a channel carries, so there is nothing to send and
      // nothing to record. A `fact_candidate` is the case -- a fact is not a
      // procedure, and the requirement does not name it.
      if (delivery === 'none') return [];
      return [{
        id: row.id,
        companyId,
        kind: row.kind,
        tier: row.tier,
        title: row.title,
        actionSummary: row.action_summary,
        consequenceIfDenied: row.consequence_if_denied,
        delivery,
        url: null,
      }];
    });
  });
}

export interface DispatchReport {
  channel: string;
  delivered: number;
  failed: number;
  skipped: number;
}

export interface DispatchOptions {
  now?: Date;
  /** Turns an item into a link into the owner's app, when there is one. */
  linkFor?: (item: NotifiableItem) => string | null;
}

/**
 * Sends everything one channel owes the owner.
 *
 * The claim is written *before* the transport is called, not after. A crash
 * between the send and the record would otherwise re-send on the next tick,
 * and for a push that means the owner's phone rings twice for one incident;
 * claiming first means a crash can lose a notification instead, which is the
 * better failure because the item is still open and still in the inbox. The
 * row carries `delivered_at IS NULL` until the transport answers, so a claim
 * that never completed is visible rather than silently indistinguishable from
 * a success.
 */
export async function dispatch(
  companyId: string,
  channel: OwnerChannel,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const now = options.now ?? new Date();
  const report: DispatchReport = { channel: channel.name, delivered: 0, failed: 0, skipped: 0 };

  for (const item of await undelivered(companyId, channel.name, now)) {
    if (!channel.carries(item)) {
      report.skipped += 1;
      continue;
    }

    const withLink: NotifiableItem = {
      ...item,
      url: options.linkFor?.(item) ?? null,
    };

    const claimed = await claim(companyId, item.id, channel.name, item.delivery);
    // Another dispatcher got there first. Not an error and not a retry: the
    // unique constraint did exactly what it is for.
    if (!claimed) {
      report.skipped += 1;
      continue;
    }

    try {
      const result = await channel.deliver(withLink);
      await settle(companyId, item.id, channel.name, { ref: result.ref ?? null });
      await withTenant(companyId, async (tx) => {
        await appendEvent(tx, {
          companyId,
          type: 'owner.notified',
          actor: 'system',
          payload: {
            inboxItemId: item.id,
            channel: channel.name,
            delivery: item.delivery,
            kind: item.kind,
          },
        });
      });
      report.delivered += 1;
    } catch (error) {
      // Redacted on the way in, not on the way out. A transport's error
      // message is where a bearer token appears -- a 401 body quoting the
      // Authorization header is the usual way -- and this column is read by an
      // owner console.
      await settle(companyId, item.id, channel.name, {
        error: redactor.redact(String((error as Error).message ?? error)).slice(0, 500),
      });
      report.failed += 1;
    }
  }

  return report;
}

/**
 * Retries what failed.
 *
 * Separate from `dispatch` because the two have opposite risks. A first
 * attempt must not repeat; a retry must, and only for rows that were claimed
 * and never completed. `attempts` bounds it: a channel that is simply
 * misconfigured should stop being called rather than turn into a permanent
 * source of failed rows.
 */
export async function retryFailed(
  companyId: string,
  channel: OwnerChannel,
  options: { maxAttempts?: number; linkFor?: DispatchOptions['linkFor'] } = {},
): Promise<DispatchReport> {
  const maxAttempts = options.maxAttempts ?? 3;
  const report: DispatchReport = { channel: channel.name, delivered: 0, failed: 0, skipped: 0 };

  const pending = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: string; tier: number | null; title: string;
      action_summary: string; consequence_if_denied: string | null; delivery: string;
    }>(
      `SELECT i.id, i.kind, i.tier, i.title, i.action_summary, i.consequence_if_denied,
              n.delivery
         FROM owner_notifications n
         JOIN inbox_items i ON i.id = n.inbox_item_id
        WHERE n.company_id = $1
          AND n.channel = $2
          AND n.delivered_at IS NULL
          AND n.attempts < $3
          -- An item the owner has already dealt with does not need chasing.
          AND i.status = 'open'
        ORDER BY n.created_at`,
      [companyId, channel.name, maxAttempts],
    );
    return rows;
  });

  for (const row of pending) {
    const item: NotifiableItem = {
      id: row.id,
      companyId,
      kind: row.kind,
      tier: row.tier,
      title: row.title,
      actionSummary: row.action_summary,
      consequenceIfDenied: row.consequence_if_denied,
      delivery: row.delivery as Exclude<ChannelDelivery, 'none'>,
      url: null,
    };
    item.url = options.linkFor?.(item) ?? null;

    await withTenant(companyId, async (tx) => {
      await tx.query(
        `UPDATE owner_notifications SET attempts = attempts + 1
          WHERE inbox_item_id = $1 AND channel = $2`,
        [row.id, channel.name],
      );
    });

    try {
      const result = await channel.deliver(item);
      await settle(companyId, row.id, channel.name, { ref: result.ref ?? null });
      report.delivered += 1;
    } catch (error) {
      await settle(companyId, row.id, channel.name, {
        error: redactor.redact(String((error as Error).message ?? error)).slice(0, 500),
      });
      report.failed += 1;
    }
  }

  return report;
}

/**
 * Takes the item for this channel, or reports that somebody else has it.
 *
 * `ON CONFLICT DO NOTHING` rather than a read-then-write: two dispatchers on
 * the same company is the ordinary case in a deployment with more than one
 * worker, and a check followed by an insert is a race with a phone call at the
 * end of it.
 */
async function claim(
  companyId: string,
  itemId: string,
  channel: string,
  delivery: string,
): Promise<boolean> {
  return withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO owner_notifications
         (company_id, inbox_item_id, channel, delivery, attempts)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (inbox_item_id, channel) DO NOTHING
       RETURNING id`,
      [companyId, itemId, channel, delivery],
    );
    return rows.length === 1;
  });
}

async function settle(
  companyId: string,
  itemId: string,
  channel: string,
  outcome: { ref?: string | null; error?: string },
): Promise<void> {
  await withTenant(companyId, async (tx) => {
    await tx.query(
      `UPDATE owner_notifications
          SET delivered_at = CASE WHEN $4::text IS NULL THEN now() ELSE NULL END,
              external_ref = coalesce($3, external_ref),
              last_error = $4
        WHERE inbox_item_id = $1 AND channel = $2`,
      [itemId, channel, outcome.ref ?? null, outcome.error ?? null],
    );
  });
}
