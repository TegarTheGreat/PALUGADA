-- People are told (F19.13, F19.20; STATUS section 2.213).
--
-- A person who linked a phone is told what is theirs: a direct message, a
-- mention, a reply in a thread they follow, a run's question put to them, an
-- approval they may decide, work they asked for that ended. Each notice is a
-- row here, planned by the worker under the delivery reader, which sees ids
-- and positions and never a word, and sent once per person, channel and room
-- window: a burst in one room is one notice whose count grows. The words, when
-- the share allows them, are read just before sending as the person told, so
-- a room they can no longer see tells them nothing.
--
-- Bookkeeping, not the company's record: not exported, and purged after
-- thirty days.

CREATE TABLE people_notices (
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  principal       text NOT NULL CHECK (app.is_person(principal)),
  -- The room a notice about words is about; NULL for a question, an approval
  -- or work done, whose room (if any) is read as the person when sent.
  room_id         uuid,
  reason          text NOT NULL CHECK (reason IN ('direct', 'mention', 'reply', 'question', 'approval', 'work_done')),
  -- 'message:<id>' (the first message of the window), 'item:<id>' or 'task:<id>'.
  subject         text NOT NULL CHECK (subject ~ '^(message|item|task):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  -- The newest position a notice about words covers: read past it, it is read.
  position        bigint CHECK (position > 0),
  -- The room and the moment its window opened, or the subject told once.
  window_key      text NOT NULL CHECK (char_length(window_key) BETWEEN 1 AND 120),
  count           smallint NOT NULL DEFAULT 1 CHECK (count >= 1),
  -- The person's own day it was counted in, against their daily number.
  day             date NOT NULL,
  channel         text NOT NULL CHECK (channel ~ '^(relay:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|chat:[a-z_]{1,32})$'),
  -- The end of the person's quiet hours, or of the owner's window.
  notify_after    timestamptz NOT NULL DEFAULT now(),
  attempts        smallint NOT NULL DEFAULT 0,
  last_attempt_at timestamptz,
  delivered_at    timestamptz,
  settled_as      text CHECK (settled_as IN ('sent', 'read', 'capped', 'gone')),
  -- Why a send failed, as a code; a claim with neither this nor a delivery
  -- is a send whose outcome was never learned, and is never made again.
  last_error      text CHECK (char_length(last_error) <= 500),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  CONSTRAINT people_notices_once UNIQUE (company_id, principal, channel, window_key),
  CONSTRAINT people_notices_words_name_a_room CHECK (
    (reason IN ('direct', 'mention', 'reply')) = (subject LIKE 'message:%')
    AND (reason NOT IN ('direct', 'mention', 'reply') OR (room_id IS NOT NULL AND position IS NOT NULL))),
  CONSTRAINT people_notices_delivered_is_sent CHECK (delivered_at IS NULL OR settled_as = 'sent')
);
CREATE INDEX people_notices_due ON people_notices (company_id, notify_after) WHERE delivered_at IS NULL AND settled_as IS NULL;
CREATE INDEX people_notices_window ON people_notices (company_id, principal, channel, room_id, created_at) WHERE room_id IS NOT NULL;
CREATE INDEX people_notices_age ON people_notices (company_id, created_at);
SELECT app.enable_room_rls('people_notices');
-- Nobody's notices are a person's to read: what was sent to whom, and when,
-- is delivery's bookkeeping, as a colleague's read mark is no read receipt.
CREATE POLICY people_notices_bookkeeping ON people_notices AS RESTRICTIVE TO palugada_app
  USING (app.reader() IN ('delivery', 'platform')) WITH CHECK (app.reader() IN ('delivery', 'platform'));
REVOKE UPDATE ON people_notices FROM palugada_app;
GRANT UPDATE (count, position, day, notify_after, attempts, last_attempt_at, delivered_at, settled_as, last_error)
  ON people_notices TO palugada_app;
-- Purged after thirty days by the planner, under the delivery reader.
GRANT DELETE ON people_notices TO palugada_app;

-- How far the planner has read the company's feed. On the clock row, whose
-- lock every room write takes first: the planner takes it too, so two
-- workers plan one company one at a time, and every position up to the clock
-- is committed and seen when it reads.
ALTER TABLE room_clock ADD COLUMN notices_through bigint NOT NULL DEFAULT 0 CHECK (notices_through >= 0);

-- The cursor, taken with the clock's lock, for the delivery reader of the
-- transaction's own company.
CREATE FUNCTION app.take_notice_cursor(company uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  through bigint;
BEGIN
  IF app.reader() <> 'delivery' OR company::text IS DISTINCT FROM current_setting('app.company_id', true) THEN
    RAISE EXCEPTION 'only delivery takes its own company''s notice cursor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT notices_through INTO through FROM room_clock WHERE company_id = company FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO room_clock (company_id) VALUES (company) ON CONFLICT DO NOTHING;
    SELECT notices_through INTO through FROM room_clock WHERE company_id = company FOR UPDATE;
  END IF;
  RETURN through;
END $$;

-- The cursor moved on, never back.
CREATE FUNCTION app.advance_notice_cursor(company uuid, through bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.reader() <> 'delivery' OR company::text IS DISTINCT FROM current_setting('app.company_id', true) THEN
    RAISE EXCEPTION 'only delivery moves its own company''s notice cursor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE room_clock SET notices_through = GREATEST(notices_through, through) WHERE company_id = company;
END $$;
REVOKE EXECUTE ON FUNCTION app.take_notice_cursor(uuid), app.advance_notice_cursor(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.take_notice_cursor(uuid), app.advance_notice_cursor(uuid, bigint) TO palugada_app;
