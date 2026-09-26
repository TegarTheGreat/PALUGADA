-- What the owner sets for the whole deployment from the console: the model,
-- the agent CLIs, the channels. Each used to be an environment variable only
-- an operator with a shell could set, and a restart to take effect.
--
-- deployment_settings holds the values, one row per area, as the console
-- sent them; the environment is the floor they are laid over. Keys, tokens
-- and passwords are never here: they go to deployment_secrets, sealed with
-- AES-256-GCM under a key that is not in the database (PALUGADA_MASTER_KEY,
-- or a file beside the deployment), so a copy of the database is not a copy
-- of every provider key the company pays for. A setting names its secret as
-- db://<name>, like any other secret reference.
--
-- Both belong to the one owner and no company, so neither has row security;
-- and the application role, which agents' work runs as, has no grant on
-- either -- an agent that could read a provider key could spend it, and one
-- that could write a setting could choose its own model or runtime.

CREATE TABLE deployment_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_settings_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  CONSTRAINT deployment_settings_value_object CHECK (jsonb_typeof(value) = 'object')
);

CREATE TABLE deployment_secrets (
  name        text PRIMARY KEY,
  nonce       bytea NOT NULL,
  ciphertext  bytea NOT NULL,
  tag         bytea NOT NULL,
  -- Which key sealed it, so a changed master key is a clear refusal rather
  -- than an authentication failure that reads like tampering.
  key_id      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_secrets_name_shape CHECK (name ~ '^[a-z][a-z0-9-]{0,62}$'),
  CONSTRAINT deployment_secrets_nonce_length CHECK (octet_length(nonce) = 12),
  CONSTRAINT deployment_secrets_tag_length CHECK (octet_length(tag) = 16)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON deployment_settings, deployment_secrets TO palugada_admin;
