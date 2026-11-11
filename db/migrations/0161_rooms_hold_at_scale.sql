-- The rooms at a company's real size, and what people may do in them
-- (F19.4, F19.9, F19.13, F19.15, F19.21; STATUS section 2.217).

-- ---------------------------------------------------------------------------
-- Retention takes a long history in turns, and tells an open room once a turn.
--
-- Every row a statement writes into the feed takes a position from the
-- company's clock, which is one row: updated again and again inside one
-- transaction, each update reaches its row through every version the
-- transaction left before it, so a purge of forty thousand messages spent
-- most of its two minutes walking the clock, holding it -- and with it every
-- post, edit, reaction and read mark of the company -- the whole time. A pass
-- of the control plane that says it is quiet (`roomsOnControlPlane`'s
-- `quiet`) writes no feed row per message, pin or meeting it touches; it
-- touches each room it changed once at the end of its turn, which is the one
-- change an open stream reads, as an import does.
CREATE OR REPLACE FUNCTION app.room_feed_on() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT app.reader() <> 'none' AND NOT app.importing()
            AND NOT (app.reader() = 'control' AND coalesce(current_setting('app.quiet', true), '') = 'on') $$;

-- ---------------------------------------------------------------------------
-- A restore takes its positions in one step.
--
-- An archive's messages are read in, in their old order, in the one
-- transaction a restore is; a position taken from the clock for each was one
-- update of the clock's row each, which grows with the square of the
-- messages and kept a busy company's archive from ever coming back. The
-- control plane, while importing, takes as many positions as it has messages
-- in one step, and each message keeps the one it was given, if that one is
-- in the range just taken: a position outside it, or any position given by
-- anyone else, is taken from the clock as before. The range is this
-- transaction's alone.
CREATE FUNCTION app.take_room_positions(company uuid, wanted integer) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  last bigint;
BEGIN
  IF app.reader() <> 'control' OR NOT app.importing() THEN
    RAISE EXCEPTION 'positions are taken together only while the control plane reads an archive in'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF wanted IS NULL OR wanted < 1 THEN
    RAISE EXCEPTION 'take at least one position' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO room_clock (company_id) VALUES (company) ON CONFLICT DO NOTHING;
  UPDATE room_clock SET position = position + wanted WHERE company_id = company RETURNING position INTO last;
  IF last IS NULL THEN
    RAISE EXCEPTION 'a room of company % is written only in that company''s own transaction', company
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('app.positions_from', (last - wanted + 1)::text, true),
          set_config('app.positions_to', last::text, true);
  RETURN last - wanted + 1;
END $$;
REVOKE EXECUTE ON FUNCTION app.take_room_positions(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_room_positions(uuid, integer) TO palugada_admin;

-- 0150's insert guard, with the one change above: a message read in keeps a
-- position its transaction took for it.
CREATE OR REPLACE FUNCTION app.room_messages_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  root room_messages%ROWTYPE;
  reader text := app.reader();
BEGIN
  IF NOT coalesce(reader = 'control' AND app.importing()
                  AND NEW.position BETWEEN coalesce(nullif(current_setting('app.positions_from', true), '')::bigint, 1)
                                       AND coalesce(nullif(current_setting('app.positions_to', true), '')::bigint, 0), false) THEN
    NEW.position := app.next_room_position(NEW.company_id);
  END IF;
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

-- ---------------------------------------------------------------------------
-- A restore gives a room's access only from its members.
--
-- A private room's creator was given access as the room was written, even
-- while an archive was read in, so a restore let a seat back into a room the
-- archive says it had left -- a revoked seat's direct room, a private room it
-- made and was taken out of. Read in, a room's access is its members' alone,
-- which their own rows give as they come (0150).
CREATE OR REPLACE FUNCTION app.rooms_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.private AND app.is_person(NEW.created_by) AND NOT app.importing() THEN
    INSERT INTO room_access (company_id, room_id, principal) VALUES (NEW.company_id, NEW.id, NEW.created_by)
    ON CONFLICT DO NOTHING;
  END IF;
  IF app.room_feed_on() THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.id, 'room', NULL);
  END IF;
  RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- A lesson says whose words taught it.
--
-- What work a member of staff asked for or spoke to taught the company -- a
-- lesson its run declared, a fact distilled from its record, an issue solved
-- in it -- was kept as the company's own, and reached the owner's later work
-- as a known fact with no mark that a colleague's words were in it: the hold
-- at tier 2 and four eyes no longer saw them (F19.9). Such a memory now names
-- the seats, as `staffWordsIn` names them, and is never a known fact: a run
-- is told it inside a colleague's fence and carries those words from then on.
-- An empty list is the company's own, which every memory before this is.
ALTER TABLE memories ADD COLUMN staff jsonb NOT NULL DEFAULT '[]'::jsonb
  CONSTRAINT memories_staff_listed CHECK (jsonb_typeof(staff) = 'array' AND jsonb_array_length(staff) <= 20);

-- ---------------------------------------------------------------------------
-- A reaction is one emoji (F19.4).
--
-- 0150 held a reaction to sixteen characters of anything, so a word, a tag,
-- a direction override or nothing visible at all could be pinned under a
-- colleague's message as a "reaction". The server holds a reaction to one
-- emoji as Unicode lists them (`\p{RGI_Emoji}`); the database holds the same
-- shape: a keycap, a pair of regional indicators, a tag sequence, or
-- pictographs with their modifiers joined by zero width joiners, sixteen
-- code points at most. It reads the words as UTF-8 bytes and decodes them
-- itself, so it says the same whatever encoding the database was made in. A
-- reaction read in from Slack by one of its old authors may keep a custom
-- emoji's name, which no Unicode emoji draws.
CREATE FUNCTION app.is_pictograph(cp integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT cp IN (169, 174, 8252, 8265, 8482, 8505, 9000, 9167, 9410, 9654, 9664, 11088, 11093, 12336, 12349, 12951, 12953)
      OR cp BETWEEN 8596 AND 8601 OR cp BETWEEN 8617 AND 8618 OR cp BETWEEN 8986 AND 8987
      OR cp BETWEEN 9193 AND 9203 OR cp BETWEEN 9208 AND 9210 OR cp BETWEEN 9642 AND 9643
      OR cp BETWEEN 9723 AND 9726 OR cp BETWEEN 9728 AND 10175 OR cp BETWEEN 10548 AND 10549
      OR cp BETWEEN 11013 AND 11015 OR cp BETWEEN 11035 AND 11036 OR cp BETWEEN 126976 AND 129791 $$;

CREATE FUNCTION app.is_reaction(emoji text, author text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  b bytea;
  n integer;
  i integer := 0;
  lead integer;
  width integer;
  cp integer;
  cps integer[] := '{}';
  m integer;
  wants_picture boolean := true;
BEGIN
  IF emoji IS NULL THEN RETURN false; END IF;
  IF author LIKE 'former:%' AND emoji ~ '^:[a-z0-9_+''-]{1,30}:$' THEN RETURN true; END IF;
  b := convert_to(emoji, 'UTF8');
  n := octet_length(b);
  IF n = 0 OR n > 64 THEN RETURN false; END IF;
  WHILE i < n LOOP
    lead := get_byte(b, i);
    IF lead < 128 THEN cp := lead; width := 1;
    ELSIF lead >= 240 THEN cp := lead & 7; width := 4;
    ELSIF lead >= 224 THEN cp := lead & 15; width := 3;
    ELSIF lead >= 192 THEN cp := lead & 31; width := 2;
    ELSE RETURN false;
    END IF;
    IF i + width > n THEN RETURN false; END IF;
    FOR k IN 1 .. width - 1 LOOP
      cp := (cp << 6) | (get_byte(b, i + k) & 63);
    END LOOP;
    cps := cps || cp;
    i := i + width;
  END LOOP;
  m := array_length(cps, 1);
  IF m > 16 THEN RETURN false; END IF;
  -- A keycap: a digit, # or *, its emoji form, and the keycap.
  IF cps[1] IN (35, 42) OR cps[1] BETWEEN 48 AND 57 THEN
    RETURN (m = 2 AND cps[2] = 8419) OR (m = 3 AND cps[2] = 65039 AND cps[3] = 8419);
  END IF;
  -- A country's flag: two regional indicators.
  IF cps[1] BETWEEN 127462 AND 127487 THEN
    RETURN m = 2 AND cps[2] BETWEEN 127462 AND 127487;
  END IF;
  -- A region's flag: the black flag, tags, and the cancel tag.
  IF cps[1] = 127988 AND m > 2 AND cps[2] BETWEEN 917536 AND 917630 THEN
    FOR k IN 2 .. m - 1 LOOP
      IF NOT cps[k] BETWEEN 917536 AND 917630 THEN RETURN false; END IF;
    END LOOP;
    RETURN cps[m] = 917631;
  END IF;
  -- Pictographs, each with its emoji form or skin tone, joined by zero width joiners.
  FOR k IN 1 .. m LOOP
    cp := cps[k];
    IF wants_picture THEN
      IF NOT app.is_pictograph(cp) THEN RETURN false; END IF;
      wants_picture := false;
    ELSIF cp = 65039 OR cp BETWEEN 127995 AND 127999 THEN
      CONTINUE;
    ELSIF cp = 8205 THEN
      wants_picture := true;
    ELSE
      RETURN false;
    END IF;
  END LOOP;
  RETURN NOT wants_picture;
END $$;

-- What 0150 let in that is no emoji goes: it was never a reaction. Row
-- security is lifted for the statement and restored, as 0157 does.
ALTER TABLE room_reactions NO FORCE ROW LEVEL SECURITY;
DELETE FROM room_reactions WHERE NOT app.is_reaction(emoji, principal);
ALTER TABLE room_reactions FORCE ROW LEVEL SECURITY;
ALTER TABLE room_reactions
  DROP CONSTRAINT room_reactions_emoji_check,
  ADD CONSTRAINT room_reactions_one_emoji CHECK (app.is_reaction(emoji, principal));

-- ---------------------------------------------------------------------------
-- A retry key belongs to the room it was posted in (F19.20).
--
-- A post's `clientId` was unique for its author across the company, so the
-- same key sent to another room was answered with the message of the first
-- room, and the new words were never posted; and once the first room was
-- one the author could no longer see, the post failed on this index with the
-- database's own words. A relay's reply lands in the room its token names
-- and no other. The key is now the room's: the same key in another room is
-- new words there, and in another thread of the same room is refused by
-- name (`message.client_id_used`).
DROP INDEX room_messages_once;
CREATE UNIQUE INDEX room_messages_once ON room_messages (company_id, room_id, author, client_id) WHERE client_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- How much a company's room files may take (F19.4).
--
-- Twenty-four megabytes a post, thirty posts a minute, and no limit but the
-- disk: one seat could fill the deployment's. A company's room files are
-- held to a number of megabytes the owner sets, ten gigabytes until they do,
-- and a post that would pass it keeps nothing and says so.
ALTER TABLE companies ADD COLUMN room_files_megabytes integer NOT NULL DEFAULT 10240
  CONSTRAINT companies_room_files_bounded CHECK (room_files_megabytes BETWEEN 1 AND 1048576);

-- What a company's room files take, over every room of it: a post counts
-- them against the limit as the person posting, who cannot see every room,
-- so the database counts them, for that company only, and answers a number.
CREATE FUNCTION app.room_files_kept(company uuid) RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF company IS DISTINCT FROM nullif(current_setting('app.company_id', true), '')::uuid THEN
    RAISE EXCEPTION 'a company counts only its own room files' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT coalesce(sum(bytes), 0) FROM room_files WHERE company_id = company AND path IS NOT NULL);
END $$;
REVOKE EXECUTE ON FUNCTION app.room_files_kept(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.room_files_kept(uuid) TO palugada_app;

-- ---------------------------------------------------------------------------
-- A message to a seat, or its name, is told past its daily number (F19.13).
--
-- A seat's daily number keeps a busy day's noise off its phone: thirty room
-- windows, then only a count the next morning. A direct message or a
-- mention by name past it was that count, and a person missed what was
-- addressed to them. A notice the planner marks `named` is sent past the
-- number and spends none of it; an @room, a reply and agent work are held
-- to it as before. The owner's number holds every notice: the owner's day
-- is what it keeps (G3).
ALTER TABLE people_notices ADD COLUMN named boolean NOT NULL DEFAULT false;
