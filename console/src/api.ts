/**
 * The wire to the owner API.
 *
 * **The token lives in memory.** Not `localStorage`: a token there survives a
 * closed tab, is readable by anything that manages to run script on this
 * origin, and buys the owner nothing but skipping one code a day. Closing the
 * tab signs out, which is what a person expects from anything that guards
 * money.
 *
 * Every call is written `api('METHOD', '/api/...')` with the path spelled out,
 * never assembled in a variable: `test/documents/console-routes.test.ts` reads
 * these calls to prove every route the API offers can be pressed from here.
 */

import { N, t } from './i18n.ts';
import type { PasskeyAssertion } from './passkey.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
    /** What the refusal names -- the task already running, the field that was wrong -- for a page to act on. */
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let token: string | null = null;
let onSignedOut: (() => void) | null = null;

export function setToken(value: string | null): void {
  token = value;
}

/** Called when the API answers "sign in first": the session ended elsewhere. */
export function whenSignedOut(listener: () => void): void {
  onSignedOut = listener;
}

// The API answers JSON whose shape each page knows; the page states it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
  });
  const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const code = typeof answer.code === 'string' ? answer.code : undefined;
    // A session revoked from another device, or expired: back to the door,
    // rather than every panel failing one by one.
    if (response.status === 401 && code === 'owner.unauthenticated' && token) {
      token = null;
      onSignedOut?.();
    }
    throw new ApiError(
      typeof answer.error === 'string' ? answer.error : `HTTP ${response.status}`,
      response.status,
      code,
      answer.details && typeof answer.details === 'object' ? answer.details as Record<string, unknown> : {},
    );
  }
  return answer as T;
}

/** One event as the live stream sends it (`LiveEvent`, src/owner/views.ts). */
export interface LiveEvent {
  id: string;
  type: string;
  taskId: string | null;
  actor: string;
  at: string;
}

/** What a caller of `live` may be told besides each event. */
export interface LiveOptions {
  /**
   * A stream the server will not serve: asked with its status and code, and
   * when it answers true the stream is not tried again (the room stream on a
   * server that has none: its caller falls back). Otherwise it is asked for
   * again, a little later each time, as a dropped stream is.
   */
  refused?: (status: number, code: string | undefined) => boolean;
  /** The stream opened again after the server ended it: what it ended for may have changed who the person is. */
  reopened?: () => void;
  /**
   * Whether the stream is being heard: true once its first bytes arrive,
   * false when it drops or fails and is asked for again. A stream answered
   * but held back -- a proxy that buffers it -- is never heard, so its caller
   * goes on reading on its own clock.
   */
  hearing?: (yes: boolean) => void;
}

/**
 * Listens to a live stream of events (`text/event-stream`) until `signal`
 * aborts. Read with fetch rather than an EventSource, which cannot carry the
 * session's token; a dropped stream is opened again, a little later each
 * time, and signing out ends it.
 *
 * The last `id:` the stream sent is kept in memory, never in the browser's
 * storage, and sent back as `Last-Event-ID` when the stream is opened again,
 * so a room stream picks up where it left off (STATUS 2.210).
 */
export async function live<T = LiveEvent>(
  method: 'GET', path: string, heard: (event: T) => void, signal: AbortSignal, options: LiveOptions = {},
): Promise<void> {
  let wait = 1_000;
  let lastId: string | null = null;
  let opened = false;
  let flowing = false;
  while (!signal.aborted && token) {
    try {
      const response = await fetch(path, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(lastId === null ? {} : { 'last-event-id': lastId }) },
        signal,
      });
      if (response.status === 401) {
        token = null;
        onSignedOut?.();
        return;
      }
      if (!response.ok || !response.body) {
        const answer = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        if (options.refused?.(response.status, typeof answer.code === 'string' ? answer.code : undefined)) return;
        throw new Error(`HTTP ${response.status}`);
      }
      wait = 1_000;
      if (opened) options.reopened?.();
      opened = true;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!flowing) {
          flowing = true;
          options.hearing?.(true);
        }
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = message.split('\n');
          const id = lines.find((line) => line.startsWith('id: '));
          if (id) lastId = id.slice(4);
          const data = lines.filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
          if (data) heard(JSON.parse(data) as T);
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    if (flowing) {
      flowing = false;
      options.hearing?.(false);
    }
    await new Promise<void>((resolve) => {
      const later = window.setTimeout(resolve, wait);
      signal.addEventListener('abort', () => { window.clearTimeout(later); resolve(); }, { once: true });
    });
    wait = Math.min(wait * 2, 30_000);
  }
}

/**
 * A second factor, as the API takes it: a code, a passkey's signature, or one
 * of the owner's recovery codes -- which the API takes only to sign in and to
 * put a new device in a lost one's place.
 */
export type Proof = { totp: string } | { webauthn: PasskeyAssertion } | { recovery: string };

/**
 * The refusals an owner meets in the console, in their language. Anything not
 * here is shown as the API said it: the code is stable, the message carries
 * the particulars, and a translation that dropped them would be worse.
 */
const EXPLAINED: Record<string, string> = {
  'owner.unauthenticated': N('Your session has ended. Sign in again.'),
  'mfa.code_invalid': N('That code is not right. Check the time on your phone and try the current one.'),
  'mfa.replayed': N('That code has already been used. Wait for the next one.'),
  'mfa.locked_out': N('Too many wrong codes. Wait a few minutes before trying again.'),
  'mfa.not_enrolled': N('No authenticator is enrolled on this deployment yet.'),
  'mfa.factor_unavailable': N('The authenticator secret cannot be read on this deployment; ask the operator.'),
  'mfa.unknown_credential': N('That passkey is not enrolled here, or was revoked. Remove it from your device, or use a code.'),
  'mfa.not_user_verified': N('The device did not check it was you. Use your fingerprint, face or PIN when it asks.'),
  'mfa.challenge_unknown': N('That took too long. Try again.'),
  'mfa.wrong_origin': N('This page is not at the address this console\'s passkeys belong to. Open the console at its public address.'),
  'mfa.already_enrolled': N('That passkey is already enrolled.'),
  'mfa.claim_invalid': N('That link has expired or been used. Start PALUGADA again for a new one, or sign in if you are the owner.'),
  'owner.claimed': N('This deployment already has an owner. Sign in with their device.'),
  'inbox.not_open': N('This has already been decided or has closed.'),
  'approval.channel_forbidden': N('This needs your authenticator.'),
  'company.frozen': N('This company is frozen. Unfreeze it in its settings first.'),
  'platform.stopped': N('Everything is stopped. Resume first.'),
  'role.frozen': N('This role is frozen until you resume it.'),
  'spend.paused': N('Spending is paused for this company.'),
  'budget.exceeded': N('That would go over the budget.'),
  'budget.reservation_refused': N('The budget account cannot fund this work yet: its tokens are spent or held. Raise its ceiling under Money, then try again.'),
  'task.not_continuable': N('Only work its budget stopped can be continued. Do anything else again.'),
  'task.record_cleared': N('Retention has cleared what this task\'s run said, so it cannot go on from where it stopped. Run it again instead.'),
  'gateway.key_mismatch': N('That fingerprint is not the key this device holds.'),
  'gateway.not_pairable': N('This device cannot be paired in its current state.'),
  'bundle.bad_signature': N('The bundle signature does not check out.'),
  'publisher.invalid_key': N('That is not a valid publisher key.'),
  'capability.unknown': N('No capability by that name is bound on this deployment.'),
  'goal.required': N('Pick the goal this work serves.'),
  'schedule.still_running': N('This schedule\'s last run has not ended yet. Open it, or run the schedule again once it has.'),
  'company.slug_taken': N('Another company already has this short name. Choose a different one.'),
  // The people's workspace (F19): every refusal it answers with, written before
  // the features that throw them, as the owner API's statuses are.
  'room.not_visible': N('That room is not one you can see.'),
  'room.archived': N('That room is archived.'),
  'room.not_member': N('Join the room first.'),
  'room.too_fast': N('Slow down: too many messages in a minute.'),
  'room.too_many_people': N('A direct message is for two to eight people.'),
  'room.direct_fixed': N('The people of a direct conversation are fixed. Start a new one to add someone.'),
  'room.company_room_stays': N('Everyone stays in the company room.'),
  'room.not_creator': N('Only the room\'s creator, an admin or the owner can change that.'),
  'room.pins_full': N('A room holds fifty pins. Unpin one first.'),
  'mention.room_not_yours': N('Only the owner and approvers can notify the whole room.'),
  'message.not_yours': N('Only its author can change that message.'),
  'message.edit_window': N('A message can be edited for a day after it is sent.'),
  'message.not_the_owners': N('Only the owner\'s own words typed here can be filed as an issue.'),
  'message.files': N('A message carries up to five files, 24 MB in all.'),
  'file.not_kept': N('That file is no longer kept.'),
  'staff.ask_limit': N('You have asked for today\'s share of work. It opens again tomorrow.'),
  'staff.not_ready': N('Work asked by staff is not switched on here yet.'),
  'approval.own_instigation': N('Your words are in this work, so someone else decides its actions.'),
  'name.reserved': N('That name belongs to someone or something else here. Choose another.'),
  'name.taken': N('Someone here has a name that looks like that. Choose another.'),
  'name.owner_sets': N('The owner sets names. Ask them to change yours.'),
  'handle.unusable': N('That handle cannot be used. Choose another.'),
  'auth.handle_locked': N('Too many wrong codes for that handle. Wait a while, then try again.'),
  'meeting.too_many': N('Three meetings have been called today. Call the next one tomorrow.'),
  'meeting.outside_window': N('The meeting hour is outside your hours, so its questions would wait for nobody. Move the meeting or your hours first.'),
  'meeting.no_model': N('No model is set up, so there is no one to hold the meeting.'),
  'people_meeting.past': N('A meeting starts in the future.'),
  'people_meeting.cannot_see': N('Everyone asked must be able to see the room.'),
  'stream.too_many': N('Too many windows are open. Close one and try again.'),
  'relay.unreachable': N('The relay did not answer at that address.'),
  'relay.fingerprint': N('That is not the relay\'s fingerprint.'),
  'relay.fingerprint_short': N('Type at least the first sixteen characters of the fingerprint.'),
  'relay.other_host': N('The relay\'s addresses must be on the host you entered.'),
  'relay.companies': N('Name the companies this relay may hear about.'),
  'relay.owner_device': N('Link your phone with a device key before presses or replies from it count.'),
  'relay.accept': N('The relay did not accept this pairing: check that it is the relay whose fingerprint you compared.'),
  'relay.not_paired': N('That relay is not paired to tell you about this company.'),
  'import.zip': N('That file is not a Slack export PALUGADA can read.'),
  'import.part_missing': N('A part of the export has not arrived yet.'),
  'import.too_large': N('That export unpacks to more than PALUGADA reads at once.'),
  'import.former_linked': N('That person is already linked to a seat.'),
};

/** What went wrong, in words for the owner. */
export function explain(failure: unknown): string {
  if (failure instanceof ApiError && failure.code && EXPLAINED[failure.code]) return t(EXPLAINED[failure.code]!);
  // `fetch` itself failing: the server is down or the network is.
  if (failure instanceof TypeError) return t('Could not reach PALUGADA. Check the connection and try again.');
  return failure instanceof Error ? failure.message : String(failure);
}
