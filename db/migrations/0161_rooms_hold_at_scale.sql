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
  IF NOT (reader = 'control' AND app.importing()
          AND NEW.position BETWEEN coalesce(nullif(current_setting('app.positions_from', true), '')::bigint, 1)
                               AND coalesce(nullif(current_setting('app.positions_to', true), '')::bigint, 0)) THEN
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
