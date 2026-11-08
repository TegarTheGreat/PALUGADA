-- People have handles (F19.2, F19.8, F19.12, F19.19; the workspace plan, set S0a).
--
-- A person in a company's rooms is the owner or a seat the owner made, never
-- an agent. They are named by a principal, which is text rather than a row:
-- 'owner', or 'seat:<uuid>' for a staff seat. There is no owner row that could
-- ever become a second owner (NG3), and a seat's id is already a bare uuid
-- wherever a record names it (decided_by_seat, addressee_seat, person_seat),
-- so a record outlives the seat it names. The three functions below are that
-- rule, IMMUTABLE so a CHECK may call them.
CREATE FUNCTION app.is_person(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT p = 'owner' OR p ~ '^seat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' $$;
-- An author may also be someone an import brought, who is never a member.
CREATE FUNCTION app.is_author(p text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT app.is_person(p) OR p ~ '^former:[a-z]{2,16}:[A-Za-z0-9._-]{1,64}$' $$;
CREATE FUNCTION app.are_people(ps text[]) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(bool_and(app.is_person(p)), true) FROM unnest(ps) AS p $$;

-- Seat kinds become a ladder (F19.8): a viewer reads and talks, a member also
-- asks for work and answers what is put to it, an approver also decides at
-- tier 2 and below. 0110's check was written unnamed, so PostgreSQL named it
-- staff_seats_kind_check; it is named for what it holds now.
ALTER TABLE staff_seats DROP CONSTRAINT staff_seats_kind_check,
  ADD CONSTRAINT staff_seats_kind_known CHECK (kind IN ('viewer', 'member', 'approver'));
-- A person chooses a handle and a picture; the owner sets the name. Asks a
-- day bound what one seat's presses can spend.
ALTER TABLE staff_seats
  ADD COLUMN handle text CONSTRAINT staff_seats_handle_shape CHECK (handle ~ '^[a-z][a-z0-9._-]{2,31}$'),
  ADD COLUMN picture text CONSTRAINT staff_seats_picture_shape CHECK (picture ~ '^person-(0[1-9]|1[0-2])$'),
  ADD COLUMN asks_per_day smallint NOT NULL DEFAULT 20
    CONSTRAINT staff_seats_asks_bounded CHECK (asks_per_day BETWEEN 0 AND 200),
  -- `@owner` and `@room` are words every message may hold: a seat called
  -- either would be mentioned by both, and the owner's mention would reach it.
  ADD CONSTRAINT staff_seats_handle_not_a_word CHECK (handle NOT IN ('owner', 'room'));
-- Sign-in names the seat by its handle before any company is known (F19.22),
-- so a live handle is the deployment's, not one company's. A revoked seat's
-- handle is free again.
CREATE UNIQUE INDEX staff_seats_live_handle ON staff_seats (handle) WHERE handle IS NOT NULL AND revoked_at IS NULL;

-- One person's own settings: the owner or a seat (F19.2). A seat's row goes
-- with its company, so erasing a company leaves no setting of its people; the
-- owner's has no company.
CREATE TABLE principal_prefs (
  principal          text PRIMARY KEY CONSTRAINT principal_prefs_person CHECK (app.is_person(principal)),
  -- The seat's company; NULL for the owner.
  company_id         uuid REFERENCES companies(id) ON DELETE CASCADE,
  -- NULL: the deployment's console language.
  language           text,
  -- NULL: the company's.
  timezone           text,
  quiet_start        smallint CHECK (quiet_start BETWEEN 0 AND 23),
  quiet_end          smallint CHECK (quiet_end BETWEEN 0 AND 23),
  -- Whether people's messages reach the owner at all (F10.5): meaningful for
  -- 'owner' only, and off until the owner turns it on.
  owner_hears_people boolean NOT NULL DEFAULT false,
  notices_per_day    smallint NOT NULL DEFAULT 30 CHECK (notices_per_day BETWEEN 0 AND 200),
  -- A hidden tab may show a browser notification for a direct message or a mention.
  notify_in_tab      boolean NOT NULL DEFAULT true,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principal_prefs_owner_has_no_company CHECK ((principal = 'owner') = (company_id IS NULL)),
  CONSTRAINT principal_prefs_quiet_pair CHECK ((quiet_start IS NULL) = (quiet_end IS NULL)),
  CONSTRAINT principal_prefs_owner_only CHECK (principal = 'owner' OR NOT owner_hears_people)
);
CREATE INDEX principal_prefs_company ON principal_prefs (company_id) WHERE company_id IS NOT NULL;

-- As staff_seats (0110): nobody but the control plane. A person's quiet hours
-- and languages are read and written for them by the owner API, never by an
-- agent, which has no business knowing when anyone sleeps.
ALTER TABLE principal_prefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE principal_prefs FORCE ROW LEVEL SECURITY;
CREATE POLICY control_plane_only ON principal_prefs USING (false) WITH CHECK (false);
REVOKE ALL ON principal_prefs FROM palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON principal_prefs TO palugada_admin;

-- PALUGADA's own conversation has a monthly allowance (F19.12), finite by
-- default: a NULL would have meant no ceiling at all. USD 20.
-- And the deployment's name in relay envelopes (F19.19), made once here and
-- never changed, so a relay can tell two deployments of one owner apart.
ALTER TABLE platform_control
  ADD COLUMN assistant_month_cents integer NOT NULL DEFAULT 2000 CHECK (assistant_month_cents >= 0),
  ADD COLUMN deployment_id uuid NOT NULL DEFAULT gen_random_uuid();
