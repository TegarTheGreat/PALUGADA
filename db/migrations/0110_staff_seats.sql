-- Staff seats beside the one owner (the analysis of 3 October, §9 P2 item
-- 18): a viewer, and an approver for tier 2 and below.
--
-- A seat is kept apart from the owner's factors altogether. It is not a row
-- in `owner_authenticators`: every check of the owner's second factor, and
-- the tier 3 gate, reads that table, and a staff member's code found there
-- would pass them as the owner's. A seat has its own authenticator (its TOTP
-- secret sealed like the owner's, by reference) and its own sessions, and
-- nothing that verifies the owner ever reads either.
--
-- A seat is one company's. It is made by the owner with their device and
-- carries an invite -- 160 random bits, kept only as their SHA-256, good for
-- a week and spent by joining -- whose opener adds a secret of their own to
-- their authenticator app.

CREATE TABLE staff_seats (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind              text NOT NULL CHECK (kind IN ('viewer', 'approver')),
  invite_hash       text,
  invite_expires_at timestamptz,
  -- The sealed secret, as a reference (`db://staff-totp-...`), once joined.
  secret_ref        text,
  -- The newest TOTP step accepted, so a code is used once.
  last_step         bigint,
  joined_at         timestamptz,
  last_used_at      timestamptz,
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_seats_joined_has_secret CHECK ((joined_at IS NULL) = (secret_ref IS NULL))
);
CREATE UNIQUE INDEX staff_seats_invite ON staff_seats (invite_hash) WHERE invite_hash IS NOT NULL;
CREATE INDEX staff_seats_company ON staff_seats (company_id);

CREATE TABLE staff_sessions (
  token_hash text PRIMARY KEY,
  seat_id    uuid NOT NULL REFERENCES staff_seats(id) ON DELETE CASCADE,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ended_at   timestamptz
);
CREATE INDEX staff_sessions_seat ON staff_sessions (seat_id);

-- As with the owner's authenticators, sessions and claims (0033, 0050,
-- 0094): nobody but the control plane.
ALTER TABLE staff_seats ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_seats FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON staff_seats USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_seats TO palugada_admin;

ALTER TABLE staff_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON staff_sessions USING (false) WITH CHECK (false);
GRANT SELECT, INSERT, UPDATE, DELETE ON staff_sessions TO palugada_admin;

-- Who decided an item, when it was not the owner: the seat, kept when the
-- seat is revoked so the record still says who.
ALTER TABLE inbox_items ADD COLUMN decided_by_seat uuid;
