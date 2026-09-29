-- A sign-in to an MCP server in flight (the MCP authorization spec; RFC 6749,
-- 7636, 8707, 9207).
--
-- Hosted MCP servers answer a client with 401 and name an authorization
-- server; the owner signs in there in their own browser, which is sent back to
-- this console's callback with a code. What the callback needs to redeem it is
-- kept here between the two: the PKCE verifier, the client, the endpoint, and
-- which server it was for. Kept by the state's hash, not the state, so a
-- reader of this table cannot answer a sign-in; spent on first use, and
-- refused after ten minutes.
--
-- The platform's, like worker_heartbeats: no company's data, no row security,
-- and no grant to the application role.
CREATE TABLE mcp_authorizations (
  state_hash          text PRIMARY KEY,
  server_name         text NOT NULL,
  server_url          text NOT NULL,
  resource            text NOT NULL,
  issuer              text NOT NULL,
  token_endpoint      text NOT NULL,
  client_id           text NOT NULL,
  client_secret_name  text,
  auth_method         text NOT NULL
    CONSTRAINT mcp_authorizations_auth_method CHECK (auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  code_verifier       text NOT NULL,
  redirect_uri        text NOT NULL,
  scope               text,
  iss_required        boolean NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON mcp_authorizations TO palugada_admin;
