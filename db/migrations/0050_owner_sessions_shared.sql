-- ---------------------------------------------------------------------------
-- The owner's sessions, where every process can see them
--
-- Sessions were held in each process's memory. That kept them from outliving
-- a restart, and it made them a property of one process: a deployment with a
-- second console behind the same address signed the owner in to one replica
-- and answered "sign in first" from the other, and a device revoked on one
-- process went on being signed in on every other until its sessions expired.
--
-- So they live here. What is stored is a hash of the token, never the token:
-- a row read out of a backup is not a way in. A session ends when it is
-- signed out, when its time is up, or -- checked at every request, not
-- remembered -- when the device that signed it in is revoked, by whichever
-- process and whatever path revoked it.
--
-- The control plane's alone, like the authenticators it hangs from (0033).
-- ---------------------------------------------------------------------------

CREATE TABLE owner_sessions (
  token_hash       text PRIMARY KEY,
  authenticator_id uuid NOT NULL REFERENCES owner_authenticators(id) ON DELETE CASCADE,
  issued_at        timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  ended_at         timestamptz,
  CONSTRAINT owner_sessions_end_after_start CHECK (expires_at > issued_at)
);

CREATE INDEX owner_sessions_live_by_factor
  ON owner_sessions (authenticator_id) WHERE ended_at IS NULL;

-- As with the authenticators (0033): "nobody" said out loud, and no grant for
-- the application role, so an agent cannot see that a session exists, let
-- alone mint one. The control plane reaches it by being BYPASSRLS.
ALTER TABLE owner_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON owner_sessions
  USING (false)
  WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON owner_sessions TO palugada_admin;
