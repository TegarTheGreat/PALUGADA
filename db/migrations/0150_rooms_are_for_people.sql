-- Rooms are for people (F19.1, F19.3, F19.4, F19.5, F19.10, F19.11; STATUS
-- section 2.202).
--
-- Each company gets a workspace where the owner and the staff the owner
-- seated talk: a company room, a room per division, topic rooms, direct
-- messages. Agents are never members, never write, and never read a word of
-- it (NG2): they appear only as cards the platform draws from rows of work.
-- Every rule of that is a property of the database here, not of the code
-- that will use it, so that a handler that forgets a WHERE leaks nothing:
--
--   - Every room table is a tenant table (forced row security, keys on
--     (company_id, id)), and is opened only to a transaction that names who
--     reads: 'people' (a person, as themselves), 'delivery' (what tells people
--     something changed: positions and ids, never words) or 'platform' (the
--     card sweep and the rooms every company has). An agent's transaction
--     names none, and sees and writes nothing, even in its own company.
--   - A person sees only the rooms they may see, by a rule held by the rooms
--     policy and reused by every other table through it.
--   - Only people write text, only as themselves; the platform writes cards
--     and coded notices with no words.
--   - Every change takes one position from the company's clock, in commit
--     order, and leaves a row in a feed that holds no words.

-- ---------------------------------------------------------------------------
-- Who is reading, said by src/db/tenant.ts and nowhere else.

CREATE FUNCTION app.reader() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT coalesce(nullif(current_setting('app.reader', true), ''), 'none') $$;
CREATE FUNCTION app.principal() RETURNS text LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.principal', true), '') $$;
CREATE FUNCTION app.importing() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.importing', true), '') = 'on' $$;

-- A direct room's key: its people's principals, distinct, in byte order
-- (what JavaScript's default sort gives for these ASCII strings), joined by
-- ',', two to eight of them. One key per set of people is what makes opening
-- a direct room with the same people open the same room (F19.1).
CREATE FUNCTION app.is_direct_key(k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cardinality(people) BETWEEN 2 AND 8
     AND app.are_people(people)
     AND k = array_to_string(ARRAY(SELECT DISTINCT p COLLATE "C" FROM unnest(people) AS p ORDER BY 1), ',')
    FROM (SELECT string_to_array(k, ',') AS people) AS split $$;

-- ---------------------------------------------------------------------------
-- The tables.

-- The company's commit-ordered position (F19.11).
CREATE TABLE room_clock (
  company_id     uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  position       bigint NOT NULL DEFAULT 0,
  -- The card sweep's fast-path cursor.
  cards_through  timestamptz NOT NULL DEFAULT '-infinity'
);

CREATE TABLE rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind        text NOT NULL CONSTRAINT rooms_kind CHECK (kind IN ('company', 'division', 'topic', 'direct')),
  division_id uuid,
  name        text CONSTRAINT rooms_name_length CHECK (char_length(name) BETWEEN 1 AND 80),
  about       text CONSTRAINT rooms_about_length CHECK (char_length(about) <= 500),
  private     boolean NOT NULL DEFAULT false,
  -- The members' principals, sorted, joined by ','.
  direct_key  text,
  shows_work  text NOT NULL DEFAULT 'asked_here' CHECK (shows_work IN ('asked_here', 'needs_people', 'all')),
  created_by  text NOT NULL CONSTRAINT rooms_created_by CHECK (created_by = 'platform' OR app.is_person(created_by)),
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz,
  archived_by text CHECK (archived_by IS NULL OR app.is_person(archived_by)),
  CONSTRAINT rooms_company_scoped_key UNIQUE (company_id, id),
  -- No delete action: a division is never deleted, only its company, which
  -- takes the room with it.
  CONSTRAINT rooms_division FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id),
  CONSTRAINT rooms_division_has_one CHECK ((kind = 'division') = (division_id IS NOT NULL)),
  -- Company and division names are drawn live, so a renamed division's room follows it.
  CONSTRAINT rooms_topic_named CHECK ((kind = 'topic') = (name IS NOT NULL)),
  CONSTRAINT rooms_direct_keyed CHECK ((kind = 'direct') = (direct_key IS NOT NULL)),
  CONSTRAINT rooms_direct_people CHECK (kind <> 'direct' OR app.is_direct_key(direct_key)),
  CONSTRAINT rooms_direct_private CHECK (kind <> 'direct' OR private),
  -- A direct room is opened by one of its own people: nobody squats another pair's key.
  CONSTRAINT rooms_direct_opened_by_a_member CHECK (kind <> 'direct' OR created_by = ANY (string_to_array(direct_key, ','))),
  CONSTRAINT rooms_shared_open CHECK (kind NOT IN ('company', 'division') OR NOT private),
  CONSTRAINT rooms_only_topics_archive CHECK (kind = 'topic' OR archived_at IS NULL),
  CONSTRAINT rooms_archive_names_who CHECK ((archived_at IS NULL) = (archived_by IS NULL)),
  CONSTRAINT rooms_platform_makes_shared CHECK ((kind IN ('company', 'division')) = (created_by = 'platform'))
);
CREATE UNIQUE INDEX rooms_one_company_room ON rooms (company_id) WHERE kind = 'company';
CREATE UNIQUE INDEX rooms_one_per_division ON rooms (company_id, division_id) WHERE kind = 'division';
CREATE UNIQUE INDEX rooms_live_topic_name ON rooms (company_id, lower(name)) WHERE kind = 'topic' AND archived_at IS NULL;
CREATE UNIQUE INDEX rooms_one_direct ON rooms (company_id, direct_key) WHERE kind = 'direct';

-- Who is in a room (F19.1).
CREATE TABLE room_members (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id       uuid NOT NULL,
  principal     text NOT NULL CONSTRAINT room_members_person CHECK (app.is_person(principal)),
  -- A snapshot of the name the owner gave the seat; NULL for the owner.
  name          text CHECK (char_length(name) BETWEEN 1 AND 120),
  role          text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  added_by      text NOT NULL CHECK (added_by = 'platform' OR app.is_person(added_by)),
  joined_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  left_at       timestamptz,
  left_by       text CHECK (left_by IS NULL OR left_by = 'platform' OR app.is_person(left_by)),
  PRIMARY KEY (company_id, room_id, principal),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT room_members_named CHECK ((principal = 'owner') = (name IS NULL)),
  CONSTRAINT room_members_left_names_who CHECK ((left_at IS NULL) = (left_by IS NULL))
);
CREATE INDEX room_members_of ON room_members (company_id, principal) WHERE left_at IS NULL;

-- One person's own place in a room (F19.10): theirs alone. A colleague's
-- last read or mute would be a read receipt.
CREATE TABLE room_places (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id       uuid NOT NULL,
  principal     text NOT NULL CHECK (app.is_person(principal)),
  read_position bigint NOT NULL DEFAULT 0 CHECK (read_position >= 0),
  notify        text NOT NULL DEFAULT 'mentions' CHECK (notify IN ('all', 'mentions', 'none')),
  muted_until   timestamptz,
  PRIMARY KEY (company_id, room_id, principal),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE
);

-- Who may see a private or direct room; kept by the trigger on room_members.
-- Its own policy is "my rows only", which is what lets the rooms policy read
-- it without the two policies reading each other.
CREATE TABLE room_access (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL,
  principal  text NOT NULL CHECK (app.is_person(principal)),
  PRIMARY KEY (company_id, room_id, principal),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE
);
CREATE INDEX room_access_of ON room_access (company_id, principal);

CREATE TABLE room_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id             uuid NOT NULL,
  -- Set by the insert trigger from room_clock.
  position            bigint NOT NULL,
  -- The root; one level.
  thread_of           uuid,
  also_in_room        boolean NOT NULL DEFAULT false,
  kind                text NOT NULL CONSTRAINT room_messages_kind
                        CHECK (kind IN ('text', 'work', 'question', 'approval', 'meeting', 'notice')),
  author              text NOT NULL CONSTRAINT room_messages_author CHECK (author = 'platform' OR app.is_author(author)),
  author_name         text CHECK (char_length(author_name) BETWEEN 1 AND 120),
  body                text CONSTRAINT room_messages_body_length CHECK (char_length(body) <= 8000),
  notice_code         text CHECK (notice_code ~ '^[a-z_]{1,40}$'),
  notice_values       jsonb CHECK (notice_values IS NULL OR (jsonb_typeof(notice_values) = 'object' AND pg_column_size(notice_values) <= 2048)),
  task_id             uuid,
  inbox_item_id       uuid,
  mentions            text[] NOT NULL DEFAULT '{}' CONSTRAINT room_messages_mentions_are_people
                        CHECK (app.are_people(mentions) AND cardinality(mentions) <= 50),
  mentions_room       boolean NOT NULL DEFAULT false,
  became              text CHECK (became IN ('work', 'instruction', 'meeting')),
  became_by           text CHECK (became_by IS NULL OR app.is_person(became_by)),
  became_at           timestamptz,
  via                 text NOT NULL DEFAULT 'console' CHECK (via IN ('console', 'relay', 'platform', 'import')),
  -- relays.id, on the control plane: a bare value.
  via_relay           uuid,
  client_id           text CHECK (char_length(client_id) BETWEEN 1 AND 64),
  reply_count         integer NOT NULL DEFAULT 0,
  last_reply_position bigint,
  edited_at           timestamptz,
  deleted_at          timestamptz,
  deleted_by          text CHECK (deleted_by IS NULL OR app.is_person(deleted_by)),
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT room_messages_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT room_messages_in_order UNIQUE (company_id, position),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, thread_of) REFERENCES room_messages (company_id, id) ON DELETE CASCADE,
  -- A card never keeps work alive: retention may take the task or the item.
  FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  FOREIGN KEY (company_id, inbox_item_id) REFERENCES inbox_items (company_id, id) ON DELETE SET NULL (inbox_item_id),
  -- NG2: people write text; the platform writes only cards and coded
  -- notices; there is no agent author.
  CONSTRAINT room_messages_people_write_text CHECK ((kind = 'text') = (author <> 'platform')),
  CONSTRAINT room_messages_platform_writes_as_itself CHECK ((author = 'platform') = (via = 'platform')),
  CONSTRAINT room_messages_cards_have_no_words CHECK (kind = 'text' OR body IS NULL),
  CONSTRAINT room_messages_notice_is_coded CHECK ((kind = 'notice') = (notice_code IS NOT NULL)),
  CONSTRAINT room_messages_says_something CHECK (kind <> 'text' OR body IS NOT NULL OR deleted_at IS NOT NULL),
  CONSTRAINT room_messages_deleted_empty CHECK (deleted_at IS NULL OR body IS NULL),
  CONSTRAINT room_messages_author_named CHECK ((author IN ('owner', 'platform')) = (author_name IS NULL)),
  CONSTRAINT room_messages_became_once CHECK ((became IS NULL) = (became_by IS NULL) AND (became IS NULL) = (became_at IS NULL)),
  CONSTRAINT room_messages_became_text CHECK (became IS NULL OR kind = 'text'),
  CONSTRAINT room_messages_instruction_in_thread CHECK (became IS DISTINCT FROM 'instruction' OR thread_of IS NOT NULL),
  CONSTRAINT room_messages_relay_named CHECK ((via = 'relay') = (via_relay IS NOT NULL)),
  CONSTRAINT room_messages_former_imported CHECK (author NOT LIKE 'former:%' OR via = 'import'),
  CONSTRAINT room_messages_client_people CHECK (client_id IS NULL OR kind = 'text'),
  CONSTRAINT room_messages_not_own_thread CHECK (thread_of IS NULL OR thread_of <> id)
);
CREATE INDEX room_messages_timeline ON room_messages (company_id, room_id, position);
CREATE INDEX room_messages_threads ON room_messages (company_id, thread_of, position) WHERE thread_of IS NOT NULL;
CREATE INDEX room_messages_of_work ON room_messages (company_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX room_messages_of_items ON room_messages (company_id, inbox_item_id) WHERE inbox_item_id IS NOT NULL;
-- A browser's retry with the same clientId is the same message.
CREATE UNIQUE INDEX room_messages_once ON room_messages (company_id, author, client_id) WHERE client_id IS NOT NULL;
-- One card per subject in a room, changed in place rather than posted again:
-- a question or an approval is its inbox item's, and work or a meeting its
-- task's. Each is keyed on its own subject alone, so that when retention
-- takes the items of two questions one task put, both cards let go of them
-- without becoming the same card.
CREATE UNIQUE INDEX room_cards_once ON room_messages (company_id, room_id, kind, inbox_item_id)
  WHERE kind IN ('question', 'approval') AND inbox_item_id IS NOT NULL;
CREATE UNIQUE INDEX room_work_cards_once ON room_messages (company_id, room_id, kind, task_id)
  WHERE kind IN ('work', 'meeting') AND task_id IS NOT NULL;
CREATE INDEX room_messages_mentions ON room_messages USING gin (mentions);
CREATE INDEX room_messages_body_trgm ON room_messages USING gin (body gin_trgm_ops) WHERE deleted_at IS NULL;

-- What an edit replaced: the owner's record (F19.4).
CREATE TABLE room_message_revisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id   uuid NOT NULL,
  body         text NOT NULL CHECK (char_length(body) <= 8000),
  replaced_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE
);
CREATE INDEX room_message_revisions_of ON room_message_revisions (company_id, message_id);

CREATE TABLE room_reactions (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  principal  text NOT NULL CHECK (app.is_author(principal)),
  emoji      text NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, message_id, principal, emoji),
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE
);

CREATE TABLE room_pins (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id    uuid NOT NULL,
  message_id uuid NOT NULL,
  pinned_by  text NOT NULL CHECK (app.is_person(pinned_by)),
  pinned_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, message_id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE
);

-- A room's files are kept beside the company's files, never under them
-- (<PALUGADA_FILES_ROOT>/<companyId>.people/), so no agent capability can
-- list, read or send one. The path's extension comes from sniffing the
-- bytes, and the client's name never reaches it.
CREATE TABLE room_files (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  name       text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  -- Sniffed from the bytes, never the client's claim.
  mime       text NOT NULL CHECK (char_length(mime) BETWEEN 3 AND 100),
  bytes      bigint NOT NULL CHECK (bytes BETWEEN 0 AND 25165824),
  sha256     text CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  -- rooms/<roomId>/<fileId>.<sniffed ext> under the people files root; NULL
  -- once removed, or when imported.
  path       text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE,
  CONSTRAINT room_files_kept_has_hash CHECK (path IS NULL OR sha256 IS NOT NULL),
  -- Whoever attaches a file writes its path, and the bytes are served from
  -- it: so its shape is held here, a room's directory and the file's own id,
  -- with nothing in it that could climb out of the people's files root into
  -- the company's own files, which agents read.
  CONSTRAINT room_files_path_shape CHECK (path IS NULL OR path ~ (
    '^rooms/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' || id::text || '\.[a-z0-9]{1,10}$'))
);
CREATE INDEX room_files_of ON room_files (company_id, message_id);
CREATE INDEX room_files_names ON room_files USING gin (name gin_trgm_ops);

-- Attention a person is owed (F19.10).
CREATE TABLE room_mentions (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  message_id uuid NOT NULL,
  principal  text NOT NULL CHECK (app.is_person(principal)),
  reason     text NOT NULL CHECK (reason IN ('mention', 'reply', 'card')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  seen_at    timestamptz,
  PRIMARY KEY (company_id, message_id, principal),
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE
);
CREATE INDEX room_mentions_unseen ON room_mentions (company_id, principal) WHERE seen_at IS NULL;

-- Threads a person follows: made on posting, replying or being mentioned.
CREATE TABLE room_follows (
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  root_id    uuid NOT NULL,
  principal  text NOT NULL CHECK (app.is_person(principal)),
  following  boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, root_id, principal),
  FOREIGN KEY (company_id, root_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE
);
CREATE INDEX room_follows_by ON room_follows (company_id, principal);

-- What changed, in commit order, with no words (F19.11).
CREATE TABLE room_feed (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  position      bigint NOT NULL,
  room_id       uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('message', 'edit', 'delete', 'reaction', 'pin', 'member', 'read', 'room', 'card')),
  -- The message, or NULL.
  ref           uuid,
  -- Set only for 'read': that person's devices alone.
  principal     text CHECK (principal IS NULL OR app.is_person(principal)),
  -- For 'message': the author principal (no words).
  author        text,
  mentions      text[] NOT NULL DEFAULT '{}',
  -- An @room: every member whose notify is not 'none'.
  mentions_room boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (company_id, position),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT room_feed_read_names_one CHECK ((kind = 'read') = (principal IS NOT NULL))
);
CREATE INDEX room_feed_age ON room_feed (created_at);

-- ---------------------------------------------------------------------------
-- The clock, and the functions that take a position from it.
--
-- Every function here and every trigger function below is SECURITY DEFINER,
-- owned by palugada_owner, with a fixed search path. They run under the
-- caller's app.company_id, so the tenant policy still binds them: the owner
-- role holds no BYPASSRLS, and FORCE row security applies to it.

-- Every room write takes the company's clock first, as a statement trigger,
-- before any row is located: one lock order for every writer, so an edit and
-- a reply racing on one root cannot deadlock. The row is made the first time
-- a company writes a room. A transaction with no company (the control plane
-- erasing a company, whose cascade reaches these tables) takes nothing, and
-- neither does one that names no reader: an agent's, whose every write the
-- reader policy refuses, or a cascade from purged work, which only lets go of
-- a link. Neither writes a feed row, so neither has an order to keep, and an
-- agent's statement must not write even the clock.
CREATE FUNCTION app.lock_room_clock() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  company uuid := nullif(current_setting('app.company_id', true), '')::uuid;
BEGIN
  IF company IS NULL OR app.reader() = 'none' THEN RETURN NULL; END IF;
  PERFORM 1 FROM room_clock WHERE company_id = company FOR UPDATE;
  IF NOT FOUND AND TG_OP <> 'DELETE' THEN
    INSERT INTO room_clock (company_id) VALUES (company) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM room_clock WHERE company_id = company FOR UPDATE;
  END IF;
  RETURN NULL;
END $$;

-- The next position. The row lock, already held, is kept to commit, so
-- positions have no gaps and follow commit order.
CREATE FUNCTION app.next_room_position(company uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  taken bigint;
BEGIN
  UPDATE room_clock SET position = position + 1 WHERE company_id = company RETURNING position INTO taken;
  IF taken IS NULL THEN
    -- Its clock is locked first by every writer of its own company; a
    -- company whose clock this transaction cannot see is another company.
    RAISE EXCEPTION 'a room of company % is written only in that company''s own transaction', company
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN taken;
END $$;
REVOKE EXECUTE ON FUNCTION app.next_room_position(uuid) FROM PUBLIC;

-- A row in the feed, and a word to the hubs that something changed. A NOTIFY
-- is delivered at commit, so a hub never reads a row that is not there.
CREATE FUNCTION app.room_feed_write(company uuid, room uuid, what text, about uuid,
                                   at_position bigint DEFAULT NULL, whose text DEFAULT NULL,
                                   writer text DEFAULT NULL, named text[] DEFAULT '{}',
                                   everyone boolean DEFAULT false) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  at bigint := coalesce(at_position, app.next_room_position(company));
BEGIN
  INSERT INTO room_feed (company_id, position, room_id, kind, ref, principal, author, mentions, mentions_room)
  VALUES (company, at, room, what, about, whose, writer, named, everyone);
  PERFORM pg_notify('palugada_people', company::text);
  RETURN at;
END $$;
REVOKE EXECUTE ON FUNCTION app.room_feed_write(uuid, uuid, text, uuid, bigint, text, text, text[], boolean) FROM PUBLIC;

-- Whether a trigger writes the feed: not when no reader is named (a
-- transaction that only cascades), and not while an archive or an export
-- from Slack is read in, which writes one row per room when it is done.
CREATE FUNCTION app.room_feed_on() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT app.reader() <> 'none' AND NOT app.importing() $$;

-- A room table: tenant isolation, then a reader must be named (F19.3).
-- 'control' is the admin pool's reader (roomsOnControlPlane): it bypasses
-- row security, and only the triggers read it. The clock is the lock itself,
-- so it takes no clock-first trigger of its own.
CREATE FUNCTION app.enable_room_rls(target regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  -- ENABLE and FORCE, tenant_isolation, the app role's SELECT, INSERT and
  -- UPDATE, and the admin's all (0047).
  PERFORM app.enable_tenant_rls(target);
  EXECUTE format('CREATE POLICY room_readers ON %s AS RESTRICTIVE TO palugada_app'
    ' USING (app.reader() IN (''people'', ''delivery'', ''platform''))'
    ' WITH CHECK (app.reader() IN (''people'', ''delivery'', ''platform''))', target);
  IF target <> 'room_clock'::regclass THEN
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR UPDATE OR DELETE ON %s'
      ' FOR EACH STATEMENT EXECUTE FUNCTION app.lock_room_clock()', target::text || '_clock_first', target);
  END IF;
END $$;

SELECT app.enable_room_rls(t) FROM unnest(ARRAY['room_clock', 'rooms', 'room_members', 'room_places',
  'room_access', 'room_messages', 'room_message_revisions', 'room_reactions', 'room_pins', 'room_files',
  'room_mentions', 'room_follows', 'room_feed']::regclass[]) AS t;

-- Who may see a room, asked about anyone: the rule the triggers ask when they
-- owe someone attention. SECURITY DEFINER, since room_access's self-only
-- policy binds only palugada_app; and not the application's to call, because
-- answering any question about anyone would tell a person whether a private
-- room they cannot see exists and who is in it.
CREATE FUNCTION app.room_visible_to(company uuid, room uuid, p text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app.reader() <> 'none' AND EXISTS (
    SELECT 1 FROM rooms r
     WHERE r.company_id = company AND r.id = room
       AND (r.kind IN ('company', 'division')
            OR (r.kind = 'topic' AND (NOT r.private OR p = 'owner'))
            OR EXISTS (SELECT 1 FROM room_access a
                        WHERE a.company_id = company AND a.room_id = room AND a.principal = p))) $$;
REVOKE EXECUTE ON FUNCTION app.room_visible_to(uuid, uuid, text) FROM PUBLIC;

-- The same question as the application may ask it. Delivery plans what each
-- person is told and the platform owes card attention, so both ask about
-- anyone. A person asks only about themselves, which tells them nothing the
-- rooms they read do not. An agent's transaction names no reader and is told
-- nothing, so it cannot learn that a room exists.
CREATE FUNCTION app.may_see(company uuid, room uuid, p text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.reader() IN ('delivery', 'platform') THEN
    RETURN app.room_visible_to(company, room, p);
  ELSIF app.reader() = 'people' THEN
    IF p IS DISTINCT FROM app.principal() THEN
      RAISE EXCEPTION 'a person asks only about themselves whether they may see a room'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN app.room_visible_to(company, room, p);
  END IF;
  RETURN false;
END $$;
REVOKE EXECUTE ON FUNCTION app.may_see(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.may_see(uuid, uuid, text) TO palugada_app;

-- The card sweep's cursor, which the application role cannot write directly
-- (it moves only forward, so two workers never move it back).
CREATE FUNCTION app.advance_card_cursor(company uuid, through timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.reader() <> 'platform' OR company::text IS DISTINCT FROM current_setting('app.company_id', true) THEN
    RAISE EXCEPTION 'only the platform reader moves its own company''s card cursor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO room_clock (company_id) VALUES (company) ON CONFLICT DO NOTHING;
  UPDATE room_clock SET cards_through = GREATEST(cards_through, through) WHERE company_id = company;
END $$;

-- A card whose subject changed in another table: a new position and a
-- 'card' feed row, so open rooms draw it again. The work under a person's
-- own message is drawn from the task, and the platform may not touch that
-- person's row; this says it changed without touching it.
CREATE FUNCTION app.touch_room_card(company uuid, room uuid, message uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.reader() <> 'platform' OR company::text IS DISTINCT FROM current_setting('app.company_id', true) THEN
    RAISE EXCEPTION 'only the platform reader marks its own company''s cards' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM room_messages WHERE company_id = company AND id = message AND room_id = room) THEN
    RAISE EXCEPTION 'no message % in room %', message, room USING ERRCODE = 'foreign_key_violation';
  END IF;
  -- The clock first, as every room write takes it.
  PERFORM 1 FROM room_clock WHERE company_id = company FOR UPDATE;
  RETURN app.room_feed_write(company, room, 'card', message);
END $$;
REVOKE EXECUTE ON FUNCTION app.advance_card_cursor(uuid, timestamptz), app.touch_room_card(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.advance_card_cursor(uuid, timestamptz), app.touch_room_card(uuid, uuid, uuid) TO palugada_app;

-- ---------------------------------------------------------------------------
-- Who sees and writes what. Each policy is RESTRICTIVE, for the application
-- role, on top of tenant_isolation and room_readers. "Visible" is always the
-- rooms policy, reached through a subquery on rooms: one rule.

-- rooms: a person sees the company's and the divisions' rooms, every open
-- topic room, the private ones they are in (and the owner every private
-- topic room), and the direct rooms they are in. The owner sees a direct
-- room only as a member.
CREATE POLICY rooms_seen ON rooms AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() <> 'people'
  OR kind IN ('company', 'division')
  OR (kind = 'topic' AND (NOT private OR app.principal() = 'owner'))
  OR EXISTS (SELECT 1 FROM room_access a
              WHERE a.company_id = rooms.company_id AND a.room_id = rooms.id AND a.principal = app.principal()));
CREATE POLICY rooms_made ON rooms AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  (app.reader() = 'people' AND kind IN ('topic', 'direct') AND created_by = app.principal())
  OR (app.reader() = 'platform' AND created_by = 'platform'));
CREATE POLICY rooms_changed ON rooms AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'platform' OR (app.reader() = 'people' AND (
    kind IN ('company', 'division')
    OR (kind = 'topic' AND (NOT private OR app.principal() = 'owner'))
    OR EXISTS (SELECT 1 FROM room_access a
                WHERE a.company_id = rooms.company_id AND a.room_id = rooms.id AND a.principal = app.principal()))))
  WITH CHECK (app.reader() = 'platform' OR (app.reader() = 'people' AND (
    kind IN ('company', 'division')
    OR (kind = 'topic' AND (NOT private OR app.principal() = 'owner'))
    OR EXISTS (SELECT 1 FROM room_access a
                WHERE a.company_id = rooms.company_id AND a.room_id = rooms.id AND a.principal = app.principal()))));
REVOKE UPDATE ON rooms FROM palugada_app;
GRANT UPDATE (name, about, archived_at, archived_by, shows_work) ON rooms TO palugada_app;

-- room_access: my rows only. Written by the triggers alone.
CREATE POLICY room_access_mine ON room_access AS RESTRICTIVE FOR SELECT TO palugada_app
  USING (app.reader() <> 'people' OR principal = app.principal());
REVOKE INSERT, UPDATE ON room_access FROM palugada_app;

-- room_members: who is in a room I can see.
CREATE POLICY room_members_seen ON room_members AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() <> 'people'
  OR EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_members.company_id AND r.id = room_members.room_id));
CREATE POLICY room_members_added ON room_members AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  (app.reader() = 'people' AND added_by = app.principal()
   AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_members.company_id AND r.id = room_members.room_id))
  OR (app.reader() = 'platform' AND added_by = 'platform'));
CREATE POLICY room_members_changed ON room_members AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'people'
         AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_members.company_id AND r.id = room_members.room_id))
  WITH CHECK (app.reader() = 'people'
              AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_members.company_id AND r.id = room_members.room_id));
REVOKE UPDATE ON room_members FROM palugada_app;
GRANT UPDATE (name, role, left_at, left_by) ON room_members TO palugada_app;

-- room_places: mine alone, made by the membership trigger.
CREATE POLICY room_places_mine ON room_places AS RESTRICTIVE FOR SELECT TO palugada_app
  USING (app.reader() <> 'people' OR principal = app.principal());
CREATE POLICY room_places_changed ON room_places AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'people' AND principal = app.principal())
  WITH CHECK (app.reader() = 'people' AND principal = app.principal());
REVOKE INSERT, UPDATE ON room_places FROM palugada_app;
GRANT UPDATE (read_position, notify, muted_until) ON room_places TO palugada_app;

-- room_messages: never to delivery, which carries no words.
CREATE POLICY room_messages_seen ON room_messages AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() = 'platform'
  OR (app.reader() = 'people'
      AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_messages.company_id AND r.id = room_messages.room_id)));
CREATE POLICY room_messages_written ON room_messages AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  (app.reader() = 'people' AND kind = 'text' AND author = app.principal()
   AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_messages.company_id AND r.id = room_messages.room_id))
  OR (app.reader() = 'platform' AND author = 'platform'));
CREATE POLICY room_messages_changed ON room_messages AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING ((app.reader() = 'people'
          AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_messages.company_id AND r.id = room_messages.room_id))
         OR (app.reader() = 'platform' AND author = 'platform'))
  WITH CHECK ((app.reader() = 'people'
               AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_messages.company_id AND r.id = room_messages.room_id))
              OR (app.reader() = 'platform' AND author = 'platform'));
REVOKE UPDATE ON room_messages FROM palugada_app;
GRANT UPDATE (body, edited_at, deleted_at, deleted_by, task_id, inbox_item_id, notice_values, became, became_by, became_at)
  ON room_messages TO palugada_app;

-- room_message_revisions: the owner's record, and the platform's.
CREATE POLICY room_message_revisions_seen ON room_message_revisions AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() = 'platform'
  OR (app.reader() = 'people' AND app.principal() = 'owner'
      AND EXISTS (SELECT 1 FROM room_messages m
                   WHERE m.company_id = room_message_revisions.company_id AND m.id = room_message_revisions.message_id)));
REVOKE INSERT, UPDATE ON room_message_revisions FROM palugada_app;

-- room_reactions: a person's own, on messages they can see.
CREATE POLICY room_reactions_seen ON room_reactions AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() = 'platform'
  OR (app.reader() = 'people'
      AND EXISTS (SELECT 1 FROM room_messages m WHERE m.company_id = room_reactions.company_id AND m.id = room_reactions.message_id)));
CREATE POLICY room_reactions_given ON room_reactions AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  app.reader() = 'people' AND principal = app.principal()
  AND EXISTS (SELECT 1 FROM room_messages m WHERE m.company_id = room_reactions.company_id AND m.id = room_reactions.message_id));
CREATE POLICY room_reactions_taken_back ON room_reactions AS RESTRICTIVE FOR DELETE TO palugada_app
  USING (app.reader() = 'people' AND principal = app.principal());
REVOKE UPDATE ON room_reactions FROM palugada_app;
GRANT DELETE ON room_reactions TO palugada_app;

-- room_pins.
CREATE POLICY room_pins_seen ON room_pins AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() <> 'people'
  OR EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_pins.company_id AND r.id = room_pins.room_id));
CREATE POLICY room_pins_pinned ON room_pins AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  app.reader() = 'people' AND pinned_by = app.principal()
  AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_pins.company_id AND r.id = room_pins.room_id));
CREATE POLICY room_pins_unpinned ON room_pins AS RESTRICTIVE FOR DELETE TO palugada_app USING (
  app.reader() = 'people'
  AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_pins.company_id AND r.id = room_pins.room_id));
REVOKE UPDATE ON room_pins FROM palugada_app;
GRANT DELETE ON room_pins TO palugada_app;

-- room_files: never to delivery; added by the message's own author.
CREATE POLICY room_files_seen ON room_files AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() = 'platform'
  OR (app.reader() = 'people'
      AND EXISTS (SELECT 1 FROM room_messages m WHERE m.company_id = room_files.company_id AND m.id = room_files.message_id)));
CREATE POLICY room_files_attached ON room_files AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  app.reader() = 'people'
  AND EXISTS (SELECT 1 FROM room_messages m
               WHERE m.company_id = room_files.company_id AND m.id = room_files.message_id AND m.author = app.principal()));
REVOKE UPDATE ON room_files FROM palugada_app;

-- room_mentions: mine, in rooms I can still see. Card attention is the
-- platform's to write; a post writes its own by trigger.
CREATE POLICY room_mentions_mine ON room_mentions AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() <> 'people'
  OR (principal = app.principal()
      AND EXISTS (SELECT 1 FROM room_messages m WHERE m.company_id = room_mentions.company_id AND m.id = room_mentions.message_id)));
CREATE POLICY room_mentions_owed ON room_mentions AS RESTRICTIVE FOR INSERT TO palugada_app
  WITH CHECK (app.reader() = 'platform');
CREATE POLICY room_mentions_seen_by_me ON room_mentions AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'people' AND principal = app.principal())
  WITH CHECK (app.reader() = 'people' AND principal = app.principal());
REVOKE UPDATE ON room_mentions FROM palugada_app;
GRANT UPDATE (seen_at) ON room_mentions TO palugada_app;

-- room_follows: mine.
CREATE POLICY room_follows_mine ON room_follows AS RESTRICTIVE FOR SELECT TO palugada_app
  USING (app.reader() <> 'people' OR principal = app.principal());
CREATE POLICY room_follows_followed ON room_follows AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  app.reader() = 'people' AND principal = app.principal()
  AND EXISTS (SELECT 1 FROM room_messages m WHERE m.company_id = room_follows.company_id AND m.id = room_follows.root_id));
CREATE POLICY room_follows_changed ON room_follows AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'people' AND principal = app.principal())
  WITH CHECK (app.reader() = 'people' AND principal = app.principal());
REVOKE UPDATE ON room_follows FROM palugada_app;
GRANT UPDATE (following, updated_at) ON room_follows TO palugada_app;

-- room_feed: what changed in the rooms I can see, and my own read marks.
CREATE POLICY room_feed_seen ON room_feed AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() IN ('delivery', 'platform')
  OR (app.reader() = 'people'
      AND ((principal IS NULL
            AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_feed.company_id AND r.id = room_feed.room_id))
           OR principal = app.principal())));
REVOKE INSERT, UPDATE ON room_feed FROM palugada_app;

-- room_clock: people never read it. Positions are company-wide, so the gaps
-- between them say how much happens elsewhere; the number itself is not a
-- person's to watch.
CREATE POLICY room_clock_read ON room_clock AS RESTRICTIVE FOR SELECT TO palugada_app
  USING (app.reader() IN ('delivery', 'platform'));
REVOKE INSERT, UPDATE ON room_clock FROM palugada_app;

-- ---------------------------------------------------------------------------
-- Triggers. Each writes no feed row when no reader is named, and none of
-- feed, mention or follow while importing.

-- rooms: the creator of a private or direct room can see it before adding
-- its members; every change is a feed row. A person's insert never asks for
-- RETURNING: the row is checked against the rooms policy before this trigger
-- has given its maker access, so a private room returned at insert is
-- refused. The id is made by the caller instead.
--
-- A room is made now and open, whatever its insert says: nobody makes one
-- already archived in someone else's name, or dated before it was made. An
-- archive or an export read in on the control plane keeps its dates.
-- Archiving is a person's act, and who archived a room is whoever's
-- transaction this is; the platform archives nothing.
CREATE FUNCTION app.rooms_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  reader text := app.reader();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF reader <> 'control' THEN
      NEW.created_at := clock_timestamp();
      IF NEW.archived_at IS NOT NULL OR NEW.archived_by IS NOT NULL THEN
        RAISE EXCEPTION 'a room is made open; it is archived afterwards, by whoever archives it'
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at OR NEW.archived_by IS DISTINCT FROM OLD.archived_by THEN
    IF reader = 'people' THEN
      IF NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
        NEW.archived_by := CASE WHEN NEW.archived_at IS NULL THEN NULL ELSE app.principal() END;
      ELSE
        -- Who archived it stays who did.
        NEW.archived_by := OLD.archived_by;
      END IF;
    ELSIF reader = 'platform' THEN
      RAISE EXCEPTION 'a room is archived by a person, never by the platform' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rooms_guard BEFORE INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION app.rooms_guard();

CREATE FUNCTION app.rooms_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.private AND app.is_person(NEW.created_by) THEN
    INSERT INTO room_access (company_id, room_id, principal) VALUES (NEW.company_id, NEW.id, NEW.created_by)
    ON CONFLICT DO NOTHING;
  END IF;
  IF app.room_feed_on() THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.id, 'room', NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER rooms_after AFTER INSERT OR UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION app.rooms_after();

-- A direct room's people are exactly the ones its key names, from the moment
-- it is opened: checked when the transaction that opened it commits, after
-- its members have followed it in. One of them opening it alone would keep
-- the others from ever having that room, since nobody joins a direct room
-- later and the key opens only one. A room read in from an archive or an
-- export comes with whatever people it had.
CREATE FUNCTION app.rooms_direct_complete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  missing text[];
BEGIN
  IF app.importing() THEN RETURN NULL; END IF;
  -- A room the same transaction removed again owes nobody anything.
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE company_id = NEW.company_id AND id = NEW.id) THEN RETURN NULL; END IF;
  SELECT array_agg(p ORDER BY p) INTO missing
    FROM unnest(string_to_array(NEW.direct_key, ',')) AS p
   WHERE NOT EXISTS (SELECT 1 FROM room_members m
                      WHERE m.company_id = NEW.company_id AND m.room_id = NEW.id AND m.principal = p);
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'a direct room is opened with everyone its key names in it: % %', array_to_string(missing, ', '),
      CASE WHEN cardinality(missing) = 1 THEN 'is not' ELSE 'are not' END
      USING ERRCODE = 'check_violation', CONSTRAINT = 'rooms_direct_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rooms_direct_complete AFTER INSERT ON rooms
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.kind = 'direct') EXECUTE FUNCTION app.rooms_direct_complete();

-- room_members: a direct room's people are fixed at its opening: nobody is
-- added, nobody leaves, and nobody is removed except by revoking a seat, on
-- the control plane. Adding someone opens the direct room of the new set of
-- people, with no history, so nobody reads a conversation they were not in.
CREATE FUNCTION app.room_members_direct_fixed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  key text;
BEGIN
  SELECT direct_key INTO key FROM rooms WHERE company_id = NEW.company_id AND id = NEW.room_id;
  IF key IS NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' AND NOT NEW.principal = ANY (string_to_array(key, ',')) THEN
    RAISE EXCEPTION 'a direct room''s people are the ones it was opened with: open the room of the new set instead'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.left_at IS DISTINCT FROM OLD.left_at AND app.reader() <> 'control' THEN
    RAISE EXCEPTION 'nobody leaves or is removed from a direct room; only a revoked seat goes'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_members_direct_fixed BEFORE INSERT OR UPDATE ON room_members
  FOR EACH ROW EXECUTE FUNCTION app.room_members_direct_fixed();

-- What a person may write about membership. Their own row's name is the one
-- their session gave, whatever the insert says; a row arrives present. Only a
-- topic room has admins, and only its creator, one of its present admins or
-- the owner makes someone one or takes it away, on adding them or after:
-- being an admin is what lets a person remove others from a private room.
CREATE FUNCTION app.room_members_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me text := app.principal();
  room rooms%ROWTYPE;
BEGIN
  IF app.reader() <> 'people' THEN RETURN NEW; END IF;
  SELECT * INTO room FROM rooms WHERE company_id = NEW.company_id AND id = NEW.room_id;
  IF (TG_OP = 'INSERT' AND NEW.role <> 'member') OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role) THEN
    IF room.kind IS DISTINCT FROM 'topic' THEN
      RAISE EXCEPTION 'only a topic room has admins' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT coalesce(me = 'owner' OR me = room.created_by
                    OR EXISTS (SELECT 1 FROM room_members m
                                WHERE m.company_id = NEW.company_id AND m.room_id = NEW.room_id AND m.principal = me
                                  AND m.role = 'admin' AND m.left_at IS NULL), false) THEN
      RAISE EXCEPTION 'a room''s admins are made by its creator, one of its admins or the owner'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.left_at IS NOT NULL OR NEW.left_by IS NOT NULL THEN
      RAISE EXCEPTION 'a member is added present' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.principal = me THEN
      NEW.name := nullif(current_setting('app.principal_name', true), '');
    END IF;
    NEW.joined_at := clock_timestamp();
    RETURN NEW;
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     AND (NEW.principal <> me OR NEW.name IS DISTINCT FROM nullif(current_setting('app.principal_name', true), '')) THEN
    RAISE EXCEPTION 'a member''s name is the one the owner gave them' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.left_at IS DISTINCT FROM OLD.left_at THEN
    IF room.kind = 'company' THEN
      RAISE EXCEPTION 'nobody leaves the company room' USING ERRCODE = 'check_violation';
    END IF;
    -- Another's row only in a private topic room: clearing is adding them
    -- back (any member may), setting is removing them (the route has checked
    -- that the creator, an admin or the owner asked).
    IF NEW.principal <> me AND NOT (room.kind = 'topic' AND room.private) THEN
      RAISE EXCEPTION 'a person leaves an open room themselves' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.left_at IS NULL THEN
      NEW.left_by := NULL;
      NEW.joined_at := clock_timestamp();
    ELSE
      NEW.left_at := clock_timestamp();
      NEW.left_by := me;
    END IF;
  ELSIF NEW.left_by IS DISTINCT FROM OLD.left_by THEN
    RAISE EXCEPTION 'who removed a member is written with the removal' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_members_guard BEFORE INSERT OR UPDATE ON room_members
  FOR EACH ROW EXECUTE FUNCTION app.room_members_guard();

-- Joining gives a place at the clock (no backlog) and, in a private room,
-- access; leaving ends attention: access, follows of the room's threads and
-- unseen mentions there go.
CREATE FUNCTION app.room_members_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  is_private boolean;
  now_at bigint;
BEGIN
  IF NEW.left_at IS NULL AND (TG_OP = 'INSERT' OR OLD.left_at IS NOT NULL) THEN
    SELECT r.private INTO is_private FROM rooms r WHERE r.company_id = NEW.company_id AND r.id = NEW.room_id;
    IF is_private THEN
      INSERT INTO room_access (company_id, room_id, principal) VALUES (NEW.company_id, NEW.room_id, NEW.principal)
      ON CONFLICT DO NOTHING;
    END IF;
    SELECT c.position INTO now_at FROM room_clock c WHERE c.company_id = NEW.company_id;
    INSERT INTO room_places (company_id, room_id, principal, read_position)
    VALUES (NEW.company_id, NEW.room_id, NEW.principal, coalesce(now_at, 0))
    ON CONFLICT (company_id, room_id, principal)
      DO UPDATE SET read_position = GREATEST(room_places.read_position, EXCLUDED.read_position);
  ELSIF TG_OP = 'UPDATE' AND OLD.left_at IS NULL AND NEW.left_at IS NOT NULL THEN
    DELETE FROM room_access WHERE company_id = NEW.company_id AND room_id = NEW.room_id AND principal = NEW.principal;
    DELETE FROM room_follows f
     USING room_messages m
     WHERE f.company_id = NEW.company_id AND f.principal = NEW.principal
       AND m.company_id = f.company_id AND m.id = f.root_id AND m.room_id = NEW.room_id;
    DELETE FROM room_mentions n
     USING room_messages m
     WHERE n.company_id = NEW.company_id AND n.principal = NEW.principal AND n.seen_at IS NULL
       AND m.company_id = n.company_id AND m.id = n.message_id AND m.room_id = NEW.room_id;
  ELSE
    RETURN NULL;
  END IF;
  IF app.room_feed_on() THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, 'member', NULL);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_members_after AFTER INSERT OR UPDATE ON room_members
  FOR EACH ROW EXECUTE FUNCTION app.room_members_after();

-- room_places: a read mark only moves forward, and never past the clock.
CREATE FUNCTION app.room_places_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  now_at bigint;
BEGIN
  IF app.reader() <> 'people' THEN RETURN NEW; END IF;
  NEW.read_position := GREATEST(OLD.read_position, NEW.read_position);
  SELECT c.position INTO now_at FROM room_clock c WHERE c.company_id = NEW.company_id;
  IF NEW.read_position > coalesce(now_at, 0) THEN
    RAISE EXCEPTION 'a read mark cannot be past the last change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_places_guard BEFORE UPDATE ON room_places FOR EACH ROW EXECUTE FUNCTION app.room_places_guard();

-- A read mark tells that person's other devices, and only theirs.
CREATE FUNCTION app.room_places_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.read_position IS DISTINCT FROM OLD.read_position AND app.room_feed_on() THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, 'read', NULL, NULL, NEW.principal);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_places_after AFTER UPDATE ON room_places FOR EACH ROW EXECUTE FUNCTION app.room_places_after();

-- room_messages: the insert guard. A message takes its position from the
-- clock, a reply is one level deep in its root's room, and a person's
-- message says where it came from and whose it is as the session said, not
-- as the insert did.
CREATE FUNCTION app.room_messages_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  root room_messages%ROWTYPE;
  reader text := app.reader();
BEGIN
  NEW.position := app.next_room_position(NEW.company_id);
  -- An archive or an export read in keeps when each message was written.
  IF reader <> 'control' THEN NEW.created_at := clock_timestamp(); END IF;
  IF NEW.thread_of IS NOT NULL THEN
    SELECT * INTO root FROM room_messages WHERE company_id = NEW.company_id AND id = NEW.thread_of;
    IF FOUND AND (root.thread_of IS NOT NULL OR root.room_id <> NEW.room_id) THEN
      RAISE EXCEPTION 'a reply is to a message at the top of the same room: threads are one level deep'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF reader = 'people' THEN
    IF NEW.via IS DISTINCT FROM coalesce(nullif(current_setting('app.via', true), ''), 'console')
       OR NEW.via_relay IS DISTINCT FROM nullif(current_setting('app.via_relay', true), '')::uuid THEN
      RAISE EXCEPTION 'a message says where it came from as the session does' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.became IS NOT NULL OR NEW.became_by IS NOT NULL OR NEW.became_at IS NOT NULL
       OR NEW.task_id IS NOT NULL OR NEW.inbox_item_id IS NOT NULL OR NEW.edited_at IS NOT NULL
       OR NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL OR NEW.last_reply_position IS NOT NULL
       OR NEW.reply_count <> 0 OR NEW.notice_values IS NOT NULL THEN
      RAISE EXCEPTION 'a message is written as words, and becomes anything else only by a press afterwards'
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.author_name := nullif(current_setting('app.principal_name', true), '');
  ELSIF reader = 'platform' THEN
    NEW.via := 'platform';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_messages_before_insert BEFORE INSERT ON room_messages
  FOR EACH ROW EXECUTE FUNCTION app.room_messages_before_insert();

-- What a message owes people: the feed row, its root's count, mentions of
-- those who can see it, replies to followers who still can, and follows.
CREATE FUNCTION app.room_messages_after_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  person text;
  root uuid := coalesce(NEW.thread_of, NEW.id);
BEGIN
  IF NOT app.room_feed_on() THEN RETURN NULL; END IF;
  PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, 'message', NEW.id, NEW.position, NULL,
                              NEW.author, NEW.mentions, NEW.mentions_room);
  IF NEW.thread_of IS NOT NULL THEN
    UPDATE room_messages SET reply_count = reply_count + 1, last_reply_position = NEW.position
     WHERE company_id = NEW.company_id AND id = NEW.thread_of;
  END IF;

  FOREACH person IN ARRAY NEW.mentions LOOP
    IF person <> NEW.author AND app.room_visible_to(NEW.company_id, NEW.room_id, person) THEN
      INSERT INTO room_mentions (company_id, message_id, principal, reason)
      VALUES (NEW.company_id, NEW.id, person, 'mention') ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  IF NEW.mentions_room THEN
    INSERT INTO room_mentions (company_id, message_id, principal, reason)
    SELECT NEW.company_id, NEW.id, m.principal, 'mention'
      FROM room_members m
      JOIN room_places p ON p.company_id = m.company_id AND p.room_id = m.room_id AND p.principal = m.principal
     WHERE m.company_id = NEW.company_id AND m.room_id = NEW.room_id AND m.left_at IS NULL
       AND p.notify <> 'none' AND m.principal <> NEW.author
       AND app.room_visible_to(NEW.company_id, NEW.room_id, m.principal)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.thread_of IS NOT NULL THEN
    INSERT INTO room_mentions (company_id, message_id, principal, reason)
    SELECT NEW.company_id, NEW.id, f.principal, 'reply'
      FROM room_follows f
     WHERE f.company_id = NEW.company_id AND f.root_id = NEW.thread_of AND f.following
       AND f.principal <> NEW.author AND app.room_visible_to(NEW.company_id, NEW.room_id, f.principal)
    ON CONFLICT DO NOTHING;
  END IF;

  IF app.is_person(NEW.author) THEN
    INSERT INTO room_follows (company_id, root_id, principal) VALUES (NEW.company_id, root, NEW.author)
    ON CONFLICT DO NOTHING;
  END IF;
  IF NEW.thread_of IS NULL THEN
    FOREACH person IN ARRAY NEW.mentions LOOP
      IF app.room_visible_to(NEW.company_id, NEW.room_id, person) THEN
        INSERT INTO room_follows (company_id, root_id, principal) VALUES (NEW.company_id, NEW.id, person)
        ON CONFLICT DO NOTHING;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_messages_after_insert AFTER INSERT ON room_messages
  FOR EACH ROW EXECUTE FUNCTION app.room_messages_after_insert();

-- What may change in a message, and by whom. Its author, room, kind,
-- position and origin never change. A person edits their own words within a
-- day (the earlier words kept for the owner), deletes their own (or the
-- owner anyone's: words, files and revisions go at once), and marks their
-- message as having become work by their own press. The platform changes
-- only what a card points at and the state it was drawn in. The control
-- plane leaves only a tombstone when a message's time is up, and recounts
-- replies after an import. An update made inside a trigger -- a reply's
-- count on its root, or a foreign key letting go of a purged task -- may
-- change those and nothing else.
CREATE FUNCTION app.room_messages_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  reader text := app.reader();
  me text := app.principal();
  words boolean := NEW.body IS DISTINCT FROM OLD.body OR NEW.edited_at IS DISTINCT FROM OLD.edited_at;
  removal boolean := NEW.deleted_at IS DISTINCT FROM OLD.deleted_at OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by;
  marked boolean := NEW.became IS DISTINCT FROM OLD.became OR NEW.became_by IS DISTINCT FROM OLD.became_by
                    OR NEW.became_at IS DISTINCT FROM OLD.became_at;
  task boolean := NEW.task_id IS DISTINCT FROM OLD.task_id;
  item boolean := NEW.inbox_item_id IS DISTINCT FROM OLD.inbox_item_id;
  drawn boolean := NEW.notice_values IS DISTINCT FROM OLD.notice_values;
  counted boolean := NEW.reply_count IS DISTINCT FROM OLD.reply_count
                     OR NEW.last_reply_position IS DISTINCT FROM OLD.last_reply_position;
BEGIN
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.room_id <> OLD.room_id
     OR NEW.position <> OLD.position OR NEW.thread_of IS DISTINCT FROM OLD.thread_of
     OR NEW.also_in_room <> OLD.also_in_room OR NEW.kind <> OLD.kind OR NEW.author <> OLD.author
     OR NEW.author_name IS DISTINCT FROM OLD.author_name OR NEW.notice_code IS DISTINCT FROM OLD.notice_code
     OR NEW.mentions <> OLD.mentions OR NEW.mentions_room <> OLD.mentions_room OR NEW.via <> OLD.via
     OR NEW.via_relay IS DISTINCT FROM OLD.via_relay OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a message''s author, room, kind, place and origin never change' USING ERRCODE = 'check_violation';
  END IF;

  IF pg_trigger_depth() > 1 THEN
    IF words OR removal OR marked OR drawn OR (task AND NEW.task_id IS NOT NULL)
       OR (item AND NEW.inbox_item_id IS NOT NULL) THEN
      RAISE EXCEPTION 'only a reply count or a released link changes a message from inside the database'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF reader = 'people' THEN
    IF counted OR drawn OR item THEN
      RAISE EXCEPTION 'a person changes only the words, the removal or the work of a message'
        USING ERRCODE = 'check_violation';
    END IF;
    IF removal THEN
      IF OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL THEN
        RAISE EXCEPTION 'a removed message stays removed' USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.author <> me AND me <> 'owner' THEN
        RAISE EXCEPTION 'only its author or the owner removes a message' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF marked OR task THEN
        RAISE EXCEPTION 'a message is removed, or changed, not both' USING ERRCODE = 'check_violation';
      END IF;
      NEW.body := NULL;
      NEW.edited_at := OLD.edited_at;
      NEW.deleted_at := clock_timestamp();
      NEW.deleted_by := me;
      DELETE FROM room_message_revisions WHERE company_id = OLD.company_id AND message_id = OLD.id;
      UPDATE room_files SET path = NULL WHERE company_id = OLD.company_id AND message_id = OLD.id;
      RETURN NEW;
    END IF;
    IF words THEN
      IF OLD.author <> me OR OLD.kind <> 'text' THEN
        RAISE EXCEPTION 'only its author edits a message' USING ERRCODE = 'insufficient_privilege';
      END IF;
      IF OLD.deleted_at IS NOT NULL OR NEW.body IS NULL OR NEW.body IS NOT DISTINCT FROM OLD.body THEN
        RAISE EXCEPTION 'an edit gives a message new words' USING ERRCODE = 'check_violation';
      END IF;
      IF clock_timestamp() - OLD.created_at >= interval '24 hours' THEN
        RAISE EXCEPTION 'a message is edited within a day of being written' USING ERRCODE = 'check_violation';
      END IF;
      IF marked OR task THEN
        RAISE EXCEPTION 'a message is edited, or becomes work, not both' USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO room_message_revisions (company_id, message_id, body) VALUES (OLD.company_id, OLD.id, OLD.body);
      NEW.edited_at := clock_timestamp();
      RETURN NEW;
    END IF;
    IF marked THEN
      IF OLD.became IS NOT NULL OR NEW.became IS NULL OR NEW.became_by IS DISTINCT FROM me THEN
        RAISE EXCEPTION 'a message becomes something once, by the press of whoever is asking'
          USING ERRCODE = 'check_violation';
      END IF;
      IF OLD.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'a removed message becomes nothing' USING ERRCODE = 'check_violation';
      END IF;
      IF task AND (OLD.task_id IS NOT NULL OR NEW.task_id IS NULL) THEN
        RAISE EXCEPTION 'a message carries the work it became, once' USING ERRCODE = 'check_violation';
      END IF;
      NEW.became_at := clock_timestamp();
      RETURN NEW;
    END IF;
    IF task THEN
      RAISE EXCEPTION 'a message carries work only when it becomes work' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF reader = 'platform' THEN
    IF words OR removal OR marked OR counted THEN
      RAISE EXCEPTION 'the platform changes only what a card points at and how it was drawn'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF reader = 'control' THEN
    IF removal AND NOT (words AND NEW.body IS NOT NULL) AND NOT marked AND NOT task AND NOT item AND NOT drawn
       AND NOT counted AND OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND NEW.deleted_by IS NULL THEN
      NEW.body := NULL;
      NEW.edited_at := OLD.edited_at;
      DELETE FROM room_message_revisions WHERE company_id = OLD.company_id AND message_id = OLD.id;
      UPDATE room_files SET path = NULL WHERE company_id = OLD.company_id AND message_id = OLD.id;
      RETURN NEW;
    END IF;
    IF app.importing() AND counted AND NOT (words OR removal OR marked OR task OR item OR drawn) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'the control plane only leaves a tombstone when a message''s time is up, or recounts an import'
      USING ERRCODE = 'check_violation';
  END IF;
  RAISE EXCEPTION 'a message is changed only by a person, the platform or the control plane'
    USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER room_messages_guard BEFORE UPDATE ON room_messages
  FOR EACH ROW EXECUTE FUNCTION app.room_messages_guard();

CREATE FUNCTION app.room_messages_after_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  what text;
BEGIN
  IF NOT app.room_feed_on() THEN RETURN NULL; END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    what := 'delete';
  ELSIF NEW.body IS DISTINCT FROM OLD.body OR NEW.became IS DISTINCT FROM OLD.became THEN
    what := 'edit';
  ELSIF NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.inbox_item_id IS DISTINCT FROM OLD.inbox_item_id
        OR NEW.notice_values IS DISTINCT FROM OLD.notice_values THEN
    what := 'card';
  ELSE
    -- A reply's count on its root: the reply's own row already said so.
    RETURN NULL;
  END IF;
  PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, what, NEW.id);
  RETURN NULL;
END $$;
CREATE TRIGGER room_messages_after_update AFTER UPDATE ON room_messages
  FOR EACH ROW EXECUTE FUNCTION app.room_messages_after_update();

-- A reaction is for a person's words, never a card: a 👍 approves nothing,
-- and the database says so.
CREATE FUNCTION app.room_reactions_on_words_only() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room_messages
                  WHERE company_id = NEW.company_id AND id = NEW.message_id AND kind = 'text' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'a reaction is for a person''s message, not a card' USING ERRCODE = 'check_violation';
  END IF;
  IF app.reader() <> 'control' THEN NEW.created_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_reactions_on_words_only BEFORE INSERT ON room_reactions
  FOR EACH ROW EXECUTE FUNCTION app.room_reactions_on_words_only();

CREATE FUNCTION app.room_reactions_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed room_reactions%ROWTYPE;
  room uuid;
BEGIN
  IF NOT app.room_feed_on() THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  SELECT room_id INTO room FROM room_messages WHERE company_id = changed.company_id AND id = changed.message_id;
  IF room IS NOT NULL THEN
    PERFORM app.room_feed_write(changed.company_id, room, 'reaction', changed.message_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_reactions_after AFTER INSERT OR DELETE ON room_reactions
  FOR EACH ROW EXECUTE FUNCTION app.room_reactions_after();

-- A pin names a message of its own room.
CREATE FUNCTION app.room_pins_in_room() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM room_messages
                  WHERE company_id = NEW.company_id AND id = NEW.message_id AND room_id = NEW.room_id) THEN
    RAISE EXCEPTION 'a pin is of a message in the room it is pinned in' USING ERRCODE = 'check_violation';
  END IF;
  IF app.reader() <> 'control' THEN NEW.pinned_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_pins_in_room BEFORE INSERT ON room_pins FOR EACH ROW EXECUTE FUNCTION app.room_pins_in_room();

CREATE FUNCTION app.room_pins_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed room_pins%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN changed := OLD; ELSE changed := NEW; END IF;
  IF app.room_feed_on() THEN
    PERFORM app.room_feed_write(changed.company_id, changed.room_id, 'pin', changed.message_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_pins_after AFTER INSERT OR DELETE ON room_pins FOR EACH ROW EXECUTE FUNCTION app.room_pins_after();

-- Card attention, written by the sweep, can never name a private room to
-- someone outside it.
CREATE FUNCTION app.room_mentions_only_for_who_can_see() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  room uuid;
BEGIN
  SELECT room_id INTO room FROM room_messages WHERE company_id = NEW.company_id AND id = NEW.message_id;
  IF room IS NULL OR NOT app.room_visible_to(NEW.company_id, room, NEW.principal) THEN
    RAISE EXCEPTION 'attention goes only to someone who can see the room' USING ERRCODE = 'check_violation';
  END IF;
  IF app.reader() <> 'control' THEN NEW.created_at := clock_timestamp(); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER room_mentions_only_for_who_can_see BEFORE INSERT ON room_mentions
  FOR EACH ROW EXECUTE FUNCTION app.room_mentions_only_for_who_can_see();

-- ---------------------------------------------------------------------------
-- Backfill: every company has its clock, its company room and a room per
-- division, which shows the work that needs people. Memberships come lazily,
-- the first time a person lists the rooms.
--
-- Reading every company as the tables' owner is refused by forced row
-- security without a tenant: lifted on companies for this transaction, and
-- put back before it ends (as 0049, 0118 and 0129). Each company's rooms are
-- written in its own scope, as the platform reader, so the triggers do for
-- them what they do for any room.
ALTER TABLE companies NO FORCE ROW LEVEL SECURITY;
DO $$
DECLARE
  company uuid;
BEGIN
  FOR company IN SELECT id FROM companies ORDER BY created_at, id LOOP
    PERFORM set_config('app.company_id', company::text, true);
    PERFORM set_config('app.reader', 'platform', true);
    INSERT INTO room_clock (company_id) VALUES (company) ON CONFLICT DO NOTHING;
    INSERT INTO rooms (company_id, kind, created_by, shows_work) VALUES (company, 'company', 'platform', 'asked_here')
    ON CONFLICT DO NOTHING;
    INSERT INTO rooms (company_id, kind, division_id, created_by, shows_work)
    SELECT company, 'division', d.id, 'platform', 'needs_people'
      FROM divisions d WHERE d.company_id = company ORDER BY d.created_at, d.id
    ON CONFLICT DO NOTHING;
  END LOOP;
  PERFORM set_config('app.company_id', '', true);
  PERFORM set_config('app.reader', '', true);
END $$;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
