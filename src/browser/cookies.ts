/**
 * A company's browser's cookies, kept sealed between uses.
 *
 * What a person who signed in to a seller centre or a tax portal has is a
 * cookie; it is as good as their password for as long as it lasts, so it is
 * kept as a secret is: sealed under the deployment's master key, in the
 * database rather than on a disk beside Chromium, under a name of its own
 * (`browser-<company>`) that no division's credential may name. Kept in the
 * database, it is there for every replica and survives a restart, an update
 * and the browser closing -- session cookies too, which Chromium itself drops
 * when it exits.
 *
 * What is not kept: a page's local storage, which a few sites keep a sign-in
 * in. Those sign in again after the browser closes.
 */
import type { MasterKey } from '../settings/store.ts';
import { openForCompany, sealForCompany } from '../settings/store.ts';

/** A cookie as Chromium's DevTools protocol gives it (`Network.Cookie`), as much of it as setting it again takes. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; absent for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  priority?: string;
  sourceScheme?: string;
  sourcePort?: number;
  partitionKey?: unknown;
}

export interface CookieStore {
  load(companyId: string): Promise<StoredCookie[]>;
  /** Answers whether they were kept: a company that is closing keeps none. */
  save(companyId: string, cookies: StoredCookie[]): Promise<boolean>;
}

/** The name a company's cookies are sealed under. */
export function browserSecretName(companyId: string): string {
  return `browser-${companyId.replace(/-/g, '').toLowerCase()}`;
}

/** The most a company's cookies may take sealed: far beyond any real jar, and a bound on one that is not. */
const MAX_JAR_BYTES = 1_000_000;

export function sealedCookies(options: { master: () => MasterKey | null; previous?: () => readonly MasterKey[] }): CookieStore {
  return {
    async load(companyId) {
      const text = await openForCompany(browserSecretName(companyId), options.master(), options.previous?.() ?? []);
      if (!text) return [];
      const parsed = JSON.parse(text) as unknown;
      return Array.isArray(parsed) ? parsed as StoredCookie[] : [];
    },
    async save(companyId, cookies) {
      const master = options.master();
      if (!master) return false;
      const text = JSON.stringify(cookies);
      if (Buffer.byteLength(text) > MAX_JAR_BYTES) return false;
      return sealForCompany(browserSecretName(companyId), text, master, companyId);
    },
  };
}

/**
 * The cookies worth keeping, as setting them again takes them: not one that
 * has expired, and without what Chromium reports but does not take back.
 */
export function keepable(cookies: ReadonlyArray<StoredCookie & { session?: boolean; size?: number }>, now = Date.now()): StoredCookie[] {
  return cookies
    .filter((cookie) => cookie.session || !cookie.expires || cookie.expires <= 0 || cookie.expires * 1000 > now)
    .map(({ session, size: _size, expires, ...rest }) => ({ ...rest, ...(session || !expires || expires <= 0 ? {} : { expires }) }))
    .sort((a, b) => `${a.domain}\u0000${a.path}\u0000${a.name}`.localeCompare(`${b.domain}\u0000${b.path}\u0000${b.name}`));
}
