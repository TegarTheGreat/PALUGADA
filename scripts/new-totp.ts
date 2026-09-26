/**
 * Prints a new TOTP secret for the owner's first factor.
 *
 * A fresh deployment has no enrolled authenticator, and the console takes a
 * code to sign in -- so the first one comes from configuration. Run this, put
 * the secret where `PALUGADA_OWNER_TOTP_REF` points (an environment variable
 * named `PALUGADA_SECRET_*`, or a file under `/run/secrets`), and add the URI to
 * an authenticator app. Nothing is written anywhere by this script: the
 * secret exists on this terminal and in the operator's hands only.
 */
import { newTotpSecret } from '../src/owner/mfa.ts';

const label = process.argv[2] ?? 'owner';
const { secret, uri } = newTotpSecret(label);
process.stdout.write(
  [
    '# Add to the deployment environment (or write the secret to /run/secrets/owner-totp',
    '# and use PALUGADA_OWNER_TOTP_REF=file:///run/secrets/owner-totp instead):',
    `PALUGADA_SECRET_OWNER_TOTP=${secret}`,
    'PALUGADA_OWNER_TOTP_REF=env://PALUGADA_SECRET_OWNER_TOTP',
    '',
    '# And add this to your authenticator app (most accept it as a QR code or a link):',
    uri,
    '',
  ].join('\n'),
);
