-- ---------------------------------------------------------------------------
-- Trusted publishers (PRD v2 F16.2, F12.10, F15.8)
--
-- A signature was being verified against a public key carried in the same
-- payload as the signature. That proves the payload is internally consistent
-- and nothing whatever about who published it: anyone could generate a keypair,
-- sign their own bundle, and have it install unquarantined with tier 2 grants.
-- The quarantine that F12.10 and F15.8 exist to impose was one `generateKeyPair`
-- away from being skipped.
--
-- A signature is only evidence when the verifier already knows the key. So the
-- installation keeps a list, the owner adds to it, and a signature from a key
-- that is not on it counts as *unsigned* rather than as an error — an unknown
-- publisher is precisely the "nobody here has vouched for it" case quarantine
-- is for. A signature that does not verify at all stays an outright refusal,
-- because a false claim of provenance is worse than no claim.
--
-- Trust is keyed on the fingerprint rather than the PEM: the same key can be
-- serialised more than one way, and a list somebody could bypass by
-- re-encoding a key would be a list in name only.
--
-- Platform-level, like the bundle catalogue it guards, and with no application
-- grant at all: an agent that could add a publisher could vouch for its own
-- payload, which is the attack this table exists to stop.
-- ---------------------------------------------------------------------------

CREATE TABLE trusted_publishers (
  fingerprint text PRIMARY KEY,
  label       text NOT NULL,
  public_key  text NOT NULL,
  -- Who added it and when. A trust decision without a record of who made it is
  -- a trust decision nobody can revisit.
  added_by    text NOT NULL DEFAULT 'owner',
  added_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CONSTRAINT trusted_publishers_fingerprint_shape CHECK (fingerprint ~ '^[0-9a-f]{16,64}$')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON trusted_publishers TO palugada_admin;

-- Bundles record whether their publisher was trusted at the moment of
-- publication, so a later revocation is visible against what is installed
-- rather than silently rewriting history. Install still asks the live list:
-- trusting a publisher afterwards should let the next install through without
-- anybody having to republish.
ALTER TABLE bundles ADD COLUMN publisher_fingerprint text;
