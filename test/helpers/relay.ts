/**
 * The relay's steps a test takes through the owner API, as the owner and a
 * relay would take them (F19.19, F19.20; STATUS section 2.208): a relay added
 * and paired, a phone linked through it, the owner's items handed to it and
 * the outbox sent.
 */
import assert from 'node:assert/strict';
import type { KeyObject } from 'node:crypto';
import { RelayChannel } from '../../src/relay/channel.ts';
import { relayPass } from '../../src/relay/loop.ts';
import { dispatch } from '../../src/owner/notify.ts';
import type { MasterKey } from '../../src/settings/store.ts';
import type { consoleWithSettings } from './owner-console.ts';
import { deviceKey, type FakeRelay } from './fake-relay.ts';

export type Console = Awaited<ReturnType<typeof consoleWithSettings>>;

/** A relay the owner added and paired, with the settings the test asks for. Answers its id. */
export async function pairThrough(
  api: Console,
  token: string,
  relay: FakeRelay,
  options: {
    companies: string[] | 'all';
    share?: 'signal' | 'summary' | 'content';
    mayPress?: boolean;
    mayPost?: boolean;
    mode?: 'push' | 'pull';
  },
): Promise<string> {
  const added = await api.call('POST', '/api/control/relays', token, { url: relay.url });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const relayId = String(added.body.relay.id);
  const paired = await api.call('POST', `/api/control/relays/${relayId}/pair`, token, {
    fingerprint: relay.fingerprint.slice(0, 16), companies: options.companies, proof: { totp: api.code() },
  });
  assert.equal(paired.status, 200, JSON.stringify(paired.body));
  const changes = {
    ...(options.share ? { share: options.share } : {}),
    ...(options.mayPress !== undefined ? { mayPress: options.mayPress } : {}),
    ...(options.mayPost !== undefined ? { mayPost: options.mayPost } : {}),
    ...(options.mode ? { mode: options.mode } : {}),
  };
  if (Object.keys(changes).length > 0) {
    const set = await api.call('POST', `/api/control/relays/${relayId}/settings`, token, { ...changes, proof: { totp: api.code() } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  return relayId;
}

export interface Linked {
  linkId: string;
  recipient: string;
  companies: string[];
  device: { privateKey: KeyObject; publicKey: Buffer } | null;
}

/**
 * A phone linked through a relay: the person asks for a code (the owner with
 * a fresh factor), and the relay claims it, with a device key when asked.
 */
export async function linkThrough(
  api: Console,
  token: string,
  relay: FakeRelay,
  relayId: string,
  options: { device?: boolean; owner?: boolean; share?: 'signal' | 'summary' | 'content' } = {},
): Promise<Linked> {
  const owner = options.owner ?? true;
  const offered = await api.call('POST', '/api/relays/links', token, {
    relayId, ...(options.share ? { share: options.share } : {}), ...(owner ? { proof: { totp: api.code() } } : {}),
  });
  assert.equal(offered.status, 200, JSON.stringify(offered.body));
  assert.match(String(offered.body.code), /^[A-Z2-7]{8}$/);
  const device = options.device ? deviceKey() : null;
  const claimed = await relay.push(api.url, relayId, relay.sign({
    v: 1, type: 'link_claim', at: new Date().toISOString(), code: offered.body.code, label: 'Test phone',
    ...(device ? { device_key: device.publicKey.toString('base64url') } : {}),
  }));
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  return {
    linkId: String(offered.body.linkId),
    recipient: String(claimed.body.result.recipient),
    companies: claimed.body.result.companies as string[],
    device,
  };
}

/** The owner's items in one company handed to a relay, as the worker's notify stage hands them, past the owner's window. */
export async function handToRelay(companyId: string, relayId: string, options: { now?: Date; link?: boolean } = {}) {
  const channel = new RelayChannel(relayId);
  await channel.prepare();
  return dispatch(companyId, channel, {
    now: options.now ?? tomorrow(),
    ...(options.link === false ? {} : { linkFor: (item) => `https://palugada.example/?company=${item.companyId}&item=${item.id}` }),
  });
}

/** One pass of the relay loop, with the deployment's key from the console's master key. */
export async function sendOutbox(master: MasterKey, now = new Date()) {
  return relayPass({ master: () => master, now, pullWaitSeconds: 0, awaitPulls: true });
}

/** Two days on: past the next opening of the owner's window, so nothing an item waits for holds it back. */
export function tomorrow(): Date {
  return new Date(Date.now() + 48 * 60 * 60_000);
}
