/**
 * The relay (F19.19, F19.20): this deployment's identity, pairing a relay and
 * its settings, a person's linked phone, and what a paired relay posts back.
 *
 * A route module of the people's workspace (`../route.ts`): the relay's core
 * writes its routes here (STATUS section 2.208). `#buildRoutes` in `../api.ts`
 * serves them beside the owner API's own, and what a staff seat may reach of
 * them is this area's block in `../staff-policy.ts`: a seat links its own
 * phone and nothing else; pairing, settings and the key are the owner's.
 *
 * Only the owner's actions that need the relay's own answer talk to it here:
 * reading its document, and its accept of a pairing. Everything else a relay
 * is owed is written to the outbox and sent by the relay loop, so no request
 * waits on a relay.
 */
import type { IncomingMessage } from 'node:http';
import { PalugadaError } from '../../errors.ts';
import { principalOf } from '../../workspace/principal.ts';
import { ensureIdentity, identityView, rotateIdentity } from '../../relay/identity.ts';
import { INBOUND_MAX_BYTES, MinuteThrottle, receiveFromRelay, signedByAPairedRelay } from '../../relay/inbound.ts';
import { assertLinkable, endLink, linksOf, offerLink, openNotice, type Linker } from '../../relay/links.ts';
import {
  addRelay, announceRotation, applyRelaySettings, pairRelay, pairingTerms, pingRelay, planRelaySettings, relaysPage, retryDead, revokeRelay,
} from '../../relay/relays.ts';
import { WithStatus, type Route, type RouteContext, type RouteKit } from '../route.ts';

/** Every route of the relay, and of a person's linked phone. */
export function relayRoutes(kit: RouteKit): Route[] {
  // The open door is held before anything is read from the database: sixty
  // envelopes a minute from one address, six hundred for the route as a
  // whole. Per process, as the sign-in throttle is.
  const perAddress = new MinuteThrottle(60);
  const perRoute = new MinuteThrottle(600);
  const master = () => kit.options.deploymentSettings?.master(true) ?? null;
  const linker = (context: RouteContext): Linker => ({
    principal: principalOf(context.session, context.staff).principal,
    companyId: context.staff?.seat.companyId ?? null,
  });

  return [
    {
      // What a relay reads before the owner pairs it: this deployment's
      // public key, its id and its fingerprint. Open, and nothing on it is a
      // secret; the key is made the first time anything asks.
      method: 'GET',
      pattern: '/api/relay/v1/identity',
      open: true,
      handle: async () => identityView(await ensureIdentity(master())),
    },

    {
      // A paired relay's push: signed envelopes, read as the bytes that were
      // signed. Open; the relay's signature stands in for a session, and
      // nothing is written for one that does not verify.
      method: 'POST',
      pattern: '/api/relay/v1/relays/:relayId/inbound',
      open: true,
      raw: true,
      maxBodyBytes: INBOUND_MAX_BYTES,
      handle: async ({ request, params, raw }) => {
        const header = (name: string) => {
          const value = request.headers[name];
          return Array.isArray(value) ? value.join(' ') : value ?? '';
        };
        const envelope = { id: header('webhook-id'), timestamp: header('webhook-timestamp'), signature: header('webhook-signature'), body: raw };
        // A push a relay paired here signed, now, goes to that relay's own
        // sixty a minute; only the rest are counted against an address and
        // the route, so strangers who fill the route lock out strangers, not
        // a paired relay (STATUS section 2.216). The signature is checked
        // against keys this process holds, with nothing read.
        if (!await signedByAPairedRelay(params.relayId!, envelope)) {
          const address = addressOf(request, kit.options.behindProxy === true);
          if (!perAddress.admit(address)) {
            return new WithStatus(429, { ok: false, code: 'relay.throttled' }, { 'retry-after': String(perAddress.retryAfter(address)) });
          }
          if (!perRoute.admit('route')) {
            return new WithStatus(429, { ok: false, code: 'relay.throttled' }, { 'retry-after': String(perRoute.retryAfter('route')) });
          }
        }
        const answer = await receiveFromRelay(params.relayId!, envelope);
        return new WithStatus(answer.status, answer.body, answer.retryAfter ? { 'retry-after': String(answer.retryAfter) } : {});
      },
    },

    {
      method: 'GET',
      pattern: '/api/control/relays',
      handle: async () => {
        const view = identityView(await ensureIdentity(master()));
        return { deployment: { key: view.key, kid: view.kid, fingerprint: view.fingerprint, previous: view.previous }, relays: await relaysPage() };
      },
    },

    {
      method: 'POST',
      pattern: '/api/control/relays',
      handle: async ({ body }) => ({ relay: await addRelay(body.url) }),
    },

    {
      // Pairing makes a relay's envelopes count and starts telling it the
      // owner's items, so it takes a code given now, as pairing a device does,
      // whatever the session was signed in with. What the owner typed and
      // chose is checked first: a mistake costs a correction, not a code.
      method: 'POST',
      pattern: '/api/control/relays/:relayId/pair',
      handle: async (context) => {
        const terms = await pairingTerms(context.params.relayId!, context.body);
        await kit.requireFactor(context, 'pair a relay', true);
        const relay = await pairRelay(context.params.relayId!, terms, master());
        // The worker's channels are made when the process starts: a soft
        // start puts this relay among them.
        return { relay, ...kit.applySettings() };
      },
    },

    {
      // Widening what a relay is told or may do takes the device again;
      // narrowing takes the session, and voids what it no longer allows.
      method: 'POST',
      pattern: '/api/control/relays/:relayId/settings',
      handle: async (context) => {
        const { loosens, changes } = await planRelaySettings(context.params.relayId!, context.body);
        if (loosens) await kit.requireFactor(context, 'widen what a relay is told or may do', true);
        return { relay: await applyRelaySettings(context.params.relayId!, changes) };
      },
    },

    {
      method: 'POST',
      pattern: '/api/control/relays/:relayId/test',
      handle: async ({ params }) => pingRelay(params.relayId!),
    },

    {
      method: 'POST',
      pattern: '/api/control/relays/:relayId/retry',
      handle: async ({ params }) => retryDead(params.relayId!),
    },

    {
      // Taking away needs no factor: a relay the owner no longer trusts ends
      // at once, from whatever device the owner has.
      method: 'POST',
      pattern: '/api/control/relays/:relayId/revoke',
      handle: async ({ params }) => {
        await revokeRelay(params.relayId!);
        return { ok: true };
      },
    },

    {
      // A new key for the deployment, with a code given now: every relay is
      // told in an envelope both keys sign, and the old one signs beside the
      // new for a week.
      method: 'POST',
      pattern: '/api/control/relay-identity/rotate',
      handle: async (context) => {
        await kit.requireFactor(context, 'rotate the deployment\'s relay key', true);
        const identity = await rotateIdentity(master());
        await announceRotation(identity);
        return identityView(identity);
      },
    },

    {
      // A person's own links, and the relays they may link a phone through,
      // by name only.
      method: 'GET',
      pattern: '/api/relays/links',
      handle: async (context) => linksOf(linker(context)),
    },

    {
      // A code for the person's phone. The owner's phone may decide things,
      // so linking it takes a code given now; a seat's takes its session.
      method: 'POST',
      pattern: '/api/relays/links',
      handle: async (context) => {
        const who = linker(context);
        const relayId = String(context.body.relayId ?? '');
        await assertLinkable(who, relayId);
        if (who.principal === 'owner') await kit.requireFactor(context, 'link a phone', true);
        return offerLink(who, relayId, context.body.share);
      },
    },

    {
      // What a notice's link opens: the link a relay is sent names only a
      // handle, and this answers what it is about, to the person it was for
      // and nobody else (STATUS section 2.216).
      method: 'GET',
      pattern: '/api/relays/notices/:handle',
      handle: async (context) => openNotice(context.params.handle!, linker(context)),
    },

    {
      method: 'POST',
      pattern: '/api/relays/links/:linkId/end',
      handle: async (context) => {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.params.linkId!)) {
          throw new PalugadaError('contract.violation', 'a link is named by its id', {});
        }
        await endLink(context.params.linkId!, linker(context));
        return { ok: true };
      },
    },
  ];
}

/** Who is asking: the connection's address, or behind a proxy the one it vouches for, as sign-in reads it. */
function addressOf(request: IncomingMessage, behindProxy: boolean): string {
  if (behindProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').at(-1)?.trim();
    if (last) return last;
  }
  return request.socket.remoteAddress ?? 'unknown';
}
