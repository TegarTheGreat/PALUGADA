-- ---------------------------------------------------------------------------
-- The owner's second factor (PRD v2 F12.5, F10.10)
--
-- F12.5 is a P0 and it had never been built, on the grounds that MFA lives in
-- an application this repository does not have. Half of that was true and the
-- wrong half was acted on: the *client* is an application, but verifying a
-- second factor is arithmetic, and arithmetic is exactly what a control plane
-- should be doing rather than trusting a caller's word for. `decide` took an
-- `assurance: 'mfa'` string that nothing checked, so F10.10's "tier 3 only
-- through the app with MFA" reduced to "tier 3 for anyone who says mfa".
--
-- Two kinds of factor, because F12.5 names two things:
--
--   * `totp`  -- RFC 6238. A shared secret and a clock. What an owner enrols
--               from an authenticator app.
--   * `webauthn` -- a public key. This is "mobile biometrik": the phone holds
--               the private key behind a fingerprint or a face, signs a
--               challenge, and what arrives here is a signature that can only
--               have come from that device.
--
-- The owner is the platform's single human (§5 principle 1), so these rows are
-- platform-scoped -- `company_id IS NULL` -- and follow `config_versions`:
-- readable by nobody in the application role, written only by the control
-- plane. An agent that could read a TOTP secret could mint its own approvals,
-- and an agent that could insert an authenticator could enrol itself as the
-- owner's phone. Neither is a hypothetical: the whole of F10.10 is that the
-- thing approving a tier 3 action is a person.
-- ---------------------------------------------------------------------------

CREATE TABLE owner_authenticators (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL is the platform's owner. The column exists so a deployment that one
  -- day has per-company owners does not need a second table, and so every
  -- query here reads like every other platform-scoped one.
  company_id     uuid REFERENCES companies(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('totp', 'webauthn')),
  label          text NOT NULL,

  -- A reference, never a value (F12.1). The TOTP shared secret is a secret in
  -- exactly the sense F12.1 means, so it lives in the secret manager and this
  -- column holds the pointer. A WebAuthn credential's public key is not a
  -- secret and is stored inline.
  secret_ref     text,
  public_key     text,
  credential_id  text,

  -- Replay defence, and the reason both kinds need a row rather than a
  -- verifier function. A TOTP code is valid for a whole step, so a code
  -- observed in transit can be replayed within that window unless the step it
  -- came from is remembered. A WebAuthn authenticator counts its own
  -- signatures, and a counter that fails to advance means the assertion was
  -- replayed or the key was cloned.
  last_step      bigint,
  sign_count     bigint NOT NULL DEFAULT 0,

  enrolled_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz,

  CONSTRAINT owner_authenticators_totp_has_a_secret
    CHECK (kind <> 'totp' OR secret_ref IS NOT NULL),
  CONSTRAINT owner_authenticators_webauthn_has_a_key
    CHECK (kind <> 'webauthn' OR (public_key IS NOT NULL AND credential_id IS NOT NULL)),
  -- A secret pasted in where a reference belongs is the failure F12.1 exists
  -- to prevent, and it is invisible: the column would work perfectly.
  CONSTRAINT owner_authenticators_ref_is_not_inline_secret
    CHECK (secret_ref IS NULL OR secret_ref ~ '^[a-z][a-z0-9+.-]*://')
);

CREATE UNIQUE INDEX owner_authenticators_credential_idx
  ON owner_authenticators (credential_id)
  WHERE credential_id IS NOT NULL;

ALTER TABLE owner_authenticators ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_authenticators FORCE ROW LEVEL SECURITY;

-- No policy for `palugada_app` and no grant. The application role cannot see
-- these rows at all, which is stronger than a policy that lets it read its own
-- company's: there is nothing here an agent has any business reading.
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_authenticators TO palugada_admin;

-- ---------------------------------------------------------------------------
-- The record of a second factor being used.
--
-- Separate from `events` because an event is company-scoped and an
-- authentication is not, and because this is the table an auditor reads when
-- asking "was the owner really there". A failed attempt is recorded as well as
-- a successful one: a burst of failures against the owner's authenticator is
-- the shape of somebody trying, and a log that only kept successes would hide
-- exactly that.
-- ---------------------------------------------------------------------------

CREATE TABLE owner_authentications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  authenticator_id uuid REFERENCES owner_authenticators(id) ON DELETE SET NULL,
  kind             text NOT NULL,
  succeeded        boolean NOT NULL,
  -- Why it failed, in the platform's own vocabulary: `mfa.code_invalid`,
  -- `mfa.replayed`, `mfa.counter_did_not_advance`, and so on. NULL on success.
  reason           text,
  -- What the factor was presented for, so an auditor can join an
  -- authentication to the decision it authorised.
  purpose          text,
  subject_id       uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX owner_authentications_recent_idx
  ON owner_authentications (occurred_at DESC);

ALTER TABLE owner_authentications ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_authentications FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON owner_authentications TO palugada_admin;
