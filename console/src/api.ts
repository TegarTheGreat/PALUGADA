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

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | undefined) {
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
    );
  }
  return answer as T;
}

/** A second factor, as the API takes it. */
export interface Proof {
  totp: string;
}
