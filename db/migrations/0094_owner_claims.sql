-- The first owner, without a secret in the environment (F12.5).
--
-- Signing in takes the owner's authenticator, and the first one came only
-- from PALUGADA_OWNER_TOTP_REF: a base32 secret the operator made in a
-- terminal and put in the environment. A platform that runs the image --
-- Coolify, Dokploy -- offers neither. So a deployment with no owner makes a
-- claim when it starts and prints its code in its log; whoever opens the
-- link first adds the one authenticator and is signed in.
--
-- The code is 160 random bits, kept as its SHA-256 like a session token
-- (0050). A claim lasts a day. The secret it offers is derived from the
-- master key and the claim's id, so it is not kept here, and opening the
-- link twice shows the same one. Every claim is spent once the deployment
-- has an owner, and the application refuses a claim while any live
-- authenticator of the owner's exists, whatever this table says.

CREATE TABLE owner_claims (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash   text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_claims_hash CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

-- As with the authenticators, the sessions and the recovery codes (0033,
-- 0050, 0086): nobody but the control plane, said out loud.
ALTER TABLE owner_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON owner_claims
  USING (false)
  WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_claims TO palugada_admin;
