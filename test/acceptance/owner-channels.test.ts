/**
 * The two surfaces that reach the owner away from their desk (PRD v2 F10.5,
 * F10.9, F10.10).
 *
 * Both requirements spent this build graded "a rule with no transport behind
 * it", which was true and turned out to be the wrong half to stop at. The
 * rules were the hard part and they were built; what was missing was the pipe,
 * and a pipe is an HTTP call. So these run against real HTTP servers on
 * loopback — a fake push relay and a fake Telegram — because everything that
 * can actually be wrong here is on the wire: the field names, the buttons, the
 * escaping, and whether the same incident is sent twice.
 *
 * The one thing not exercised is a real vendor. No push service and no bot
 * token exist in this environment, and docs/STATUS.md says so. What these
 * tests do cover is every decision the platform makes before the request
 * leaves, which is where its own defects live.
 */
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { closePools } from '../../src/db/pool.ts';
import { withTenant } from '../../src/db/tenant.ts';
import * as inbox from '../../src/inbox/inbox.ts';
import {
  dispatch,
  retryFailed,
  undelivered,
  isPushWorthy,
  RETRY_BASE_MS,
  type OwnerChannel,
} from '../../src/owner/notify.ts';
import { WebhookPush } from '../../src/owner/push.ts';
import {
  TelegramChannel,
  decodeAction,
  encodeAction,
  escapeMarkdown,
} from '../../src/owner/telegram.ts';
import { createCompany, type Fixture } from '../helpers/fixtures.ts';
import { ensureSchema, resetData, closeSetup } from '../helpers/setup.ts';

before(ensureSchema);
beforeEach(resetData);
after(async () => {
  await closePools();
  await closeSetup();
});

/* ------------------------------------------------------------- a server --- */

interface Recorded {
  path: string;
  body: Record<string, unknown>;
}

/**
 * A fake vendor.
 *
 * `reply` is a function so a test can make the third call fail without
 * restarting anything — which is what a retry test needs and what a static
 * fixture cannot give.
 */
async function fakeVendor(
  reply: (call: Recorded, index: number) => { status: number; body: unknown },
): Promise<{ url: string; calls: Recorded[]; close: () => Promise<void> }> {
  const calls: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const call: Recorded = {
        path: req.url ?? '',
        body: JSON.parse(raw || '{}') as Record<string, unknown>,
      };
      calls.push(call);
      const answer = reply(call, calls.length - 1);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function incident(fixture: Fixture, title: string): Promise<string> {
  return inbox.raiseIncident({
    companyId: fixture.companyId,
    title,
    detail: 'The gateway stopped answering.',
  });
}

async function approval(fixture: Fixture, tier: 0 | 1 | 2 | 3, summary: string): Promise<string> {
  return inbox.requestApproval({
    companyId: fixture.companyId,
    capabilityName: 'payment.send',
    tier,
    actionSummary: summary,
    rationale: 'The invoice is verified.',
    consequenceIfDenied: 'The supplier is not paid.',
  });
}

/* ---------------------------------------------------------------- F10.5 --- */

/**
 * F10.5 is a restriction, so the test is mostly about what does *not* arrive.
 *
 * Push reaches the owner outside the window they set, which is exactly why the
 * list of things allowed to use it is closed. A budget alert at 03:00 is a
 * ringing phone, and a platform that rings for everything has taught its owner
 * to ignore it when it matters.
 */
test('push carries an incident and a tier 3 approval, and nothing else (F10.5)', async () => {
  const fixture = await createCompany('push-scope');
  const vendor = await fakeVendor(() => ({ status: 200, body: { id: 'receipt-1' } }));
  try {
    await incident(fixture, 'The gateway is down');
    await approval(fixture, 3, 'Wire the payment');
    await approval(fixture, 1, 'Draft the email');
    await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier?',
      detail: 'Two match the description.',
    });

    // Dispatched past the owner's window on purpose. `notify_after` already
    // holds the escalation and the tier 1 approval back, so a dispatch at
    // `now` would pass with the push rule deleted -- it would be testing the
    // window. Past the window all four are eligible, and only two may ring.
    const push = new WebhookPush({ url: vendor.url, token: 'Bearer push-token' });
    const report = await dispatch(fixture.companyId, push, { now: tomorrow() });

    assert.equal(report.delivered, 2);
    assert.equal(report.skipped, 2, 'the other two were eligible and were not pushed');
    assert.deepEqual(
      vendor.calls.map((call) => call.body.title).sort(),
      ['Approval needed: Wire the payment', 'Incident: The gateway is down'].sort(),
    );
    // The two that were not pushed are still open and still in the inbox: not
    // pushing is not the same as not telling.
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 4);
  } finally {
    await vendor.close();
  }
});

/**
 * The defect that would have been found in production, on the first night.
 *
 * An inbox item stays open until the owner decides, so "open and past its
 * notify_after" is true for as long as they take to answer. A dispatcher with
 * no delivery record pushes on every tick — and a worker ticks every few
 * seconds.
 */
test('the same incident is not pushed twice (F10.5)', async () => {
  const fixture = await createCompany('push-once');
  const vendor = await fakeVendor(() => ({ status: 200, body: { id: 'receipt' } }));
  try {
    await incident(fixture, 'Disk is full');
    const push = new WebhookPush({ url: vendor.url });

    await dispatch(fixture.companyId, push);
    await dispatch(fixture.companyId, push);
    await dispatch(fixture.companyId, push);

    assert.equal(vendor.calls.length, 1, 'the owner is told once');
  } finally {
    await vendor.close();
  }
});

/**
 * A lock screen is not where a company's business goes.
 *
 * The push carries that something happened, how bad, and where — and the
 * substance stays behind the app, where F10.10's second factor is. Asserted
 * rather than assumed because the natural thing for a notifier to do is send
 * the whole item, and the whole item includes the rationale an agent wrote.
 */
test('a push carries an alert, not the contents of the decision (F10.5, F12.4)', async () => {
  const fixture = await createCompany('push-contents');
  const vendor = await fakeVendor(() => ({ status: 200, body: {} }));
  try {
    await approval(fixture, 3, 'Wire 40,000 to account NL91ABNA0417164300');
    const push = new WebhookPush({ url: vendor.url });
    await dispatch(fixture.companyId, push, {
      linkFor: (item) => `https://app.palugada.test/i/${item.id}`,
    });

    const sent = vendor.calls[0]!.body;
    assert.equal(sent.priority, 'normal', 'an approval is urgent, not an emergency');
    assert.match(String(sent.url), /^https:\/\/app\.palugada\.test\/i\//);
    // The rationale is the part an agent wrote and the part that would be read
    // aloud by a car. It stays behind the app.
    assert.ok(!JSON.stringify(sent).includes('The invoice is verified'));
  } finally {
    await vendor.close();
  }
});

test('an incident is pushed as an emergency and an approval is not (F10.5)', async () => {
  const fixture = await createCompany('push-priority');
  const vendor = await fakeVendor(() => ({ status: 200, body: {} }));
  try {
    await incident(fixture, 'Production is down');
    const push = new WebhookPush({ url: vendor.url });
    await dispatch(fixture.companyId, push);
    assert.equal(vendor.calls[0]!.body.priority, 'high');
  } finally {
    await vendor.close();
  }
});

/**
 * A push that failed is a push to retry; one that was never worth sending is
 * not. The distinction is the whole reason a failure is a row rather than a
 * silence.
 */
test('a push that fails is retried, and only up to a point (F10.5)', async () => {
  const fixture = await createCompany('push-retry');
  let failUntil = 2;
  const vendor = await fakeVendor((_call, index) =>
    index < failUntil
      ? { status: 503, body: { error: 'the relay is down' } }
      : { status: 200, body: { id: 'receipt' } },
  );
  try {
    await incident(fixture, 'Disk is full');
    const push = new WebhookPush({ url: vendor.url });

    const first = await dispatch(fixture.companyId, push);
    assert.equal(first.failed, 1);
    assert.equal(await lastError(fixture), 'push returned 503: {"error":"the relay is down"}');

    // Still failing. The clock is moved rather than the delay shortened,
    // because what is being tested is that the retry *waits* -- and a test
    // that set the wait to zero would be testing a configuration nothing uses.
    const second = await retryFailed(fixture.companyId, push, { now: later(1) });
    assert.equal(second.failed, 1);

    // Now it works, one doubling later.
    failUntil = 0;
    const third = await retryFailed(fixture.companyId, push, { now: later(3) });
    assert.equal(third.delivered, 1);
    assert.equal(await lastError(fixture), null);

    // A delivery that needed a retry is still a delivery, and the timeline
    // says so. An audit log that only recorded the first-time ones would be
    // quietly wrong about every flaky night.
    assert.equal(await notifiedEvents(fixture), 1);

    // And a delivered item is not chased again.
    assert.equal((await retryFailed(fixture.companyId, push, { now: later(9) })).delivered, 0);
  } finally {
    await vendor.close();
  }
});

/**
 * The wait is the point, so it is asserted directly.
 *
 * The worker runs `dispatch` and then `retryFailed` in one tick. Without a
 * delay, two of the three attempts go milliseconds apart and the third a few
 * seconds later -- so a relay restarting behind a load balancer, which is the
 * ordinary failure rather than the exotic one, would be out of attempts before
 * it came back and the owner would simply never be told.
 */
test('a retry waits, and waits longer each time (F10.5)', async () => {
  const fixture = await createCompany('push-backoff');
  const vendor = await fakeVendor(() => ({ status: 503, body: {} }));
  try {
    await incident(fixture, 'Disk is full');
    const push = new WebhookPush({ url: vendor.url });
    await dispatch(fixture.companyId, push);
    assert.equal(vendor.calls.length, 1);

    // Immediately after, and a second later: nothing.
    assert.equal((await retryFailed(fixture.companyId, push)).skipped, 0);
    assert.equal(vendor.calls.length, 1, 'a retry in the same tick is not a retry');

    // Past the first wait.
    await retryFailed(fixture.companyId, push, { now: later(1) });
    assert.equal(vendor.calls.length, 2);

    // The wait doubled, so the same interval again is too soon.
    await retryFailed(fixture.companyId, push, { now: later(2) });
    assert.equal(vendor.calls.length, 2, 'the second wait is longer than the first');

    await retryFailed(fixture.companyId, push, { now: later(3) });
    assert.equal(vendor.calls.length, 3);
  } finally {
    await vendor.close();
  }
});

test('a failing channel stops being called rather than retrying for ever (F10.5)', async () => {
  const fixture = await createCompany('push-give-up');
  const vendor = await fakeVendor(() => ({ status: 500, body: {} }));
  try {
    await incident(fixture, 'Disk is full');
    const push = new WebhookPush({ url: vendor.url });
    await dispatch(fixture.companyId, push);
    for (let round = 1; round <= 8; round += 1) {
      await retryFailed(fixture.companyId, push, { maxAttempts: 3, now: later(round * 4) });
    }
    assert.equal(vendor.calls.length, 3, 'one attempt and two retries, then it stops');
  } finally {
    await vendor.close();
  }
});

/**
 * A database hiccup after a successful send must not become a second send.
 *
 * The natural way to write the dispatch loop puts `settle` and the audit event
 * inside the same `try` as the transport, so a failure *after* the message has
 * gone runs the failure path -- which clears `delivered_at` -- and the retry in
 * the same tick sends it again. The owner's phone rings twice for one incident,
 * which is the exact thing this module exists to prevent.
 */
test('a send whose bookkeeping failed is not sent again (F10.5)', async () => {
  const fixture = await createCompany('push-after-send');
  // A receipt id with a NUL byte in it — which PostgreSQL refuses outright, so
  // the message goes out and the write that records it does not come back.
  // Not contrived: a vendor whose id passes through a broken parser produces
  // exactly this, and the two-statement gap it exposes is real whatever the
  // cause.
  const vendor = await fakeVendor(() => ({
    status: 200,
    body: { id: `re${String.fromCharCode(0)}ceipt` },
  }));
  try {
    await incident(fixture, 'Disk is full');
    const push = new WebhookPush({ url: vendor.url });

    await assert.rejects(
      () => dispatch(fixture.companyId, push),
      /invalid byte sequence/,
      'the bookkeeping failure is not swallowed as a delivery failure',
    );
    assert.equal(vendor.calls.length, 1, 'the message did go out');

    // Neither delivered nor failed: the outcome was never learned. That is the
    // state the retry must leave alone — re-sending would ring the owner's
    // phone twice for one incident, and between "possibly sent twice" and
    // "possibly not sent" a notification chooses the second.
    const row = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ delivered_at: Date | null; last_error: string | null }>(
        'SELECT delivered_at, last_error FROM owner_notifications',
      );
      return rows[0]!;
    });
    assert.equal(row.delivered_at, null);
    assert.equal(row.last_error, null);

    await retryFailed(fixture.companyId, push, { now: later(9) });
    assert.equal(vendor.calls.length, 1, 'and it is not sent a second time');
  } finally {
    await vendor.close();
  }
});

test('push worthiness is a predicate anyone can read (F10.5)', () => {
  assert.equal(isPushWorthy({ kind: 'incident', tier: null }), true);
  assert.equal(isPushWorthy({ kind: 'approval', tier: 3 }), true);
  assert.equal(isPushWorthy({ kind: 'approval', tier: 2 }), false);
  assert.equal(isPushWorthy({ kind: 'escalation', tier: 3 }), false);
  assert.equal(isPushWorthy({ kind: 'budget_alert', tier: null }), false);
});

/* --------------------------------------------------------- F10.9, F10.10 --- */

function telegram(options: { url: string; secret?: string } = { url: '' }) {
  return new TelegramChannel({
    token: 'bot-token-1234567890',
    chatId: '55555',
    apiBase: options.url,
    ...(options.secret === undefined ? {} : { webhookSecret: options.secret }),
    appUrl: (item) => `https://app.palugada.test/i/${item.id}`,
  });
}

/**
 * F10.9's whole content: an escalation arrives with buttons.
 *
 * "Balasan lewat tombol inline" is the requirement, and a chat integration
 * that delivered text the owner had to answer by opening a laptop would have
 * satisfied the notification half and missed the point.
 */
test('an escalation reaches the chat with buttons on it (F10.9)', async () => {
  const fixture = await createCompany('chat-escalation');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: { message_id: 7 } } }));
  try {
    await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier did you mean?',
      detail: 'Two match the description.',
    });

    // An escalation waits for the owner's window (F10.5), so the dispatcher is
    // asked for a moment past it. Not worked around: the deferral is the other
    // requirement working, and a test that dispatched at `now` would be
    // asserting the window rather than the channel.
    const channel = telegram({ url: vendor.url });
    const report = await dispatch(fixture.companyId, channel, { now: tomorrow() });
    assert.equal(report.delivered, 1);

    const sent = vendor.calls[0]!;
    assert.match(sent.path, /\/botbot-token-1234567890\/sendMessage$/);
    assert.equal(sent.body.chat_id, '55555');
    const keyboard = (sent.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> })
      .inline_keyboard[0]!;
    assert.deepEqual(keyboard.map((button) => button.text), ['Approve', 'Deny', 'Ask']);
    assert.ok(keyboard[0]!.callback_data!.startsWith('palugada:'));
  } finally {
    await vendor.close();
  }
});

/**
 * F10.10, on the surface it is about.
 *
 * A tier 3 approval reaches the chat because the owner should know it is
 * waiting — and it reaches it with nothing to press. The link is the whole
 * offer.
 */
test('a tier 3 approval reaches the chat as a link with nothing to press (F10.10)', async () => {
  const fixture = await createCompany('chat-tier3');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: { message_id: 9 } } }));
  try {
    await approval(fixture, 3, 'Wire the payment');
    await dispatch(fixture.companyId, telegram({ url: vendor.url }));

    const markup = vendor.calls[0]!.body.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
    };
    const buttons = markup.inline_keyboard[0]!;
    assert.equal(buttons.length, 1);
    assert.equal(buttons[0]!.callback_data, undefined, 'nothing to press');
    assert.match(buttons[0]!.url!, /^https:\/\/app\.palugada\.test\/i\//);
    assert.match(String(vendor.calls[0]!.body.text), /decided in the app/);
  } finally {
    await vendor.close();
  }
});

/**
 * A button press becomes a decision.
 *
 * The inbound half is what makes a message channel an *action* surface rather
 * than a second inbox, and it is also where a chat integration is dangerous:
 * the press arrives as an HTTP request from the internet.
 */
test('a button press from the owner records the decision (F10.9)', async () => {
  const fixture = await createCompany('chat-press');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: {} } }));
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier?',
      detail: 'Two match.',
    });
    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });

    const outcome = await channel.onCallback(
      fixture.companyId,
      {
        callback_query: {
          id: 'cb1',
          data: encodeAction({ itemId, decision: 'deny' }),
          message: { chat: { id: 55555 } },
        },
      },
      { secretHeader: 'webhook-secret' },
    );

    assert.equal(outcome.handled, true);
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await vendor.close();
  }
});

/**
 * Three things stand between the internet and a decision made on the owner's
 * behalf, and each is asserted separately: a test that only checked "a bad
 * press is rejected" would pass with two of the three deleted.
 */
test('a press is refused without the webhook secret, and from the wrong chat (F10.9)', async () => {
  const fixture = await createCompany('chat-forged');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: {} } }));
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier?',
      detail: 'Two match.',
    });
    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });
    const press = {
      callback_query: {
        id: 'cb1',
        data: encodeAction({ itemId, decision: 'approve' }),
        message: { chat: { id: 55555 } },
      },
    };

    // Not from Telegram at all.
    assert.deepEqual(
      await channel.onCallback(fixture.companyId, press, { secretHeader: 'wrong' }),
      { handled: false, reason: 'webhook_secret' },
    );
    assert.deepEqual(await channel.onCallback(fixture.companyId, press), {
      handled: false,
      reason: 'webhook_secret',
    });

    // From Telegram, from somebody who found the bot. A bot is reachable by
    // anyone who learns its name, so this is the ordinary case rather than the
    // exotic one.
    const stranger = await channel.onCallback(
      fixture.companyId,
      {
        callback_query: {
          id: 'cb2',
          data: encodeAction({ itemId, decision: 'approve' }),
          message: { chat: { id: 99999 } },
          from: { id: 99999, username: 'passer_by' },
        },
      },
      { secretHeader: 'webhook-secret' },
    );
    assert.deepEqual(stranger, { handled: false, reason: 'wrong_chat' });

    // Recorded rather than silently dropped: somebody finding the bot is worth
    // knowing about.
    const refusals = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ payload: { chatId?: string; username?: string } }>(
        "SELECT payload FROM events WHERE type = 'security.chat_stranger_refused'",
      );
      return rows;
    });
    assert.equal(refusals.length, 1);
    assert.equal(refusals[0]!.payload.username, 'passer_by');

    // And through all of it, nothing was decided.
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);
  } finally {
    await vendor.close();
  }
});

/**
 * The last line of F10.10, tested through the channel rather than around it.
 *
 * `decide` refuses tier 3 over `chat`, so a press that somehow reached one
 * gets the refusal. There is deliberately no second check inside the channel:
 * a second implementation of "not over chat" is a second thing that can be
 * wrong, and the one that matters is the one every channel meets.
 */
test('a forged tier 3 press cannot approve, even from the owner\'s chat (F10.10)', async () => {
  const fixture = await createCompany('chat-tier3-press');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: {} } }));
  try {
    const itemId = await approval(fixture, 3, 'Wire the payment');
    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });

    const outcome = await channel.onCallback(
      fixture.companyId,
      {
        callback_query: {
          id: 'cb1',
          data: encodeAction({ itemId, decision: 'approve' }),
          message: { chat: { id: 55555 } },
        },
      },
      { secretHeader: 'webhook-secret' },
    );

    assert.deepEqual(outcome, { handled: false, reason: 'approval.channel_forbidden' });
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1);

    // The owner is told why rather than left looking at a spinner.
    const answer = vendor.calls.find((call) => call.path.endsWith('answerCallbackQuery'));
    assert.match(String(answer!.body.text), /approved in the app/);
  } finally {
    await vendor.close();
  }
});

test('a callback that is not one of ours is ignored rather than an error (F10.9)', async () => {
  const fixture = await createCompany('chat-noise');
  const channel = telegram({ url: 'http://127.0.0.1:1', secret: 's' });
  for (const data of ['', 'hello', 'palugada:not-a-uuid:approve', 'palugada:x:explode']) {
    assert.equal(
      (await channel.onCallback(fixture.companyId, {
        callback_query: { id: 'c', data, message: { chat: { id: 55555 } } },
      }, { secretHeader: 's' })).reason,
      'not_a_button',
    );
  }
});

test('a button action round-trips and refuses anything else (F10.9)', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(decodeAction(encodeAction({ itemId: id, decision: 'ask' })), {
    itemId: id,
    decision: 'ask',
  });
  assert.equal(decodeAction(`palugada:${id}:destroy`), null);
  assert.equal(decodeAction(`otherbot:${id}:approve`), null);
  assert.equal(decodeAction(`palugada:${id}`), null);
});

/**
 * Telegram rejects an entire message when one reserved character in it is
 * unescaped, and an item's title is whatever an agent wrote. So an escalation
 * whose title contains a hyphen would not have rendered oddly — it would have
 * failed to *send*, and the owner would never have learned there was one.
 *
 * Asserted on the rendered message rather than through a fake parser: what has
 * to be true is that everything from the item is escaped and the formatting
 * this module adds itself is not, and a stand-in for Telegram's parser would
 * be a second implementation of it to get wrong.
 */
test('a title with markdown in it is escaped, and the formatting is not (F10.9)', () => {
  const channel = telegram({ url: 'http://127.0.0.1:1' });
  const { text } = channel.render({
    id: '11111111-2222-3333-4444-555555555555',
    companyId: 'c',
    kind: 'escalation',
    tier: null,
    title: 'Deploy v2.1 to prod-eu-west (blocked!)',
    actionSummary: 'The pipeline says [failed].',
    consequenceIfDenied: null,
    delivery: 'actionable',
    url: null,
  });

  // Every reserved character the agent wrote arrives escaped.
  assert.match(text, /Deploy v2\\\.1 to prod\\-eu\\-west \\\(blocked\\!\\\)/);
  assert.match(text, /The pipeline says \\\[failed\\]\\\./);
  // And the emphasis this module adds itself is left alone, or the title would
  // arrive with backslashes in it.
  assert.ok(text.startsWith('*Deploy'), text.slice(0, 40));
});

test('escaping covers every character MarkdownV2 reserves (F10.9)', () => {
  for (const char of '_*[]()~`>#+-=|{}.!\\') {
    assert.equal(escapeMarkdown(char), `\\${char}`, `${char} must be escaped`);
  }
  assert.equal(escapeMarkdown('plain words'), 'plain words');
});

/* ------------------------------------------------------------ both, once --- */

/**
 * An incident is push-worthy under F10.5 and, being absent from F10.9's list
 * of three, reaches the chat as a link. Both are correct for the same item, so
 * a delivery record keyed on the item alone would have let whichever ran first
 * silence the other.
 */
test('one item can reach two surfaces without either suppressing the other', async () => {
  const fixture = await createCompany('two-surfaces');
  const pushVendor = await fakeVendor(() => ({ status: 200, body: {} }));
  const chatVendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: {} } }));
  try {
    await incident(fixture, 'Production is down');
    await dispatch(fixture.companyId, new WebhookPush({ url: pushVendor.url }));
    await dispatch(fixture.companyId, telegram({ url: chatVendor.url }));

    assert.equal(pushVendor.calls.length, 1);
    assert.equal(chatVendor.calls.length, 1);
    // And neither repeats on the next tick.
    await dispatch(fixture.companyId, new WebhookPush({ url: pushVendor.url }));
    await dispatch(fixture.companyId, telegram({ url: chatVendor.url }));
    assert.equal(pushVendor.calls.length, 1);
    assert.equal(chatVendor.calls.length, 1);
  } finally {
    await pushVendor.close();
    await chatVendor.close();
  }
});

/**
 * A kind no channel carries is not a deferral.
 *
 * `channelDelivery` answers `none` for a `fact_candidate` — a fact is not a
 * procedure and F10.9 does not name it — and an item that is never going to be
 * sent should not sit in the undelivered list for ever looking like a backlog.
 */
test('an item no channel carries is not queued for one (F10.9)', async () => {
  const fixture = await createCompany('chat-uncarried');
  await inbox.raiseBudgetAlert({
    companyId: fixture.companyId,
    title: 'Ops has spent 80% of its month',
    detail: 'At the current rate it runs out on the 24th.',
  });

  // `budget_alert` is real, open, and past its window -- and F10.9 does not
  // name it, so `channelDelivery` answers `none` and no chat carries it. It
  // must not sit in the undelivered list looking like a backlog for ever.
  const waiting = await undelivered(fixture.companyId, 'chat:telegram');
  assert.equal(waiting.some((item) => item.kind === 'budget_alert'), false);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'it is still in the inbox');
});

/** `n` retry-base intervals from now, for testing the backoff without waiting. */
function later(intervals: number): Date {
  return new Date(Date.now() + intervals * RETRY_BASE_MS);
}

async function notifiedEvents(fixture: Fixture): Promise<number> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM events WHERE type = 'owner.notified'",
    );
    return Number(rows[0]!.count);
  });
}

/** A moment past any owner window, for the kinds that wait for one (F10.5). */
function tomorrow(): Date {
  return new Date(Date.now() + 48 * 60 * 60 * 1000);
}

async function lastError(fixture: Fixture): Promise<string | null> {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{ last_error: string | null }>(
      'SELECT last_error FROM owner_notifications ORDER BY created_at DESC LIMIT 1',
    );
    return rows[0]?.last_error ?? null;
  });
}

/* ------------------------------------------------------------------ F10.6 --- */

/**
 * The daily digest reaches a channel, once, for yesterday.
 *
 * `renderDailyDigest` turned a digest into text and nothing sent it. The
 * console draws its own, so an owner looking at the console saw one and an
 * owner who was not looking never did -- and F10.6 asks for a digest, not for
 * a panel.
 *
 * Yesterday's rather than today's: a digest of a day still in progress is a
 * partial count that changes if you read it twice, and the point of a daily
 * digest is that it is the account of a day that finished.
 */
test('the daily digest is sent once a day, to channels that take one (F10.6)', async () => {
  const { dispatchDigest } = await import('../../src/owner/notify.ts');
  const fixture = await createCompany('digest-dispatch');

  const sent: Array<{ day: string; text: string }> = [];
  const taker: OwnerChannel = {
    name: 'test:digest',
    carries: () => true,
    async deliver() { return {}; },
    async deliverDigest(digest) { sent.push({ day: digest.day, text: digest.text }); },
  };
  // A channel with no `deliverDigest` is skipped rather than failed: a
  // transport with no sensible place for a page of text is not broken.
  const abstainer: OwnerChannel = {
    name: 'test:no-digest',
    carries: () => true,
    async deliver() { return {}; },
  };

  const first = await dispatchDigest(fixture.companyId, [taker, abstainer], {
    day: '2026-09-07', text: 'Digest for 2026-09-07\nSpend: 0.00',
  });
  assert.equal(first.delivered, 1);
  assert.equal(first.skipped, 1);
  assert.equal(sent.length, 1);

  // Once a day, and the record is what enforces it -- not a read followed by
  // a write, which two workers would both pass.
  const again = await dispatchDigest(fixture.companyId, [taker, abstainer], {
    day: '2026-09-07', text: 'Digest for 2026-09-07\nSpend: 0.00',
  });
  assert.equal(again.delivered, 0, 'the same day was sent twice');
  assert.equal(sent.length, 1);

  // A different day is a different digest.
  const nextDay = await dispatchDigest(fixture.companyId, [taker], {
    day: '2026-09-08', text: 'Digest for 2026-09-08\nSpend: 1.00',
  });
  assert.equal(nextDay.delivered, 1);
  assert.deepEqual(sent.map((one) => one.day), ['2026-09-07', '2026-09-08']);
});

test('a digest is redacted like everything else that leaves this process (F12.4)', async () => {
  const { dispatchDigest } = await import('../../src/owner/notify.ts');
  const { redactor } = await import('../../src/secrets/manager.ts');
  const fixture = await createCompany('digest-redaction');

  // A digest is assembled from what agents did, and an agent can put anything
  // in a title.
  redactor.register('sk_live_digest_secret_9a1');
  const sent: string[] = [];
  const channel: OwnerChannel = {
    name: 'test:digest-redact',
    carries: () => true,
    async deliver() { return {}; },
    async deliverDigest(digest) { sent.push(digest.text); },
  };

  await dispatchDigest(fixture.companyId, [channel], {
    day: '2026-09-07',
    text: 'Digest\nAn agent wrote sk_live_digest_secret_9a1 into a title.',
  });

  assert.equal(sent.length, 1);
  assert.equal(
    sent[0]!.includes('sk_live_digest_secret_9a1'), false,
    'a credential reached the owner\'s phone',
  );
});
