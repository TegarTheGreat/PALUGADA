-- Rooms from a Slack export (F19.23; STATUS section 2.214).
--
-- The owner brings a Slack workspace's history in: its channels become topic
-- rooms, its threads threads, its people authors of the old workspace who can
-- be linked to seats later. The export is uploaded in parts and read by the
-- worker on the control plane in importing mode (0150), which owes nobody a
-- feed row, a mention or a follow per message.
--
-- What was imported keeps the id it had in Slack, so a second import of the
-- same export finds every room and message already there and adds nothing.
-- Only an import writes one: a person's room or message carries none, so
-- nobody squats a channel's id and keeps the import from finding its room.

ALTER TABLE rooms ADD COLUMN external_id text
  CONSTRAINT rooms_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 128)
  CONSTRAINT rooms_external_is_a_topic CHECK (external_id IS NULL OR kind = 'topic');
CREATE UNIQUE INDEX rooms_imported_once ON rooms (company_id, external_id) WHERE external_id IS NOT NULL;

ALTER TABLE room_messages ADD COLUMN external_id text
  CONSTRAINT room_messages_external_id_length CHECK (char_length(external_id) BETWEEN 1 AND 128)
  CONSTRAINT room_messages_external_imported CHECK (external_id IS NULL OR via = 'import');
CREATE UNIQUE INDEX room_messages_imported_once ON room_messages (company_id, room_id, external_id)
  WHERE external_id IS NOT NULL;

-- Whose id it is: written by an import on the control plane, and never
-- changed. The application role may insert a room or a message with every
-- column, so the insert is checked here rather than by a grant.
CREATE FUNCTION app.external_id_is_the_imports() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.external_id IS NOT NULL AND NOT (app.reader() = 'control' AND app.importing()) THEN
      RAISE EXCEPTION 'only an import writes where a room or a message came from' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'where a room or a message came from never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_external_id BEFORE INSERT OR UPDATE OF external_id ON rooms
  FOR EACH ROW EXECUTE FUNCTION app.external_id_is_the_imports();
CREATE TRIGGER room_messages_external_id BEFORE INSERT OR UPDATE OF external_id ON room_messages
  FOR EACH ROW EXECUTE FUNCTION app.external_id_is_the_imports();

-- One import: its parts as they arrive, then what reading it found. The
-- parts are kept under <companyId>.people/imports/<id>/ until it is read,
-- and gone when it is done or failed, or after seven days in any case.
CREATE TABLE room_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('slack')),
  status        text NOT NULL DEFAULT 'receiving' CHECK (status IN ('receiving', 'reading', 'done', 'failed')),
  parts         smallint NOT NULL CHECK (parts BETWEEN 1 AND 64),
  received      smallint NOT NULL DEFAULT 0,
  counts        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(counts) = 'object'),
  problems      jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(problems) = 'array' AND jsonb_array_length(problems) <= 200),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  -- When the uploaded parts were deleted.
  parts_gone_at timestamptz,
  -- Until when a worker holds it to read: one reads it at a time, and
  -- another takes it up when a worker that stopped lets this pass.
  reading_until timestamptz,
  UNIQUE (company_id, id),
  CONSTRAINT room_imports_received CHECK (received BETWEEN 0 AND parts),
  CONSTRAINT room_imports_read_when_whole CHECK (status = 'receiving' OR received = parts OR status = 'failed'),
  CONSTRAINT room_imports_finished CHECK ((status IN ('done', 'failed')) = (finished_at IS NOT NULL))
);
CREATE INDEX room_imports_to_read ON room_imports (company_id, created_at) WHERE status = 'reading';

-- An author of the old workspace, and the seat they became. The seat is a
-- bare uuid, as decided_by_seat is: a record outlives its seat. `rooms` are
-- the private rooms they were in, which a link joins the seat to; `gave` are
-- the ones the link did join it to, which an unlink takes back, and no room
-- the seat was in apart from the link.
CREATE TABLE room_former_people (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  former     text NOT NULL CHECK (former ~ '^former:[a-z]{2,16}:[A-Za-z0-9._-]{1,64}$'),
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  seat_id    uuid,
  rooms      uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(rooms) <= 10000),
  gave       uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(gave) <= 10000),
  linked_at  timestamptz,
  PRIMARY KEY (company_id, former),
  CONSTRAINT room_former_people_linked_when CHECK ((seat_id IS NULL) = (linked_at IS NULL)),
  CONSTRAINT room_former_people_gave_when_linked CHECK (seat_id IS NOT NULL OR cardinality(gave) = 0)
);

SELECT app.enable_room_rls('room_imports');
SELECT app.enable_room_rls('room_former_people');
-- The control plane imports, and the owner links on it: no person's
-- transaction reads either, since a former person's private rooms are the
-- owner's to know, and nothing of an import is a seat's.
REVOKE SELECT, INSERT, UPDATE, DELETE ON room_imports, room_former_people FROM palugada_app;
