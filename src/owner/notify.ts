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
import { buildDailyDigest, renderDailyDigest } from '../reporting/digest.ts';

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
  /**
   * F10.6's daily digest, as text, once a day.
   *
   * Optional and separate from `deliver`, because a digest is not an item: it
   * has no id, nothing decides it, and F10.5's "push only for an incident or a
   * tier 3 approval" is about interrupting a person -- a digest is the
   * opposite, a thing they read when they choose to. A channel that has no
   * sensible place for one simply does not implement this.
   *
   * `renderDailyDigest` produced the text and nothing sent it, which is how
   * F10.6 came to be half-built: the console draws the digest, and the owner
   * who is not looking at the console never sees it.
   */
  deliverDigest?(digest: { companyId: string; day: string; text: string }): Promise<void>;
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

/**
 * F10.6's daily digest, to every channel that takes one.
 *
 * Once per company per day, and the record is the same table the item
 * deliveries use -- keyed on a synthetic id built from the day, so a worker
 * that restarts twice in an afternoon does not send three digests. The
 * uniqueness constraint is what enforces it rather than a read-then-write.
 *
 * A channel with no `deliverDigest` is skipped rather than failed: a transport
 * that has no sensible place for a page of text is not broken, it simply is
 * not where a digest goes.
 */
/**
 * Which channels have not had a given day's digest yet.
 *
 * Asked before the digest is built, because building one is several aggregates
 * over a day of events and the answer is thrown away on a uniqueness conflict.
 * A worker ticking every few seconds would otherwise run those aggregates all
 * day for one message.
 *
 * This is a read, so it races: two workers can both see a channel as owed. The
 * insert in `dispatchDigest` is what actually decides, and it is the
 * uniqueness constraint that makes "once a day" true. This only avoids the
 * work when the answer is already settled.
 */
export async function digestOwed(
  companyId: string,
  channels: readonly OwnerChannel[],
  day: string,
): Promise<OwnerChannel[]> {
  const already = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ channel: string }>(
      'SELECT channel FROM owner_notifications WHERE digest_day = $1',
      [day],
    );
    return new Set(rows.map((row) => row.channel));
  });
  return channels.filter((channel) => !already.has(channel.name));
}

export async function dispatchDigest(
  companyId: string,
  channels: readonly OwnerChannel[],
  digest: { day: string; text: string },
): Promise<{
  delivered: number;
  skipped: number;
  failed: Array<{ channel: string; error: string }>;
}> {
  let delivered = 0;
  let skipped = 0;
  const failed: Array<{ channel: string; error: string }> = [];

  for (const channel of channels) {
    if (!channel.deliverDigest) {
      skipped += 1;
      continue;
    }

    // Claimed first, like every other delivery here: a crash between the send
    // and the record would send the digest twice, and once a day is the whole
    // promise. `inbox_item_id` is null for a digest -- it is not an item --
    // so the day is what makes the row unique.
    const claimed = await withTenant(companyId, async (tx) => {
      const { rowCount } = await tx.query(
        `INSERT INTO owner_notifications (company_id, inbox_item_id, channel, delivery, digest_day)
         VALUES ($1, NULL, $2, 'link_only', $3)
         ON CONFLICT (company_id, channel, digest_day) WHERE digest_day IS NOT NULL
           DO NOTHING`,
        [companyId, channel.name, digest.day],
      );
      return (rowCount ?? 0) === 1;
    });
    if (!claimed) {
      skipped += 1;
      continue;
    }

    try {
      // Redacted like everything else that leaves this process. A digest is
      // assembled from what agents did, and an agent can put anything in a
      // title.
      await channel.deliverDigest({
        companyId,
        day: digest.day,
        text: redactor.redact(digest.text),
      });
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE owner_notifications SET delivered_at = now()
            WHERE company_id = $1 AND channel = $2 AND digest_day = $3`,
          [companyId, channel.name, digest.day],
        );
      });
      delivered += 1;
    } catch (error) {
      // Two things, and both were wrong without this. The claim is *released*,
      // because `retryFailed` joins `inbox_items` and can never see a digest
      // row -- so a claim left behind would lose that day permanently for one
      // transient failure. And the loop continues, because one unreachable
      // transport must not stop the owner's other channel from getting the
      // digest, on this tick or any other.
      // The failure is *recorded* rather than the claim removed. `DELETE` is
      // not the tenant role's to make -- correctly, since a log of what the
      // owner was told is not something the console's own role should be able
      // to erase -- so the row stays and carries the reason, exactly as an
      // item delivery does. `retryDigests` is what comes back to it.
      //
      // The loop continues either way: one unreachable transport must not stop
      // the owner's other channel from getting the digest.
      const reason = redactor.redact((error as Error).message).slice(0, 500);
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE owner_notifications
              SET attempts = attempts + 1, last_error = $4, last_attempt_at = now()
            WHERE company_id = $1 AND channel = $2 AND digest_day = $3`,
          [companyId, channel.name, digest.day, reason],
        );
      });
      failed.push({ channel: channel.name, error: reason });
    }
  }

  return { delivered, skipped, failed };
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

    // Only the transport is inside the `try`, and the boundary is load-bearing.
    // A wider one would catch a failure in `settle` or `appendEvent` -- which
    // happen *after* the message has gone -- and run the failure path, which
    // clears `delivered_at`. `retryFailed` in the same tick would then send it
    // again. A database hiccup after a successful send would have produced the
    // exact duplicate this module exists to prevent.
    let result: DeliveryResult;
    try {
      result = await channel.deliver(withLink);
    } catch (error) {
      // Redacted on the way in, not on the way out. A transport's error
      // message is where a bearer token appears -- a 401 body quoting the
      // Authorization header is the usual way -- and this column is read by an
      // owner console.
      await settle(companyId, item.id, channel.name, {
        error: redactor.redact(String((error as Error).message ?? error)).slice(0, 500),
      });
      report.failed += 1;
      continue;
    }

    await recordDelivery(companyId, item, channel.name, result);
    report.delivered += 1;
  }

  return report;
}

/**
 * Marks a message as sent, and says so on the timeline.
 *
 * Shared by the first attempt and the retry, because a notification that
 * reached the owner on the second try reached the owner: a `dispatch` that
 * wrote the event and a `retryFailed` that did not would have left the audit
 * log claiming that every delivery which needed a retry never happened.
 */
async function recordDelivery(
  companyId: string,
  item: NotifiableItem,
  channel: string,
  result: DeliveryResult,
): Promise<void> {
  await settle(companyId, item.id, channel, { ref: result.ref ?? null });
  await withTenant(companyId, async (tx) => {
    await appendEvent(tx, {
      companyId,
      type: 'owner.notified',
      actor: 'system',
      payload: {
        inboxItemId: item.id,
        channel,
        delivery: item.delivery,
        kind: item.kind,
      },
    });
  });
}

/**
 * How long to wait before the first retry. Doubles with each attempt.
 *
 * Thirty seconds because the thing being waited for is usually a process
 * restarting behind a load balancer, and a retry that arrives before it has
 * finished is an attempt spent on a certainty.
 */
export const RETRY_BASE_MS = 30_000;

/**
 * Retries what failed.
 *
 * Separate from `dispatch` because the two have opposite risks. A first
 * attempt must not repeat; a retry must, and only for rows that were claimed
 * and never completed. `attempts` bounds it: a channel that is simply
 * misconfigured should stop being called rather than turn into a permanent
 * source of failed rows.
 *
 * **And it waits.** The worker runs `dispatch` and then `retryFailed` in the
 * same tick, so without a delay two of the three attempts are spent
 * milliseconds apart and the third a few seconds later -- a relay restarting,
 * which is the ordinary case rather than the exotic one, would exhaust the row
 * before it came back and the owner would simply never be told. The wait
 * doubles: 30s, then a minute, then two.
 *
 * **And it only retries a recorded failure.** A row with no `delivered_at` and
 * no `last_error` is one whose outcome was never learned: the send went out
 * and the write that was supposed to record it did not come back. That is a
 * real state -- the database can fail between two statements -- and the choice
 * it forces is between possibly sending twice and possibly not sending. For a
 * notification the second is right: waking someone twice for one incident is
 * how a platform teaches its owner to ignore it, and the item is still open in
 * the inbox either way.
 */
/**
 * Comes back to a digest whose channel was unreachable.
 *
 * `retryFailed` inner-joins `inbox_items`, so a digest row is invisible to it:
 * a digest is not an item and has no row there. Without this a transport that
 * was restarting when the digest went out lost that day for ever -- the claim
 * stops it being sent again and nothing else ever looks at it.
 *
 * The same backoff and the same attempt budget, for the same reason: a first
 * attempt must not repeat while a retry must, and a relay that comes back in a
 * minute should not have exhausted the row in milliseconds.
 */
export async function retryDigests(
  companyId: string,
  channels: readonly OwnerChannel[],
  options: { maxAttempts?: number; baseDelayMs?: number; now?: Date } = {},
): Promise<{ delivered: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_MS;
  const byName = new Map(channels.map((channel) => [channel.name, channel]));
  let delivered = 0;

  const due = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{ channel: string; digest_day: string }>(
      `SELECT channel, to_char(digest_day, 'YYYY-MM-DD') AS digest_day
         FROM owner_notifications
        WHERE company_id = $1
          AND digest_day IS NOT NULL
          AND delivered_at IS NULL
          AND last_error IS NOT NULL
          AND attempts < $2
          AND last_attempt_at
              <= now() - make_interval(secs => ($3::double precision / 1000)
                                               * power(2, attempts))
        ORDER BY digest_day`,
      [companyId, maxAttempts, baseDelayMs],
    );
    return rows;
  });

  for (const row of due) {
    const channel = byName.get(row.channel);
    // A channel the deployment no longer has is not a failure to record
    // against: there is nothing to send it to.
    if (!channel?.deliverDigest) continue;

    const digest = await buildDailyDigest(companyId, new Date(`${row.digest_day}T12:00:00Z`));
    try {
      await channel.deliverDigest({
        companyId,
        day: row.digest_day,
        text: redactor.redact(renderDailyDigest(digest)),
      });
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE owner_notifications SET delivered_at = now(), last_error = NULL
            WHERE company_id = $1 AND channel = $2 AND digest_day = $3`,
          [companyId, row.channel, row.digest_day],
        );
      });
      delivered += 1;
    } catch (error) {
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE owner_notifications
              SET attempts = attempts + 1, last_error = $4, last_attempt_at = now()
            WHERE company_id = $1 AND channel = $2 AND digest_day = $3`,
          [
            companyId, row.channel, row.digest_day,
            redactor.redact((error as Error).message).slice(0, 500),
          ],
        );
      });
    }
  }

  return { delivered };
}

export async function retryFailed(
  companyId: string,
  channel: OwnerChannel,
  options: {
    maxAttempts?: number;
    linkFor?: DispatchOptions['linkFor'];
    baseDelayMs?: number;
    now?: Date;
  } = {},
): Promise<DispatchReport> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_MS;
  const now = options.now ?? new Date();
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
          -- Only rows that recorded a failure. A row with neither a delivery
          -- nor an error is one that was claimed and whose outcome was never
          -- learned -- the send went out and the bookkeeping did not come
          -- back. Re-sending that would ring the owner's phone twice for one
          -- incident, and between "possibly sent twice" and "possibly not
          -- sent" a notification should choose the second: the item is still
          -- open, still in the inbox, and the next thing raised will carry the
          -- news anyway.
          AND n.last_error IS NOT NULL
          AND n.attempts < $3
          -- The backoff. Computed in SQL rather than in TypeScript so the
          -- filter and the ordering agree, and so two workers sweeping the
          -- same company cannot disagree about which rows are due.
          AND n.last_attempt_at
              <= $4::timestamptz - make_interval(secs => $5 * power(2, n.attempts - 1))
          -- An item the owner has already dealt with does not need chasing.
          AND i.status = 'open'
        ORDER BY n.created_at`,
      [companyId, channel.name, maxAttempts, now, baseDelayMs / 1000],
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

    // Claimed before the send, and only if it is still due: two workers
    // sweeping the same company would otherwise both find the row ready and
    // both send it. The condition repeats the one in the SELECT because the
    // read and the write are separate statements, and the gap between them is
    // exactly where the other worker is.
    const claimed = await withTenant(companyId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE owner_notifications
            SET attempts = attempts + 1, last_attempt_at = $3
          WHERE inbox_item_id = $1 AND channel = $2
            AND delivered_at IS NULL
            AND last_attempt_at
                <= $3::timestamptz - make_interval(secs => $4 * power(2, attempts - 1))`,
        [row.id, channel.name, now, baseDelayMs / 1000],
      );
      return (rowCount ?? 0) === 1;
    });
    if (!claimed) {
      report.skipped += 1;
      continue;
    }

    let result: DeliveryResult;
    try {
      result = await channel.deliver(item);
    } catch (error) {
      await settle(companyId, row.id, channel.name, {
        error: redactor.redact(String((error as Error).message ?? error)).slice(0, 500),
      });
      report.failed += 1;
      continue;
    }

    // The same recorder `dispatch` uses. A delivery that needed a retry is
    // still a delivery, and an audit log that only recorded the first-time
    // ones would be quietly wrong about every flaky night.
    await recordDelivery(companyId, item, channel.name, result);
    report.delivered += 1;
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
         (company_id, inbox_item_id, channel, delivery, attempts, last_attempt_at)
       VALUES ($1, $2, $3, $4, 1, now())
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
