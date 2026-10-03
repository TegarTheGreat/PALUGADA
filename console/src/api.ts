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

/**
 * Listens to a live stream of events (`text/event-stream`) until `signal`
 * aborts. Read with fetch rather than an EventSource, which cannot carry the
 * session's token; a dropped stream is opened again, a little later each
 * time, and signing out ends it.
 */
export async function live(method: 'GET', path: string, heard: (event: LiveEvent) => void, signal: AbortSignal): Promise<void> {
  let wait = 1_000;
  while (!signal.aborted && token) {
    try {
      const response = await fetch(path, { method, headers: { authorization: `Bearer ${token}` }, signal });
      if (response.status === 401) {
        token = null;
        onSignedOut?.();
        return;
      }
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      wait = 1_000;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const message = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = message.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n');
          if (data) heard(JSON.parse(data) as LiveEvent);
        }
      }
    } catch {
      if (signal.aborted) return;
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
  'gateway.key_mismatch': N('That fingerprint is not the key this device holds.'),
  'gateway.not_pairable': N('This device cannot be paired in its current state.'),
  'bundle.bad_signature': N('The bundle signature does not check out.'),
  'publisher.invalid_key': N('That is not a valid publisher key.'),
  'capability.unknown': N('No capability by that name is bound on this deployment.'),
  'goal.required': N('Pick the goal this work serves.'),
  'schedule.still_running': N('This schedule\'s last run has not ended yet. Open it, or run the schedule again once it has.'),
  'company.slug_taken': N('Another company already has this short name. Choose a different one.'),
};

/** What went wrong, in words for the owner. */
export function explain(failure: unknown): string {
  if (failure instanceof ApiError && failure.code && EXPLAINED[failure.code]) return t(EXPLAINED[failure.code]!);
  // `fetch` itself failing: the server is down or the network is.
  if (failure instanceof TypeError) return t('Could not reach PALUGADA. Check the connection and try again.');
  return failure instanceof Error ? failure.message : String(failure);
}
