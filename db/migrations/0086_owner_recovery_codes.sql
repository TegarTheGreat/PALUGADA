-- Recovery codes: the owner's way back in when their phone is gone (F12.5).
--
-- The owner's authenticator is the only way in, and losing it meant an
-- operator at the server's shell making a new secret. An owner travelling
-- with a laptop has no shell. So, as GitHub, Google and every bank do, the
-- owner can make ten codes, written down on the day, each good once.
--
-- A code is weaker than a phone behind a fingerprint -- it is paper in a
-- drawer -- so it signs in, adds a device, takes a lost one off and makes new
-- codes, and nothing else: the application refuses it for an approval or for
-- loosening a rule (src/owner/mfa.ts).
--
-- The codes are one authenticator, of a new kind, so a session signed in with
-- one is a session like any other, and revoking the authenticator ends every
-- code and every session they signed in. Each code is kept as its SHA-256:
-- eighty random bits are beyond guessing from a backup, as a session token's
-- are (0050).

ALTER TABLE owner_authenticators DROP CONSTRAINT owner_authenticators_kind_check;
ALTER TABLE owner_authenticators
  ADD CONSTRAINT owner_authenticators_kind_check CHECK (kind IN ('totp', 'webauthn', 'recovery'));

CREATE TABLE owner_recovery_codes (
  code_hash         text PRIMARY KEY,
  authenticator_id  uuid NOT NULL REFERENCES owner_authenticators (id) ON DELETE CASCADE,
  used_at           timestamptz,
  CONSTRAINT owner_recovery_codes_hash CHECK (code_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX owner_recovery_codes_by_authenticator ON owner_recovery_codes (authenticator_id);

-- As with the authenticators and the sessions (0033, 0050): nobody but the
-- control plane, said out loud.
ALTER TABLE owner_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_recovery_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON owner_recovery_codes
  USING (false)
  WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_recovery_codes TO palugada_admin;
