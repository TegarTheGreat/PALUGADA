-- A division's sign-in for a vendor key in flight (RFC 6749, 7636).
--
-- Some vendors take no key a person can paste: Google Calendar and Gmail sign
-- someone in and hand out a token that runs out within the hour. The owner
-- signs a division in from its keys, in their own browser, and the provider
-- sends that browser back to this console's callback with a code. What the
-- callback needs to redeem it is kept here between the two: which division
-- and key it is for, the app registered with the provider, the endpoint, and
-- the PKCE verifier. Kept by the state's hash, not the state, so a reader of
-- this table cannot answer a sign-in; spent on first use, and refused after
-- ten minutes.
--
-- Like mcp_authorizations: read and written by the owner's console on the
-- control plane only, with no row security and no grant to the application
-- role. It names a company and a division, and holds nothing of theirs but
-- which key the owner is signing in for.
CREATE TABLE credential_authorizations (
  state_hash          text PRIMARY KEY,
  company_id          uuid NOT NULL,
  division_id         uuid NOT NULL,
  alias               text NOT NULL,
  provider            text NOT NULL,
  token_url           text NOT NULL,
  client_id           text NOT NULL,
  client_secret_name  text,
  auth_method         text NOT NULL
    CONSTRAINT credential_authorizations_auth_method CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  code_verifier       text NOT NULL,
  redirect_uri        text NOT NULL,
  scope               text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON credential_authorizations TO palugada_admin;
