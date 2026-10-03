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
import { say } from './say.ts';
import type { PalugadaError } from '../errors.ts';
import { withTenant } from '../db/tenant.ts';
import { appendEvent } from '../audit/event-log.ts';
import { redactor } from '../secrets/manager.ts';
import { channelDelivery, type ChannelDelivery, type Decision } from '../inbox/inbox.ts';
import { buildDailyDigest } from '../reporting/digest.ts';
import { renderDailyDigest } from './digest-said.ts';
import { haltSaid } from './halt-said.ts';
import { notifyAfterFor } from '../scheduler/windows.ts';

/** One item, as a transport needs to see it. */
/**
 * Where a notification about an item takes the owner: the console, opened on
 * that company and that item.
 *
 * The console reads both from the query. The link used to be `/i/<id>`, a
 * path nothing served, so every notification's "open" went to a 404.
 */
export function consoleLinkFor(
  publicUrl: string,
  item: Pick<NotifiableItem, 'id' | 'companyId'>,
): string {
  const link = new URL(publicUrl);
  link.searchParams.set('company', item.companyId);
  link.searchParams.set('item', item.id);
  return link.toString();
}

/** The same, for a task: the console opens it in the company's work (0059). */
export function consoleTaskLinkFor(publicUrl: string, task: { companyId: string; taskId: string }): string {
  const link = new URL(publicUrl);
  link.searchParams.set('company', task.companyId);
  link.searchParams.set('task', task.taskId);
  return link.toString();
}

/**
 * What a channel shows under an item's title. An item whose summary only
 * repeats its title -- a budget alert says what happened in its title and
 * what to do in its rationale -- is carried with the rationale instead, or
 * the owner's phone would show the title twice and never say what to do.
 */
const CHANNEL_SUMMARY = "CASE WHEN i.kind = 'budget_alert' AND i.rationale <> '' THEN i.rationale ELSE i.action_summary END";

/**
 * Who asks a run's question (`owner.ask`), by the name the owner gave the
 * role, for a heading in the owner's language. The title said "bookkeeper
 * asks: ...", the role's short name and English whatever the owner reads
 * (the analysis of 3 October, §2.3 item 7). Null for anything else.
 */
export function askerOf(item: string): string {
  return `CASE WHEN ${item}.payload->>'askedBy' = 'agent' THEN (
            SELECT coalesce(r.display_name, r.slug) FROM tasks t JOIN roles r ON r.id = t.role_id
             WHERE t.id = ${item}.task_id) END`;
}

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
  /** The owner's language, for what the platform itself says (src/owner/say.ts). English when unset. */
  language?: string;
  /** A question a run asked with `owner.ask`: the owner answers it rather than approving it. */
  question?: string | null;
  /** Who asked it, by name (`askerOf`). */
  asker?: string | null;
  /** The answers it offered to choose from, if any. */
  options?: string[] | null;
  /** When silence refuses it, for an item that waits only so long. */
  expiresAt?: Date | null;
}

export interface DeliveryResult {
  /** The transport's own id for the message, kept so it can be found again. */
  ref?: string;
}

/**
 * An item that is no longer open, as a transport needs to see it to say so.
 *
 * `decided` carries the owner's decision; `expired` and `withdrawn` carry no
 * decision because nobody made one -- `closedReason` says what happened
 * instead (`task_cancelled`, for an approval whose task ended some other way).
 */
export interface ClosedItem {
  id: string;
  companyId: string;
  kind: string;
  title: string;
  status: 'decided' | 'expired' | 'withdrawn';
  decision: string | null;
  closedReason: string | null;
  /** As for `NotifiableItem`. */
  language?: string;
}

/**
 * What became of the message.
 *
 * `gone` is not a failure: the owner deleted the message, or the transport
 * never gave it an id, and in both cases there is nothing left that could be
 * pressed. It is recorded exactly like success so it is not asked again.
 */
export type RetractOutcome = 'retracted' | 'gone';

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
  /**
   * Rewrites a delivered message once its item has closed.
   *
   * Optional, because only a channel whose message can be *acted on* has
   * something dangerous left behind: a chat message with Approve and Deny on
   * it is one tap from a decision after the owner has already made one
   * elsewhere, after the item expired, after its task was cancelled. A push
   * notification has no buttons -- tapping it opens the app, which shows the
   * item closed -- so a push transport leaves this out rather than sending a
   * second notification to say the first one is over.
   */
  retract?(closed: ClosedItem, ref: string | null): Promise<RetractOutcome>;
  /**
   * News that needs nothing from the owner: work they gave has finished
   * (0059). Optional, and a push transport leaves it out -- F10.5 keeps the
   * ringing phone for an incident and a tier 3 approval, and "your newsletter
   * is drafted" is neither. A chat is where news is read when it is read.
   */
  deliverNotice?(notice: DoneNotice): Promise<DeliveryResult>;
}

/** Work the owner gave, finished (0059), as a channel sends it. */
export interface DoneNotice {
  companyId: string;
  taskId: string;
  /** Already in the owner's language, and redacted. */
  text: string;
  /** Where the task opens in the console, when the deployment has a public address. */
  url: string | null;
  language: string;
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
      language: string | null;
      question: string | null;
      options: string[] | null;
      asker: string | null;
      expires_at: Date | null;
    }>(
      `SELECT i.id, i.kind, i.tier, i.title, ${CHANNEL_SUMMARY} AS action_summary, i.consequence_if_denied, i.expires_at,
              (SELECT console_language FROM platform_control) AS language,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->>'question' END AS question,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->'options' END AS options,
              ${askerOf('i')} AS asker
         FROM inbox_items i
    LEFT JOIN owner_notifications n
           ON n.inbox_item_id = i.id AND n.channel = $2 AND n.company_id = $1
        WHERE i.status = 'open'
          AND i.notify_after <= $3
          -- Put off by the owner (0060): not sent until then.
          AND (i.snoozed_until IS NULL OR i.snoozed_until <= $3)
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
        language: row.language ?? 'en',
        question: row.question,
        asker: row.asker,
        options: row.options,
        expiresAt: row.expires_at,
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

/** How long after it ended a task is still news. A worker down longer than this does not flood the chat. */
const NOTICE_LOOKBACK_MS = 24 * 60 * 60_000;
/** The most notices one channel sends in a tick; the rest go on the next. */
const NOTICE_BATCH = 20;
/** How long a notice that failed waits before it is tried again, and how many times. */
const NOTICE_RETRY_MS = 5 * 60_000;
const NOTICE_ATTEMPTS = 3;

/**
 * Tells the owner that work they gave has finished (0059).
 *
 * Only work the owner gave -- a root task they assigned -- because that is
 * the work they are waiting for; a schedule's routine run and a step an agent
 * delegated are not news, and a chat that reported every one would be muted
 * by the end of the first day. Completed, failed or halted; not cancelled,
 * since the owner cancelled it. In the owner's window, as everything that is
 * not an emergency waits for it (F9.3). Once per channel, by the same
 * claim-first row every other notification keeps, and a notice whose send
 * failed is tried again a few minutes later, a few times.
 */
export async function dispatchDoneNotices(
  companyId: string,
  channels: readonly OwnerChannel[],
  options: { now?: Date; linkFor?: (task: { companyId: string; taskId: string }) => string | null } = {},
): Promise<{ delivered: number }> {
  const now = options.now ?? new Date();
  const takers = channels.filter((channel) => channel.deliverNotice);
  if (takers.length === 0) return { delivered: 0 };
  if ((await notifyAfterFor('notice', { now })) > now) return { delivered: 0 };

  let delivered = 0;
  for (const channel of takers) {
    const due = await withTenant(companyId, async (tx) => (await tx.query<{
      id: string; status: 'completed' | 'failed' | 'halted'; goal: string | null; summary: string | null;
      halt_reason: string | null; not_done: string | null; role: string; language: string | null;
    }>(
      `SELECT t.id, t.status, t.input->>'goal' AS goal, t.output->>'summary' AS summary, t.halt_reason,
              CASE WHEN jsonb_typeof(t.output->'notDone') = 'string' THEN t.output->>'notDone'
                   ELSE t.output->>'summary' END AS not_done,
              r.slug AS role, (SELECT console_language FROM platform_control) AS language
         FROM tasks t JOIN roles r ON r.id = t.role_id
        WHERE t.created_by = 'owner' AND t.parent_task_id IS NULL
          AND t.status IN ('completed', 'failed', 'halted')
          AND t.finished_at > $1 AND t.finished_at <= $2
          AND NOT EXISTS (
            SELECT 1 FROM owner_notifications n
             WHERE n.task_id = t.id AND n.channel = $3
               AND (n.delivered_at IS NOT NULL OR n.attempts >= $4
                    OR n.last_attempt_at > $2::timestamptz - make_interval(secs => $5)))
        ORDER BY t.finished_at
        LIMIT $6`,
      [new Date(now.getTime() - NOTICE_LOOKBACK_MS), now, channel.name, NOTICE_ATTEMPTS, NOTICE_RETRY_MS / 1000, NOTICE_BATCH],
    )).rows);

    for (const task of due) {
      // Claimed before the send: a crash in between loses a notice rather
      // than sending it twice. A retry re-claims only a row that is due.
      const claimed = await withTenant(companyId, async (tx) => (await tx.query(
        `INSERT INTO owner_notifications (company_id, task_id, channel, delivery, last_attempt_at)
         VALUES ($1, $2, $3, 'link_only', $4)
         ON CONFLICT (company_id, channel, task_id) WHERE task_id IS NOT NULL
         DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at
          WHERE owner_notifications.delivered_at IS NULL AND owner_notifications.attempts < $5
            AND owner_notifications.last_attempt_at <= $4::timestamptz - make_interval(secs => $6)
         RETURNING id`,
        [companyId, task.id, channel.name, now, NOTICE_ATTEMPTS, NOTICE_RETRY_MS / 1000],
      )).rowCount === 1);
      if (!claimed) continue;

      const language = task.language ?? 'en';
      const goal = (task.goal ?? say(language, 'a task')).slice(0, 200);
      // Work its run said it did not do (N9) is not "stopped": it ended, and
      // the run's own reason is the news.
      const notDone = task.status === 'failed' && task.halt_reason === 'not_done';
      const headline = task.status === 'completed'
        ? say(language, 'Done: {goal}', { goal })
        : notDone
          ? say(language, 'Not done: {goal}', { goal })
          : say(language, 'Stopped before finishing: {goal}', { goal });
      const detail = task.status === 'completed'
        ? (task.summary ?? '').slice(0, 500)
        : notDone
          ? (task.not_done ?? '').slice(0, 500)
          // Why, as the task says it in the console: the halt's code read
          // aloud ("budget exhausted") was English in every language.
          : say(language, 'Why: {reason}', { reason: haltSaid(language, task.halt_reason) });
      const text = redactor.redact([headline, detail, `— ${task.role}`].filter(Boolean).join('\n'));
      try {
        const sent = await channel.deliverNotice!({
          companyId, taskId: task.id, text, language,
          url: options.linkFor?.({ companyId, taskId: task.id }) ?? null,
        });
        await withTenant(companyId, (tx) => tx.query(
          `UPDATE owner_notifications SET delivered_at = now(), external_ref = $4, attempts = attempts + 1
            WHERE company_id = $1 AND channel = $2 AND task_id = $3`,
          [companyId, channel.name, task.id, sent.ref ?? null],
        ));
        delivered += 1;
      } catch (error) {
        await withTenant(companyId, (tx) => tx.query(
          `UPDATE owner_notifications SET attempts = attempts + 1, last_error = $4
            WHERE company_id = $1 AND channel = $2 AND task_id = $3`,
          [companyId, channel.name, task.id, redactor.redact((error as Error).message).slice(0, 500)],
        ));
      }
    }
  }
  return { delivered };
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
    const { rows } = await tx.query<{ channel: string; digest_day: string; language: string | null }>(
      `SELECT channel, to_char(digest_day, 'YYYY-MM-DD') AS digest_day,
              (SELECT console_language FROM platform_control) AS language
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
        text: redactor.redact(renderDailyDigest(digest, row.language)),
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
      language: string | null; question: string | null; options: string[] | null; asker: string | null;
      expires_at: Date | null;
    }>(
      `SELECT i.id, i.kind, i.tier, i.title, ${CHANNEL_SUMMARY} AS action_summary, i.consequence_if_denied, i.expires_at,
              n.delivery, (SELECT console_language FROM platform_control) AS language,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->>'question' END AS question,
              CASE WHEN i.payload->>'askedBy' = 'agent' THEN i.payload->'options' END AS options,
              ${askerOf('i')} AS asker
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
      language: row.language ?? 'en',
      question: row.question,
      asker: row.asker,
      options: row.options,
      expiresAt: row.expires_at,
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
 * Rewrites every delivered message whose item has closed (migration 0036).
 *
 * The delivery record already kept `external_ref` "so a later edit or deletion
 * can find it", and nothing ever edited: a chat message kept its buttons after
 * the owner decided in the console, after the item expired, after its task was
 * cancelled. Slack's best-known human-in-the-loop defect is exactly this -- a
 * stale Approve button on a message nobody updated -- and the fix is the same
 * shape as the send: find what is owed, claim it, call the transport, record
 * the outcome.
 *
 * `last_attempt_at` is reused for the backoff because the send retry never
 * reads it again once a row is delivered, and this sweep only reads delivered
 * rows: the two filters are disjoint, so the column has one meaning at a time.
 */
export async function retractClosed(
  companyId: string,
  channel: OwnerChannel,
  options: { maxAttempts?: number; baseDelayMs?: number; now?: Date } = {},
): Promise<{ retracted: number; failed: number }> {
  const report = { retracted: 0, failed: 0 };
  if (!channel.retract) return report;
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? RETRY_BASE_MS;
  const now = options.now ?? new Date();

  const owed = await withTenant(companyId, async (tx) => {
    const { rows } = await tx.query<{
      id: string; kind: string; title: string; status: ClosedItem['status'];
      decision: string | null; closed_reason: string | null;
      external_ref: string | null; retract_attempts: number; language: string | null;
    }>(
      `SELECT i.id, i.kind, i.title, i.status, i.decision, i.closed_reason,
              n.external_ref, n.retract_attempts,
              (SELECT console_language FROM platform_control) AS language
         FROM owner_notifications n
         JOIN inbox_items i ON i.id = n.inbox_item_id
        WHERE n.company_id = $1
          AND n.channel = $2
          AND n.delivered_at IS NOT NULL
          AND n.retracted_at IS NULL
          AND n.retract_attempts < $3
          AND i.status <> 'open'
          AND (n.retract_attempts = 0
               OR n.last_attempt_at
                  <= $4::timestamptz - make_interval(secs => $5 * power(2, n.retract_attempts - 1)))
        ORDER BY n.created_at`,
      [companyId, channel.name, maxAttempts, now, baseDelayMs / 1000],
    );
    return rows;
  });

  for (const row of owed) {
    // Claimed on the attempt count that was read, so two workers sweeping the
    // same company cannot both edit one message: the second finds the count
    // already moved and walks away.
    const claimed = await withTenant(companyId, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE owner_notifications
            SET retract_attempts = retract_attempts + 1, last_attempt_at = $4
          WHERE inbox_item_id = $1 AND channel = $2
            AND retracted_at IS NULL AND retract_attempts = $3`,
        [row.id, channel.name, row.retract_attempts, now],
      );
      return (rowCount ?? 0) === 1;
    });
    if (!claimed) continue;

    const closed: ClosedItem = {
      id: row.id,
      companyId,
      kind: row.kind,
      title: row.title,
      status: row.status,
      decision: row.decision,
      closedReason: row.closed_reason,
      language: row.language ?? 'en',
    };
    try {
      await channel.retract(closed, row.external_ref);
    } catch (error) {
      await withTenant(companyId, async (tx) => {
        await tx.query(
          `UPDATE owner_notifications SET retract_error = $3
            WHERE inbox_item_id = $1 AND channel = $2`,
          [row.id, channel.name,
           redactor.redact(String((error as Error).message ?? error)).slice(0, 500)],
        );
      });
      report.failed += 1;
      continue;
    }
    await withTenant(companyId, async (tx) => {
      await tx.query(
        `UPDATE owner_notifications SET retracted_at = now(), retract_error = NULL
          WHERE inbox_item_id = $1 AND channel = $2`,
        [row.id, channel.name],
      );
    });
    report.retracted += 1;
  }
  return report;
}

/**
 * What is known about an item a press found closed: its status (null when
 * there is no such item), how it was decided, and why it was withdrawn.
 */
export interface ClosedState {
  status: string | null;
  decision: string | null;
  closedReason: string | null;
  language?: string | null | undefined;
}

/**
 * What a closed item says in place of its buttons.
 *
 * Shared by every transport that implements `retract`, and by every press or
 * reply that finds its item already closed, so "why is this greyed out" has
 * one answer however the owner reads it. Each reason is a sentence of its
 * own: a code filled into one sentence -- "Withdrawn (stage_changed)." --
 * stays English inside every translation of it, and a reason nothing writes
 * yet is said without its code rather than with it.
 */
export function closureText(closed: ClosedItem | ClosedState): string {
  const language = closed.language;
  if (closed.status === 'decided') {
    if (closed.decision === 'approve') return say(language, 'Approved. Nothing left to press here.');
    if (closed.decision === 'deny') return say(language, 'Denied. Nothing left to press here.');
    if (closed.decision === 'ask') return say(language, 'Asked. Nothing left to press here.');
    return say(language, 'Decided. Nothing left to press here.');
  }
  // Still open but past its expiry is how a refusal finds an item the expiry
  // sweep has not reached yet: to the owner it has expired.
  if (closed.status === 'expired' || closed.status === 'open') {
    return say(language, 'Expired unanswered. Silence is a refusal, so nothing was done.');
  }
  if (closed.status === null) return say(language, 'That item no longer exists.');
  switch (closed.closedReason) {
    case 'task_completed': return say(language, 'Withdrawn: the task it was asking about has finished.');
    case 'task_failed': return say(language, 'Withdrawn: the task it was asking about has failed.');
    case 'task_halted': return say(language, 'Withdrawn: the task it was asking about was stopped.');
    case 'task_cancelled': return say(language, 'Withdrawn: the task it was asking about was cancelled.');
    case 'task_continued': return say(language, 'Withdrawn: you continued the task it was about.');
    case 'superseded': return say(language, 'Withdrawn: the agent changed what it proposes and asked again about the new one.');
    case 'stage_changed': return say(language, 'Withdrawn: the company is no longer at the stage this proposal would move it from.');
    case 'decided_elsewhere': return say(language, 'Withdrawn: it was already decided in the app.');
    default: return say(language, 'Withdrawn. Nothing left to press here.');
  }
}

/**
 * What a press or a reply is told when its item turned out to be closed,
 * from the refusal that said so (`inbox.not_open` carries the item's status,
 * decision and reason; the message is for logs and is English).
 */
export function notOpenText(language: string | null, error: PalugadaError): string {
  const details = error.details as { status?: string | null; decision?: string | null; closedReason?: string | null };
  return closureText({
    status: details.status ?? null,
    decision: details.decision ?? null,
    closedReason: details.closedReason ?? null,
    language,
  });
}

/**
 * What a chat says once the owner's press is recorded: the decision as a
 * word of the owner's language, not the code the button carried.
 */
export function recordedText(language: string | null, decision: Decision): string {
  if (decision === 'approve') return say(language, 'Recorded: approved.');
  if (decision === 'deny') return say(language, 'Recorded: denied.');
  return say(language, 'Recorded: asked.');
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
