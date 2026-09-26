-- ---------------------------------------------------------------------------
-- Triggers the sender signs
--
-- A trigger took one kind of caller: one that sends a bearer token. The
-- services a company most needs to hear from do not work that way. Stripe,
-- GitHub, Slack, and every sender built on Standard Webhooks (Svix, Resend,
-- Clerk and others) sign each delivery with an HMAC over the body, and none of
-- them can be told to send a token instead -- so a company could not be woken
-- by a payment, which is the event it most wants to be woken by.
--
-- scheme: how a delivery proves where it came from. 'bearer' is the token of
-- 0054; the others are the named sender's signature, checked over the body
-- exactly as it arrived.
--
-- secret_ref: where the signing secret lives, as a reference the deployment's
-- secret store resolves (env://, file://), like every other credential in the
-- platform. Stripe issues its own signing secret, so the platform cannot mint
-- it the way it mints a token, and a secret that must be read back to check a
-- signature cannot be kept as a hash. A reference is what the database holds
-- for every other secret, and so it is what it holds here.
-- ---------------------------------------------------------------------------

ALTER TABLE triggers
  ADD COLUMN scheme text NOT NULL DEFAULT 'bearer',
  ADD COLUMN secret_ref text,
  ADD CONSTRAINT triggers_scheme_known
    CHECK (scheme IN ('bearer', 'github', 'stripe', 'slack', 'standard')),
  -- A bearer trigger has a token and no secret; a signed one, the reverse.
  ADD CONSTRAINT triggers_secret_matches_scheme
    CHECK ((scheme = 'bearer') = (secret_ref IS NULL)),
  ADD CONSTRAINT triggers_secret_ref_shape
    CHECK (secret_ref IS NULL OR secret_ref ~ '^[a-z0-9-]+://.+');
