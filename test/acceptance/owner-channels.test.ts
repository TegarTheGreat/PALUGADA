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
  retractClosed,
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
      // Telegram's channel asks who it is once, to learn whether the owner's
      // chat has topics; answered here and not counted, since these tests
      // are about what reaches the owner. A bot without topic mode.
      if ((req.url ?? '').endsWith('/getMe')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot' } }));
        return;
      }
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
 * The analysis of 3 October, section 2.3 item 7: a run's question reached the
 * owner as "bookkeeper asks: ..." -- the role's short name, and English in
 * every language -- and the chat said the question twice, as the title and
 * again as the summary. It is headed by who asks, by the name the owner gave
 * the role, in the owner's language, and the question is said once.
 */
test('a run\'s question is headed by who asks, by name and in the owner\'s language, and says the question once (§2.3)', async () => {
  const fixture = await createCompany('chat-asker');
  await withTenant(fixture.companyId, (tx) => tx.query(
    "UPDATE roles SET display_name = 'Sari' WHERE id = $1", [fixture.roleId]));
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'chase the unpaid invoices' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which invoices may I chase today?' });

  const [open] = await inbox.listOpen(fixture.companyId);
  assert.equal(open!.roleName, 'Sari', 'the console names the role as the owner named it');
  assert.equal(open!.title, 'Sari asks: Which invoices may I chase today?', 'and so does the record');

  const [item] = await undelivered(fixture.companyId, 'chat:telegram', tomorrow());
  assert.equal(item!.asker, 'Sari');
  const english = telegram().render(item!).text;
  assert.match(english, /^\*Sari asks:\*\n\nWhich invoices may I chase today\?/);
  assert.equal(english.split('Which invoices may I chase today?').length, 2, 'the question is said once');
  const indonesian = telegram().render({ ...item!, language: 'id' }).text;
  assert.match(indonesian, /^\*Sari bertanya:\*\n\nWhich invoices may I chase today\?/);
  assert.doesNotMatch(indonesian, /asks/);
});

/**
 * What a phone shows at a glance: which button says yes and which says no,
 * and how long the item waits before silence refuses it.
 *
 * The time is Telegram's date entity rather than a time written out, so the
 * owner reads it in their own zone and words ("in 3 hours"); the written one
 * is only for a client that cannot show it, and is escaped like everything
 * else in the message, or Telegram would refuse the whole message.
 */
test('an approval says by colour which button is yes and which is no, and when it expires in the owner\'s own time (F10.9)', async () => {
  const fixture = await createCompany('chat-colours');
  await approval(fixture, 2, 'Pay the supplier');
  const [item] = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
  assert.ok(item?.expiresAt instanceof Date, 'an approval expires, and the item says when');

  const channel = telegram();
  const approve = channel.render(item);
  const buttons = (approve.reply_markup as { inline_keyboard: Array<Array<{ text: string; style?: string }>> }).inline_keyboard[0]!;
  assert.deepEqual(buttons.map((button) => [button.text, button.style]), [['Approve', 'success'], ['Deny', 'danger'], ['Ask', undefined]]);

  const unix = Math.floor(item.expiresAt.getTime() / 1000);
  const when = new RegExp(`_Expires:_ !\\[([^\\]]+)\\]\\(tg://time\\?unix=${unix}&format=r\\)`).exec(approve.text);
  assert.ok(when, approve.text);
  assert.doesNotMatch(when[1]!.replace(/\\[_*[\]()~`>#+\-=|{}.!\\]/g, ''), /[_*[\]()~`>#+\-=|{}.!\\]/, 'the written time is escaped');
  assert.match(when[1]!, /UTC$/, 'and says whose clock it is on');
  // In Indonesian the written time is "20.13": the dot is one MarkdownV2 reserves.
  const indonesian = channel.render({ ...item, language: 'id' }).text;
  assert.match(indonesian, /_Kedaluwarsa:_ !\[[^\]]*\d\\\.\d\d UTC\]\(tg:\/\/time\?unix=/);

  // A run's question: stopping the task is the red one, and the choices are only choices.
  const question = channel.render({ ...item, question: 'Which supplier?', options: ['Kopi Gayo', 'Kopi Toraja'] });
  const rows = (question.reply_markup as { inline_keyboard: Array<Array<{ text: string; style?: string }>> }).inline_keyboard;
  assert.deepEqual(rows.flat().map((button) => [button.text, button.style]), [
    ['Kopi Gayo', undefined], ['Kopi Toraja', undefined], ['Answer in words', undefined], ['Stop the task', 'danger'],
  ]);

  // Without an expiry there is no line for one.
  assert.doesNotMatch(channel.render({ ...item, expiresAt: null }).text, /Expires/);
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
          from: { id: 55555 },
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
 * "Ask" is a question, so it needs the owner's words.
 *
 * It used to record the decision at once with the note "via chat", and the
 * run that picked the task up was told "The owner has asked you a question:
 * via chat". Now the press asks the owner what the question is, and the reply
 * to that prompt is what is recorded and what the agent reads.
 */
test('Ask takes the question from the owner\'s reply, not from the button (F10.3, F10.9)', async () => {
  const fixture = await createCompany('chat-ask');
  const vendor = await fakeTelegram();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId,
      title: 'Which supplier?',
      detail: 'Two match.',
    });
    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });
    const owner = { id: 55555 };

    const pressed = await channel.onUpdate({
      callback_query: { id: 'cb-ask', data: encodeAction({ itemId, decision: 'ask' }), message: { chat: owner }, from: owner },
    }, { secretHeader: 'webhook-secret' });
    assert.equal(pressed.handled, true);

    // Nothing is decided by the press itself.
    const untouched = await withTenant(fixture.companyId, (tx) =>
      tx.query<{ decision: string | null; owner_note: string | null }>(
        'SELECT decision, owner_note FROM inbox_items WHERE id = $1', [itemId]));
    assert.deepEqual(untouched.rows[0], { decision: null, owner_note: null });

    // The owner is asked for the question, with a reply box already open.
    const prompt = vendor.calls.find((call) => call.path.endsWith('/sendMessage'))!;
    assert.equal(prompt.body.chat_id, '55555');
    assert.deepEqual((prompt.body.reply_markup as { force_reply?: boolean }).force_reply, true);
    assert.match(String(prompt.body.text), /Which supplier\?/);

    const reply = (from: { id: number }, text: string, to: { text: string; from: { is_bot: boolean } }) =>
      channel.onUpdate({
        message: { message_id: 8, text, chat: from, from, reply_to_message: { message_id: 7, ...to } },
      }, { secretHeader: 'webhook-secret' });
    const promptMessage = { text: String(prompt.body.text), from: { is_bot: true } };

    // Somebody else's reply is refused and recorded, and decides nothing.
    const stranger = await reply({ id: 666 }, 'Approve it all', promptMessage);
    assert.deepEqual(stranger, { handled: false, reason: 'wrong_chat' });
    // A reply to something that is not the prompt is not a question.
    assert.equal((await reply(owner, 'hello', { text: 'Good morning', from: { is_bot: true } })).handled, false);
    // Nor is an empty one, nor one to a message the owner wrote themselves,
    // whatever it says.
    assert.equal((await reply(owner, '   ', promptMessage)).handled, false);
    assert.equal((await reply(owner, 'Approve', { text: promptMessage.text, from: { is_bot: false } })).handled, false);

    const answered = await reply(owner, 'Which one delivers before Friday?', promptMessage);
    assert.equal(answered.handled, true);
    const asked = await withTenant(fixture.companyId, (tx) => tx.query<{
      decision: string; owner_note: string; decided_via: string; status: string;
    }>('SELECT decision, owner_note, decided_via, status FROM inbox_items WHERE id = $1', [itemId]));
    assert.deepEqual(asked.rows[0], {
      decision: 'ask', owner_note: 'Which one delivers before Friday?', decided_via: 'chat', status: 'open',
    });
    const refused = await withTenant(fixture.companyId, (tx) => tx.query(
      "SELECT 1 FROM events WHERE type = 'security.chat_stranger_refused'"));
    assert.equal(refused.rowCount, 1);
    // And the owner hears that it went through.
    assert.ok(vendor.calls.some((call) => call.path.endsWith('/sendMessage') && /Asked/.test(String(call.body.text))));

    // An item decided since is not asked about: no prompt for a closed item.
    await inbox.decide(fixture.companyId, itemId, 'deny', 'not needed', { channel: 'app' });
    const prompts = vendor.calls.filter((call) => call.body.reply_markup).length;
    const late = await channel.onUpdate({
      callback_query: { id: 'cb-late', data: encodeAction({ itemId, decision: 'ask' }), message: { chat: owner }, from: owner },
    }, { secretHeader: 'webhook-secret' });
    assert.deepEqual(late, { handled: false, reason: 'inbox.not_open' });
    assert.equal(vendor.calls.filter((call) => call.body.reply_markup).length, prompts, 'no prompt for a closed item');
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
          from: { id: 55555 },
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

    // In the owner's chat, pressed by somebody else: a group is one chat
    // with many people in it, and the check was on the chat.
    const bystander = await channel.onCallback(
      fixture.companyId,
      {
        callback_query: {
          id: 'cb3',
          data: encodeAction({ itemId, decision: 'approve' }),
          message: { chat: { id: 55555 } },
          from: { id: 77777, username: 'group_member' },
        },
      },
      { secretHeader: 'webhook-secret' },
    );
    assert.deepEqual(bystander, { handled: false, reason: 'wrong_chat' });

    // Recorded rather than silently dropped: somebody finding the bot is worth
    // knowing about.
    const refusals = await withTenant(fixture.companyId, async (tx) => {
      const { rows } = await tx.query<{ payload: { chatId?: string; username?: string } }>(
        "SELECT payload FROM events WHERE type = 'security.chat_stranger_refused'",
      );
      return rows;
    });
    assert.equal(refusals.length, 2);
    assert.deepEqual(refusals.map((row) => row.payload.username).sort(), ['group_member', 'passer_by']);

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
          from: { id: 55555 },
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
        callback_query: { id: 'c', data, message: { chat: { id: 55555 } }, from: { id: 55555 } },
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
  await withTenant(fixture.companyId, (tx) => tx.query(
    `INSERT INTO inbox_items (company_id, kind, title, action_summary, rationale, consequence_if_denied, notify_after)
     VALUES ($1, 'fact_candidate', 'Our roaster delivers on Tuesdays', 'Remember it', 'Seen in three orders.', '', now())`,
    [fixture.companyId]));

  // A `fact_candidate` is real, open, and past its window -- and F10.9 does
  // not name it, so `channelDelivery` answers `none` and no chat carries it.
  // It must not sit in the undelivered list looking like a backlog for ever.
  const waiting = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
  assert.equal(waiting.some((item) => item.kind === 'fact_candidate'), false);
  assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'it is still in the inbox');
});

test('a budget alert is carried to the chat as news with a link, saying what to do (section 6.3)', async () => {
  // It was a kind no channel carried, so work its budget stopped, and a
  // month's ceiling reached, reached nobody who was not looking at the app.
  const fixture = await createCompany('chat-budget');
  await inbox.raiseBudgetAlert({
    companyId: fixture.companyId,
    title: 'Ops has spent 80% of its month',
    detail: 'At the current rate it runs out on the 24th.',
  });
  // It waits for the owner's window like an escalation (F10.5), so looked for a day on.
  const waiting = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
  const alert = waiting.find((item) => item.kind === 'budget_alert');
  assert.ok(alert, 'queued for the chat');
  assert.equal(alert.delivery, 'link_only', 'with nothing to press: a ceiling is raised in the app');
  assert.equal(alert.actionSummary, 'At the current rate it runs out on the 24th.', 'and the body says what the title does not');
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

/**
 * A channel that fails does not lose the day, or stop the others.
 *
 * The claim is written before the transport is called -- correct, and the same
 * rule every item delivery here follows. But `retryFailed` inner-joins
 * `inbox_items`, so a digest row is invisible to it: a claim left behind by a
 * transient failure would lose that day's digest permanently, and one
 * unreachable transport would abort every later channel in the array on every
 * tick.
 */
test('a digest that fails to send is not lost, and does not block the others (F10.6)', async () => {
  const { dispatchDigest } = await import('../../src/owner/notify.ts');
  const fixture = await createCompany('digest-failure');

  let attempts = 0;
  const flaky: OwnerChannel = {
    name: 'test:flaky-digest',
    carries: () => true,
    async deliver() { return {}; },
    async deliverDigest() {
      attempts += 1;
      if (attempts === 1) throw new Error('the relay was restarting');
    },
  };
  const steady: string[] = [];
  const other: OwnerChannel = {
    name: 'test:steady-digest',
    carries: () => true,
    async deliver() { return {}; },
    async deliverDigest(digest) { steady.push(digest.day); },
  };

  const first = await dispatchDigest(fixture.companyId, [flaky, other], {
    day: '2026-09-07', text: 'Digest',
  });
  assert.equal(first.delivered, 1, 'the second channel was skipped by the first one failing');
  assert.deepEqual(first.failed.map((one) => one.channel), ['test:flaky-digest']);
  assert.deepEqual(steady, ['2026-09-07']);

  // The claim stays and carries the reason -- `DELETE` is not the tenant
  // role's to make, and a log of what the owner was told is not something the
  // console's own role should be able to erase. `retryDigests` is what comes
  // back to it; `retryFailed` cannot, because it joins `inbox_items` and a
  // digest has no row there.
  const { retryDigests } = await import('../../src/owner/notify.ts');
  const retried = await retryDigests(
    fixture.companyId, [flaky, other], { baseDelayMs: 0 },
  );
  assert.equal(retried.delivered, 1, 'the lost day was never retried');
  assert.equal(attempts, 2);
  assert.deepEqual(steady, ['2026-09-07'], 'the steady channel was sent the same day twice');

  // And nothing is owed afterwards.
  assert.equal((await retryDigests(fixture.companyId, [flaky, other], { baseDelayMs: 0 }))
    .delivered, 0);
});

test('the digest is not built for a day already sent (F10.6)', async () => {
  // `buildDailyDigest` is several aggregates over a day of events. Running it
  // every tick to throw the answer away on a uniqueness conflict is a query a
  // minute, all day, for one message.
  const { digestOwed, dispatchDigest } = await import('../../src/owner/notify.ts');
  const fixture = await createCompany('digest-owed');

  const channel: OwnerChannel = {
    name: 'test:owed',
    carries: () => true,
    async deliver() { return {}; },
    async deliverDigest() { /* recorded by the table */ },
  };

  assert.deepEqual(
    (await digestOwed(fixture.companyId, [channel], '2026-09-07')).map((one) => one.name),
    ['test:owed'],
  );

  await dispatchDigest(fixture.companyId, [channel], { day: '2026-09-07', text: 'Digest' });

  assert.deepEqual(await digestOwed(fixture.companyId, [channel], '2026-09-07'), []);
  // A different day is still owed.
  assert.equal((await digestOwed(fixture.companyId, [channel], '2026-09-08')).length, 1);
});

/* ------------------------------------------------ a message outlives its item --- */

/**
 * A fake Telegram that answers `sendMessage` with a message id and every other
 * method with whatever `edit` says, so each test decides how the edit goes.
 */
async function fakeTelegram(
  edit: (index: number) => { status: number; body: unknown } = () => ({
    status: 200, body: { ok: true, result: true },
  }),
) {
  let edits = 0;
  return fakeVendor((call) => {
    if (call.path.endsWith('/sendMessage')) {
      return { status: 200, body: { ok: true, result: { message_id: 7 } } };
    }
    if (call.path.endsWith('/editMessageText')) return edit(edits++);
    return { status: 200, body: { ok: true, result: true } };
  });
}

async function retraction(fixture: Fixture, itemId: string) {
  return withTenant(fixture.companyId, async (tx) => {
    const { rows } = await tx.query<{
      retracted_at: Date | null; retract_attempts: number; retract_error: string | null;
    }>(
      `SELECT retracted_at, retract_attempts, retract_error FROM owner_notifications
        WHERE inbox_item_id = $1`,
      [itemId],
    );
    return rows[0]!;
  });
}

/**
 * Slack's best-known human-in-the-loop defect, and it was this platform's too:
 * `external_ref` was stored "so a later edit can find it" and nothing edited,
 * so a chat message kept Approve and Deny after the owner had decided in the
 * console. The edit is exactly-once, like the send.
 */
test('a chat message loses its buttons once the item is decided elsewhere (F10.9)', async () => {
  const fixture = await createCompany('chat-retract');
  const vendor = await fakeTelegram();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Which supplier?', detail: 'Two match.',
    });
    const channel = telegram({ url: vendor.url });
    await dispatch(fixture.companyId, channel, { now: tomorrow() });

    // Still open: nothing to retract, and nothing is called.
    assert.deepEqual(await retractClosed(fixture.companyId, channel), { retracted: 0, failed: 0 });
    assert.equal(vendor.calls.length, 1);

    await inbox.decide(fixture.companyId, itemId, 'deny', 'neither', { channel: 'app' });
    assert.deepEqual(await retractClosed(fixture.companyId, channel), { retracted: 1, failed: 0 });

    const edit = vendor.calls[1]!;
    assert.match(edit.path, /\/editMessageText$/);
    assert.equal(edit.body.message_id, 7);
    assert.equal(edit.body.chat_id, '55555');
    assert.equal(edit.body.reply_markup, undefined, 'no reply_markup is what removes the buttons');
    assert.match(String(edit.body.text), /Denied/);

    // Exactly once.
    assert.deepEqual(await retractClosed(fixture.companyId, channel), { retracted: 0, failed: 0 });
    assert.equal(vendor.calls.length, 2);
    assert.ok((await retraction(fixture, itemId)).retracted_at);
  } finally {
    await vendor.close();
  }
});

/**
 * Two of Telegram's refusals mean there is nothing to fix -- the owner deleted
 * the message -- and one is an ordinary failure that deserves a retry, after a
 * wait. Spending the retry budget on a deleted message, or retrying a failure
 * in the same tick, would each be wrong in its own direction.
 */
test('a deleted message is not retried, and a failed edit is retried after a wait (F10.9)', async () => {
  const fixture = await createCompany('chat-retract-fail');
  const vendor = await fakeTelegram((index) =>
    index === 0
      ? { status: 400, body: { ok: false, description: 'Bad Request: message to edit not found' } }
      : index === 1
        ? { status: 502, body: { ok: false, description: 'Bad Gateway' } }
        : { status: 200, body: { ok: true, result: true } });
  try {
    const channel = telegram({ url: vendor.url });
    const deleted = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'First', detail: 'one',
    });
    const flaky = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Second', detail: 'two',
    });
    await dispatch(fixture.companyId, channel, { now: tomorrow() });
    await inbox.decide(fixture.companyId, deleted, 'deny');
    await inbox.decide(fixture.companyId, flaky, 'deny');

    const now = new Date();
    assert.deepEqual(
      await retractClosed(fixture.companyId, channel, { now }),
      { retracted: 1, failed: 1 },
    );
    assert.ok((await retraction(fixture, deleted)).retracted_at, 'gone counts as done');
    const failed = await retraction(fixture, flaky);
    assert.equal(failed.retracted_at, null);
    assert.match(failed.retract_error ?? '', /Bad Gateway/);

    // Not in the same breath...
    assert.deepEqual(
      await retractClosed(fixture.companyId, channel, { now: new Date(now.getTime() + 1_000) }),
      { retracted: 0, failed: 0 },
    );
    // ...but once the wait has passed.
    assert.deepEqual(
      await retractClosed(fixture.companyId, channel, {
        now: new Date(now.getTime() + RETRY_BASE_MS + 1_000),
      }),
      { retracted: 1, failed: 0 },
    );
    assert.equal((await retraction(fixture, flaky)).retract_error, null);
  } finally {
    await vendor.close();
  }
});

/**
 * A press on a button the sweep has not reached yet is the ordinary way to
 * find a closed item, and "could not be recorded" read as a fault. The owner
 * is told what happened to it.
 */
test('a press on a closed item says what happened to it (F10.9)', async () => {
  const fixture = await createCompany('chat-stale-press');
  const vendor = await fakeTelegram();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Which supplier?', detail: 'Two match.',
    });
    await inbox.decide(fixture.companyId, itemId, 'deny', 'neither', { channel: 'app' });

    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });
    const outcome = await channel.onCallback(
      fixture.companyId,
      {
        callback_query: {
          id: 'cb-stale',
          data: encodeAction({ itemId, decision: 'approve' }),
          message: { chat: { id: 55555 } },
          from: { id: 55555 },
        },
      },
      { secretHeader: 'webhook-secret' },
    );
    assert.deepEqual(outcome, { handled: false, reason: 'inbox.not_open' });
    const answer = vendor.calls.find((call) => call.path.endsWith('/answerCallbackQuery'))!;
    assert.equal(answer.body.text, 'Denied. Nothing left to press here.');
  } finally {
    await vendor.close();
  }
});

/**
 * Push has no buttons, so it has nothing dangerous left behind and no
 * `retract`: a "that is over now" notification would be a second interruption
 * to say the first one no longer matters.
 */
test('the sweep leaves a channel with nothing to retract alone', async () => {
  const fixture = await createCompany('push-no-retract');
  const vendor = await fakeVendor(() => ({ status: 200, body: { id: 'receipt-1' } }));
  try {
    const push = new WebhookPush({ url: vendor.url });
    const itemId = await incident(fixture, 'Gateway down');
    await dispatch(fixture.companyId, push);
    await inbox.decide(fixture.companyId, itemId, 'deny');
    assert.deepEqual(await retractClosed(fixture.companyId, push), { retracted: 0, failed: 0 });
    assert.equal(vendor.calls.length, 1);
  } finally {
    await vendor.close();
  }
});

/**
 * The route the presses arrive at.
 *
 * The channel sent buttons, verified presses and recorded decisions -- and no
 * route called it. Every button in every message did nothing. The webhook is
 * the console's own server now, and the press finds its company from its
 * item, because sixty-four bytes of callback data will not hold both.
 */
test('a press posted to the webhook is decided, and one without the secret is refused (F10.9)', async () => {
  const fixture = await createCompany('chat-webhook');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: {} } }));
  const { OwnerApi } = await import('../../src/owner/api.ts');
  const { OwnerMfa } = await import('../../src/owner/mfa.ts');
  const { InMemorySecretManager } = await import('../../src/secrets/manager.ts');
  const api = new OwnerApi({
    mfa: new OwnerMfa({ secrets: new InMemorySecretManager() }),
    telegram: telegram({ url: vendor.url, secret: 'webhook-secret' }),
  });
  const { url } = await api.listen();
  try {
    const itemId = await inbox.raiseEscalation({
      companyId: fixture.companyId, title: 'Which supplier?', detail: 'Two match.',
    });
    const post = (headers: Record<string, string>) => fetch(`${url}/api/channels/telegram`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({
        callback_query: {
          id: 'cb1',
          data: encodeAction({ itemId, decision: 'deny' }),
          message: { chat: { id: 55555 } },
          from: { id: 55555 },
        },
      }),
    });

    assert.equal((await post({})).status, 401, 'not from Telegram');
    assert.equal((await post({ 'x-telegram-bot-api-secret-token': 'guess' })).status, 401);
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 1, 'nothing decided');

    const pressed = await post({ 'x-telegram-bot-api-secret-token': 'webhook-secret' });
    assert.equal(pressed.status, 200);
    assert.deepEqual(await pressed.json(), { handled: true });
    assert.equal((await inbox.listOpen(fixture.companyId)).length, 0);
  } finally {
    await api.close();
    await vendor.close();
  }
});


/* ------------------------------------------------------------- language --- */

/**
 * What the platform says on the owner's phone is in the owner's language --
 * the panel's, which they chose for reading PALUGADA -- and what an agent
 * wrote is passed through as written. A push in English opening an app in
 * Indonesian is the same owner spoken to by two products.
 */
test("notifications speak the owner's language, and an agent's words are left as they are", async () => {
  const fixture = await createCompany('owner-language');
  const { setDeploymentLanguages } = await import('../../src/domain/language.ts');
  const { closureText } = await import('../../src/owner/notify.ts');
  await setDeploymentLanguages({ console: 'id' });
  await inbox.requestApproval({
    companyId: fixture.companyId,
    capabilityName: 'payment.send',
    tier: 2,
    actionSummary: 'Pay the supplier',
    rationale: 'The invoice is verified.',
    consequenceIfDenied: 'The supplier is not paid.',
  });

  const [item] = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
  assert.ok(item, 'the approval is waiting to be sent');
  assert.equal(item.language, 'id');

  const pushed = new WebhookPush({ url: 'http://127.0.0.1:1' }).message(item);
  assert.equal(pushed.title, 'Perlu persetujuan: Pay the supplier', 'the agent wrote the title; the platform wrote the rest');
  assert.equal(pushed.body, 'Pay the supplier — jika ditolak: The supplier is not paid.');

  const chat = telegram({ url: 'http://127.0.0.1:1' }).render(item);
  assert.match(chat.text, /Jika ditolak:/);
  const buttons = (chat.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]!;
  assert.deepEqual(buttons.map((button) => button.text), ['Setujui', 'Tolak', 'Tanya']);

  assert.equal(
    closureText({ id: item.id, companyId: fixture.companyId, kind: 'approval', title: 't', status: 'expired', decision: null, closedReason: null, language: 'id' }),
    'Kedaluwarsa tanpa jawaban. Diam berarti menolak, jadi tidak ada yang dijalankan.',
  );

  // Unset, it is English, exactly as before there was a choice.
  await setDeploymentLanguages({ console: null });
  const [english] = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
  assert.equal(new WebhookPush({ url: 'http://127.0.0.1:1' }).message(english!).title, 'Approval needed: Pay the supplier');
});

/**
 * A decision and a task's end reached the owner as the codes the platform
 * keeps them by -- "Recorded: deny.", "the task it was asking about is
 * cancelled" -- which a translation can only leave in English inside its
 * own sentence. Each is a sentence of its own now.
 */
test('what the owner decided, and why an item closed, are said in their language rather than as codes', async () => {
  const { closureText, recordedText } = await import('../../src/owner/notify.ts');
  assert.equal(recordedText('en', 'approve'), 'Recorded: approved.');
  assert.equal(recordedText('en', 'deny'), 'Recorded: denied.');
  assert.equal(recordedText('id', 'deny'), 'Tercatat: ditolak.');
  const closed = { id: 'x', companyId: 'c', kind: 'approval', title: 't', decision: null } as const;
  for (const [state, english] of [
    ['completed', 'Withdrawn: the task it was asking about has finished.'],
    ['failed', 'Withdrawn: the task it was asking about has failed.'],
    ['halted', 'Withdrawn: the task it was asking about was stopped.'],
    ['cancelled', 'Withdrawn: the task it was asking about was cancelled.'],
  ] as const) {
    assert.equal(closureText({ ...closed, status: 'withdrawn', closedReason: `task_${state}`, language: 'en' }), english);
    assert.doesNotMatch(closureText({ ...closed, status: 'withdrawn', closedReason: `task_${state}`, language: 'id' }), new RegExp(state));
  }
  assert.equal(closureText({ ...closed, status: 'decided', decision: 'ask', closedReason: null, language: 'en' }),
    'Asked. Nothing left to press here.');
  // Every other reason an item is withdrawn for, and the ones nothing writes
  // yet, said without the code: "Withdrawn (stage_changed)." was English in
  // every language.
  for (const [reason, english] of [
    ['superseded', 'Withdrawn: the agent changed what it proposes and asked again about the new one.'],
    ['stage_changed', 'Withdrawn: the company is no longer at the stage this proposal would move it from.'],
    ['decided_elsewhere', 'Withdrawn: it was already decided in the app.'],
    ['something_new', 'Withdrawn. Nothing left to press here.'],
    ['task_waiting', 'Withdrawn. Nothing left to press here.'],
  ] as const) {
    assert.equal(closureText({ ...closed, status: 'withdrawn', closedReason: reason, language: 'en' }), english);
    assert.doesNotMatch(closureText({ ...closed, status: 'withdrawn', closedReason: reason, language: 'id' }), new RegExp(reason));
  }
  assert.equal(closureText({ ...closed, status: 'decided', decision: 'revise', closedReason: null, language: 'en' }),
    'Decided. Nothing left to press here.');
  // A press that finds its item closed is told the same, from the refusal
  // that said so; one whose item is gone is told that, not "is closed: null".
  const { notOpenText } = await import('../../src/owner/notify.ts');
  const { PalugadaError } = await import('../../src/errors.ts');
  const refused = (details: Record<string, unknown>) => new PalugadaError('inbox.not_open', 'inbox item x is closed', details);
  assert.equal(notOpenText('en', refused({ status: 'decided', decision: 'deny', closedReason: null })), 'Denied. Nothing left to press here.');
  assert.equal(notOpenText('en', refused({ status: 'open', decision: null, closedReason: null })),
    'Expired unanswered. Silence is a refusal, so nothing was done.');
  assert.equal(notOpenText('en', refused({ status: null })), 'That item no longer exists.');
  assert.equal(notOpenText('id', refused({ status: 'withdrawn', decision: null, closedReason: 'superseded' })).includes('superseded'), false);
});

test('every sentence the platform says to the owner has its translation (src/owner/say.ts)', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { OWNER_SENTENCES } = await import('../../src/owner/say.ts');
  const directory = new URL('../../src/owner/', import.meta.url);
  const said = new Set<string>();
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.ts') || name === 'say.ts') continue;
    const source = await readFile(new URL(name, directory), 'utf8');
    // One line at a time: a ternary's question mark is on the call's own line,
    // and one further down the file belongs to something else.
    // A literal as JavaScript reads it: "a domain\'s records" is the key.
    // The ternary is tried only when a literal is not next, or a sentence
    // ending in a question mark would read as the ternary's condition.
    const literal = (text: string) => text.replace(/\\(.)/g, '$1');
    for (const match of source.matchAll(/\bsay\([^,\n]+,\s*(?:[^?\n]+\?\s*)??'((?:[^'\\]|\\.)*)'(?:\s*:\s*'((?:[^'\\]|\\.)*)')?/g)) {
      said.add(literal(match[1]!));
      if (match[2]) said.add(literal(match[2]));
    }
  }
  assert.ok(said.size >= 15, `only ${said.size} sentences were found; the scan is broken`);
  // The language that picks these is the panel's, so every language the
  // console is drawn in has them: an owner who reads the panel in Russian
  // gets Russian on the phone too.
  const locales = (await readdir(new URL('../../console/src/locales/', import.meta.url)))
    .filter((name) => name.endsWith('.ts') && name !== 'types.ts').map((name) => name.replace(/\.ts$/, ''));
  assert.deepEqual(Object.keys(OWNER_SENTENCES).sort(), locales.sort(), 'the languages the console offers and the ones the platform speaks differ');
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();
  // A translation into a language with a script of its own that has none of
  // it is English that nobody translated.
  const script: Record<string, RegExp> = {
    zh: /\p{Script=Han}/u, ru: /\p{Script=Cyrillic}/u, hi: /\p{Script=Devanagari}/u,
    ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u, ko: /\p{Script=Hangul}/u,
    th: /\p{Script=Thai}/u, ar: /\p{Script=Arabic}/u,
  };
  for (const [language, sentences] of Object.entries(OWNER_SENTENCES)) {
    assert.deepEqual([...said].filter((sentence) => !(sentence in sentences)), [], `${language} is missing sentences`);
    assert.deepEqual(Object.keys(sentences).filter((sentence) => !said.has(sentence)), [], `${language} keeps sentences nothing says`);
    for (const [english, translated] of Object.entries(sentences)) {
      assert.deepEqual(placeholders(translated), placeholders(english), `${language}: "${english}" and its translation name different values`);
      assert.notEqual(translated.trim(), '', `${language}: "${english}" is translated as nothing`);
      if (script[language]) assert.match(translated, script[language]!, `${language}: "${english}" is not written in its script`);
    }
  }
});

/**
 * An action the broker asks about is named for what it does, on the phone as
 * in the console (the analysis of 3 October, §2.3 item 7): a chat card said
 * "record.delete: recordId cust-042", the capability's code, in English
 * whatever the owner reads. Its arguments are the agent's and stay as they are.
 */
test("an approval in a chat names its action for what it does, in the owner's language", async () => {
  const fixture = await createCompany('owner-language-action');
  const { setDeploymentLanguages } = await import('../../src/domain/language.ts');
  await setDeploymentLanguages({ console: 'id' });
  try {
    await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'record.delete', tier: 3,
      title: 'record.delete: recordId cust-042', actionSummary: 'record.delete: recordId cust-042; reason duplicate',
      rationale: 'A duplicate of cust-041.', consequenceIfDenied: 'The duplicate stays.',
    });
    const [item] = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
    assert.equal(item!.title, 'Hapus data: recordId cust-042');
    assert.equal(item!.actionSummary, 'Hapus data: recordId cust-042; reason duplicate');
    assert.doesNotMatch(telegram({ url: 'http://127.0.0.1:1' }).render(item!).text, /record\.delete/);
    assert.equal(new WebhookPush({ url: 'http://127.0.0.1:1' }).message(item!).title, 'Perlu persetujuan: Hapus data: recordId cust-042');

    // An action the platform has no name for keeps its code: nothing is guessed.
    await inbox.requestApproval({
      companyId: fixture.companyId, capabilityName: 'payment.send', tier: 2,
      title: 'payment.send: amount 120', actionSummary: 'payment.send: amount 120', rationale: 'Invoice 7.',
      consequenceIfDenied: 'The supplier waits.',
    });
    const all = await undelivered(fixture.companyId, 'chat:telegram', new Date(Date.now() + 86_400_000));
    assert.ok(all.some((one) => one.title === 'payment.send: amount 120'));
  } finally {
    await setDeploymentLanguages({ console: null });
  }
});

/**
 * A run's question (`owner.ask`) reaches the chat as something to answer, not
 * approve, and the owner's reply is the answer the task resumes with.
 */
test("a run's question is answered from the chat, in the owner's words (owner.ask, F10.9)", async () => {
  const fixture = await createCompany('chat-answer');
  const vendor = await fakeTelegram();
  try {
    const { createRootTask, transition, getTask } = await import('../../src/engine/tasks.ts');
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
      input: { goal: 'order the beans' }, createdBy: 'owner', reserveTokens: 1_000,
    });
    await transition(fixture.companyId, task.id, 'running');
    const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Arabica or robusta?' });
    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });

    await dispatch(fixture.companyId, channel, { now: tomorrow() });
    const sent = vendor.calls.find((call) => call.path.endsWith('/sendMessage'))!;
    const buttons = (sent.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0]!;
    assert.deepEqual(buttons.map((button) => button.text), ['Answer', 'Stop the task']);

    const owner = { id: 55555 };
    const pressed = await channel.onUpdate({
      callback_query: { id: 'cb-answer', data: encodeAction({ itemId: asked.inboxItemId, decision: 'approve' }), message: { chat: owner }, from: owner },
    }, { secretHeader: 'webhook-secret' });
    assert.equal(pressed.handled, true);
    const still = await withTenant(fixture.companyId, (tx) => tx.query<{ status: string }>(
      'SELECT status FROM inbox_items WHERE id = $1', [asked.inboxItemId]));
    assert.equal(still.rows[0]!.status, 'open', 'pressing Answer answers nothing yet');

    const prompt = vendor.calls.filter((call) => call.path.endsWith('/sendMessage')).at(-1)!;
    assert.match(String(prompt.body.text), /Arabica or robusta\?/);
    const replied = await channel.onUpdate({
      message: {
        message_id: 9, text: 'Arabica, from Gayo.', chat: owner, from: owner,
        reply_to_message: { message_id: 8, text: String(prompt.body.text), from: { is_bot: true } },
      },
    }, { secretHeader: 'webhook-secret' });
    assert.equal(replied.handled, true);

    const { rows } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string; owner_note: string; status: string }>(
      'SELECT decision, owner_note, status FROM inbox_items WHERE id = $1', [asked.inboxItemId]));
    assert.deepEqual(rows[0], { decision: 'approve', owner_note: 'Arabica, from Gayo.', status: 'decided' });
    assert.equal((await withTenant(fixture.companyId, (tx) => getTask(tx, task.id)))!.status, 'running');
    assert.deepEqual(await withTenant(fixture.companyId, (tx) => inbox.answersFor(tx, task.id)),
      [{ question: 'Arabica or robusta?', answer: 'Arabica, from Gayo.' }]);
  } finally {
    await vendor.close();
  }
});

/**
 * A question with choices (Paperclip's decisions carry options): the owner
 * answers with one press, on the phone, and the task resumes with the choice.
 * "Which of these three domains?" used to be a round of asking and answering
 * in words.
 */
test("a run's question with choices is answered with one press (owner.ask)", async () => {
  const fixture = await createCompany('chat-choice');
  const vendor = await fakeTelegram();
  try {
    const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
    const task = await createRootTask({
      companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
      roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
      input: { goal: 'register a domain' }, createdBy: 'owner', reserveTokens: 1_000,
    });
    await transition(fixture.companyId, task.id, 'running');
    const options = ['kopi.id', 'kopinusantara.com', 'kopi.co'];
    const asked = await inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which domain?', options });
    const [open] = await inbox.listOpen(fixture.companyId);
    assert.deepEqual(open!.options, options);

    const channel = telegram({ url: vendor.url, secret: 'webhook-secret' });
    await dispatch(fixture.companyId, channel, { now: tomorrow() });
    const sent = vendor.calls.find((call) => call.path.endsWith('/sendMessage'))!;
    const rows = (sent.body.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    assert.deepEqual(rows.map((row) => row.map((button) => button.text)),
      [['kopi.id'], ['kopinusantara.com'], ['kopi.co'], ['Answer in words', 'Stop the task']]);

    const owner = { id: 55555 };
    const press = (data: string) => channel.onUpdate({
      callback_query: { id: `cb-${data}`, data, message: { chat: owner }, from: owner },
    }, { secretHeader: 'webhook-secret' });
    // A choice the question does not have is not a choice.
    assert.equal((await press(`palugada:${asked.inboxItemId}:c5`)).handled, false);
    assert.equal((await press(rows[1]![0]!.callback_data)).handled, true);

    const { rows: item } = await withTenant(fixture.companyId, (tx) => tx.query<{ decision: string; owner_note: string }>(
      'SELECT decision, owner_note FROM inbox_items WHERE id = $1', [asked.inboxItemId]));
    assert.deepEqual(item[0], { decision: 'approve', owner_note: 'kopinusantara.com' });
  } finally {
    await vendor.close();
  }
});

test('choices are two to six short, different answers', async () => {
  const fixture = await createCompany('chat-choice-bounds');
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'decide' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  const ask = (options: string[]) => inbox.askOwner({ companyId: fixture.companyId, taskId: task.id, question: 'Which?', options });
  for (const bad of [['only one'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['same', 'same'], ['fine', '  '], ['x'.repeat(81), 'y']]) {
    await assert.rejects(ask(bad), /choices/);
  }
});

/*
 * Work done (0059). The owner gave a role something to do and learned it was
 * finished by opening the console and looking. Buzz calls it the callback
 * mention. A notice goes to a chat -- not a push, which F10.5 keeps for an
 * incident and a tier 3 approval -- once per task, in the owner's window and
 * language, and only for work the owner gave.
 */
test('the owner hears in the chat that work they gave has finished, once, in their window', async () => {
  const fixture = await createCompany('done-notice');
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const { dispatchDoneNotices } = await import('../../src/owner/notify.ts');
  const { setOwnerWindow } = await import('../../src/scheduler/windows.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: { message_id: 7 } } }));
  try {
    const chat = telegram({ url: vendor.url });
    const give = async (goal: string, createdBy: 'owner' | 'scheduler' | 'agent_run' = 'owner') => {
      const task = await createRootTask({
        companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
        roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
        input: { goal }, createdBy, reserveTokens: 1_000,
      });
      await transition(fixture.companyId, task.id, 'running');
      return task;
    };
    const letter = await give('Write the October newsletter');
    await transition(fixture.companyId, letter.id, 'completed', { output: { summary: 'Drafted, 140 words.' } });
    const broken = await give('Renew the domain');
    await transition(fixture.companyId, broken.id, 'halted', { haltReason: 'budget_exhausted' });
    const routine = await give('Check the uptime', 'scheduler');
    await transition(fixture.companyId, routine.id, 'completed', { output: { summary: 'up' } });
    const delegated = await give('A part an agent handed on', 'agent_run');
    await transition(fixture.companyId, delegated.id, 'completed', { output: { summary: 'done' } });

    // Outside the owner's window, news waits.
    const hour = new Date().getUTCHours();
    await setOwnerWindow({ timezone: 'UTC', startHour: (hour + 2) % 24, endHour: (hour + 4) % 24 });
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat]), { delivered: 0 });

    await setOwnerWindow({ timezone: 'UTC', startHour: hour, endHour: (hour + 2) % 24 });
    await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat],
      { linkFor: (task) => `https://app.palugada.test/t/${task.taskId}` }), { delivered: 2 });
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat]), { delivered: 0 }, 'once');

    const texts = vendor.calls.map((call) => String(call.body.text));
    assert.equal(texts.length, 2, 'not for the routine check, nor for work an agent started');
    assert.ok(texts.some((text) => /Selesai: Write the October newsletter/.test(text) && /Drafted, 140 words/.test(text)));
    // Why, in the owner's language: it was the halt's code read aloud, "budget exhausted" (§2.3 item 7).
    assert.ok(texts.some((text) => /Berhenti sebelum selesai: Renew the domain/.test(text) && /Kehabisan anggaran/.test(text)));
    assert.ok(texts.every((text) => !/budget.exhausted/.test(text)));
    assert.ok(vendor.calls.every((call) => JSON.stringify(call.body).includes('https://app.palugada.test/t/')));
    assert.ok(vendor.calls.every((call) => call.body.reply_markup === undefined
      || !JSON.stringify(call.body.reply_markup).includes('callback_data')), 'nothing to press');
  } finally {
    await vendor.close();
  }
});

/*
 * N9: work its run said it did not do is not "stopped" with a code read
 * aloud. The owner reads that it was not done, and the run's own reason.
 */
test('work the owner gave that was not done is said to be not done, with the run\'s reason', async () => {
  const fixture = await createCompany('not-done-notice');
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const { dispatchDoneNotices } = await import('../../src/owner/notify.ts');
  const { setOwnerWindow } = await import('../../src/scheduler/windows.ts');
  const { withControlPlane } = await import('../../src/db/tenant.ts');
  const hour = new Date().getUTCHours();
  await setOwnerWindow({ timezone: 'UTC', startHour: hour, endHour: (hour + 2) % 24 });
  await withControlPlane((tx) => tx.query("UPDATE platform_control SET console_language = 'id'"));
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Hapus data pelanggan cust-042' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  const why = 'Menghapus data pelanggan perlu persetujuan Anda, dan saya belum mendapatkannya.';
  await transition(fixture.companyId, task.id, 'failed', {
    haltReason: 'not_done', detail: why, output: { summary: 'Data cust-042 tidak dihapus.', notDone: why },
  });

  const vendor = await fakeVendor(() => ({ status: 200, body: { ok: true, result: { message_id: 11 } } }));
  try {
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [telegram({ url: vendor.url })]), { delivered: 1 });
    // As read, without Telegram's escapes.
    const text = String(vendor.calls[0]!.body.text).replace(/\\/g, '');
    assert.match(text, /Tidak dikerjakan: Hapus data pelanggan cust-042/);
    assert.ok(text.includes(why), text);
    assert.doesNotMatch(text, /not done|Sebabnya/, 'not a code read aloud');
  } finally {
    await vendor.close();
  }
});

test('a push channel does not carry work-done news, and a failed notice is tried again later', async () => {
  const fixture = await createCompany('done-notice-push');
  const { createRootTask, transition } = await import('../../src/engine/tasks.ts');
  const { dispatchDoneNotices } = await import('../../src/owner/notify.ts');
  const { setOwnerWindow } = await import('../../src/scheduler/windows.ts');
  const hour = new Date().getUTCHours();
  await setOwnerWindow({ timezone: 'UTC', startHour: hour, endHour: (hour + 2) % 24 });
  const task = await createRootTask({
    companyId: fixture.companyId, projectId: fixture.projectId, divisionId: fixture.divisionId,
    roleId: fixture.roleId, budgetAccountId: fixture.budgetAccountId, goalId: fixture.goalId,
    input: { goal: 'Price the new blend' }, createdBy: 'owner', reserveTokens: 1_000,
  });
  await transition(fixture.companyId, task.id, 'running');
  await transition(fixture.companyId, task.id, 'completed', { output: { summary: 'Rp 95.000' } });

  const push = new WebhookPush({ url: 'http://127.0.0.1:9', token: 'Bearer push-token' });
  assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [push]), { delivered: 0 });

  const vendor = await fakeVendor((_, index) => (index === 0
    ? { status: 502, body: { ok: false, description: 'Bad Gateway' } }
    : { status: 200, body: { ok: true, result: { message_id: 9 } } }));
  try {
    const chat = telegram({ url: vendor.url });
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat]), { delivered: 0 });
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat]), { delivered: 0 }, 'not at once');
    await withTenant(fixture.companyId, (tx) => tx.query(
      "UPDATE owner_notifications SET last_attempt_at = now() - interval '10 minutes' WHERE task_id = $1", [task.id]));
    assert.deepEqual(await dispatchDoneNotices(fixture.companyId, [chat]), { delivered: 1 });
    assert.equal(vendor.calls.length, 2);
  } finally {
    await vendor.close();
  }
});
