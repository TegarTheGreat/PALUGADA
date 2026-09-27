/**
 * Passkeys in this browser (PRD v2 F12.5).
 *
 * The browser and the device do the cryptography. This file converts between
 * what they take and give back -- bytes -- and what the API speaks -- base64url
 * text -- and turns the browser's failures, which are named for programmers,
 * into sentences the owner can act on.
 */
import { t } from './i18n.ts';

/** Where the API says passkeys for this console are made and used. */
export interface RelyingParty {
  rpId: string;
  origin: string;
}

/** What `/api/mfa/passkeys/options` answers. */
export interface PasskeyOptions {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  algorithms: number[];
  exclude: string[];
  timeoutMs: number;
}

export interface PasskeyAssertion {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

export interface NewPasskey {
  id: string;
  clientDataJSON: string;
  attestationObject: string;
}

/**
 * Whether this browser can use a passkey at all here. Browsers only offer
 * them on a secure page -- HTTPS, or `localhost` -- so a console opened over
 * plain HTTP from another machine has none, whatever the device can do.
 */
export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === 'function' && window.isSecureContext;
}

/**
 * Whether this page is where the console's passkeys belong. A passkey is
 * bound to one site, and a console reached by another name -- an address
 * rather than its domain, say -- cannot use them.
 */
export function atPasskeyAddress(party: RelyingParty): boolean {
  return window.location.origin === party.origin;
}

function elsewhere(party: RelyingParty): Error {
  return new Error(t('Passkeys for this console work at {origin}. Open it there, or use a code.', { origin: party.origin }));
}

/** Asks the owner's device to sign a challenge: signing in, or confirming. */
export async function presentPasskey(challenge: RelyingParty & { challenge: string }): Promise<PasskeyAssertion> {
  if (!atPasskeyAddress(challenge)) throw elsewhere(challenge);
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: {
        challenge: bytes(challenge.challenge),
        rpId: challenge.rpId,
        userVerification: 'required',
        timeout: 120_000,
      },
    });
  } catch (failure) {
    throw new Error(browserSaid(failure));
  }
  if (!(credential instanceof PublicKeyCredential)) throw new Error(t('The passkey was not used. Try again, or use a code.'));
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    credentialId: text(credential.rawId),
    authenticatorData: text(response.authenticatorData),
    clientDataJSON: text(response.clientDataJSON),
    signature: text(response.signature),
  };
}

/**
 * Asks the owner's device to make a passkey for this console.
 *
 * A discoverable one -- kept on the device with the console's name -- because
 * signing in names nobody: there are no accounts, so the device has to offer
 * the passkey without being told which. And verified by a person every time,
 * which is what the platform checks.
 */
export async function makePasskey(options: PasskeyOptions, party: RelyingParty): Promise<NewPasskey> {
  if (!atPasskeyAddress(party)) throw elsewhere(party);
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: {
        challenge: bytes(options.challenge),
        rp: options.rp,
        user: { id: bytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
        pubKeyCredParams: options.algorithms.map((alg) => ({ type: 'public-key', alg })),
        excludeCredentials: options.exclude.map((id) => ({ type: 'public-key', id: bytes(id) })),
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        attestation: 'none',
        timeout: options.timeoutMs,
      },
    });
  } catch (failure) {
    throw new Error(browserSaid(failure));
  }
  if (!(credential instanceof PublicKeyCredential)) throw new Error(t('The passkey was not made. Try again.'));
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: text(credential.rawId),
    clientDataJSON: text(response.clientDataJSON),
    attestationObject: text(response.attestationObject),
  };
}

/**
 * The browser refuses in one of a handful of named ways, and each has a
 * different next step. `NotAllowedError` covers both "the owner cancelled" and
 * "it timed out" on purpose -- a page is not told which -- so the sentence
 * fits both.
 */
function browserSaid(failure: unknown): string {
  const name = failure instanceof DOMException ? failure.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return t('The passkey was not used. Try again, or use a code.');
  if (name === 'InvalidStateError') return t('This device already holds a passkey for this console.');
  if (name === 'SecurityError') return t('This browser will not use a passkey at this address.');
  if (name === 'NotSupportedError') return t('This device cannot make a passkey this console accepts.');
  return failure instanceof Error ? failure.message : String(failure);
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

function text(buffer: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
