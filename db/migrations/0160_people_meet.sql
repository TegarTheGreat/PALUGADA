-- People meet people (F19.26; STATUS section 2.215).
--
-- Anyone who may write in a room sets a meeting there: a time, a length, the
-- people asked, and a call link pasted in. Its title and agenda are the
-- setter's own message, which the row names, so the row holds no words but
-- the link; its thread is the notes. The people asked are reminded ten
-- minutes before it starts, once, by the rooms' sweep as the platform and
-- through people's notices, and only while they can still see the room.
--
-- It is not work: nothing here makes a task, reaches a run or writes an
-- event, and agents neither see a meeting nor attend one. Like every room
-- table it opens to no transaction that names no reader (0150).
--
-- A meeting moved after its reminder is reminded again for its new time,
-- once: its people are reminded at most twice, however often it moves, so
-- nobody who may set one spends the people asked's notices for them.

CREATE TABLE room_meetings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  room_id      uuid NOT NULL,
  message_id   uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  minutes      smallint NOT NULL CHECK (minutes BETWEEN 5 AND 480),
  -- The people asked, who must be able to see the room (the guard below).
  attendees    text[] NOT NULL CHECK (app.are_people(attendees) AND cardinality(attendees) BETWEEN 1 AND 50),
  -- Pasted by a person and shown as a plain link; never fetched or unfurled.
  -- Nobody pastes a control character in a link, and none is kept.
  call_url     text CHECK (call_url ~ '^https://[^[:space:]]+$' AND call_url !~ '[\u0001-\u001f\u007f-\u009f]'
                           AND char_length(call_url) <= 2000),
  set_by       text NOT NULL CHECK (app.is_person(set_by)),
  -- When the sweep last reminded its people; cleared when the meeting moves
  -- while it has been reminded only once, so the new time is reminded in
  -- its turn.
  reminded_at  timestamptz,
  -- How often the sweep has reminded them: at most twice, the time it was
  -- set for and one time it moved to. Counted by the guard alone.
  reminders    smallint NOT NULL DEFAULT 0 CHECK (reminders BETWEEN 0 AND 2),
  cancelled_at timestamptz,
  cancelled_by text CHECK (cancelled_by IS NULL OR app.is_person(cancelled_by)),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  -- One meeting a message: the message is its title and agenda.
  UNIQUE (company_id, message_id),
  FOREIGN KEY (company_id, room_id) REFERENCES rooms (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, message_id) REFERENCES room_messages (company_id, id) ON DELETE CASCADE,
  -- Who cancelled it, when a person did; a meeting whose words' time was up
  -- was cancelled with them by nobody.
  CONSTRAINT room_meetings_cancel_names_who CHECK (cancelled_by IS NULL OR cancelled_at IS NOT NULL)
);
-- What the sweep looks for: meetings not yet reminded and still on.
CREATE INDEX room_meetings_soon ON room_meetings (company_id, starts_at) WHERE reminded_at IS NULL AND cancelled_at IS NULL;
-- What the notice planner looks for: meetings reminded and not begun.
CREATE INDEX room_meetings_reminded ON room_meetings (company_id, starts_at) WHERE reminded_at IS NOT NULL AND cancelled_at IS NULL;
SELECT app.enable_room_rls('room_meetings');

-- A person sees the meetings of the rooms they can see; delivery reads who
-- was asked and when, to plan their reminders, and the platform reminds.
CREATE POLICY room_meetings_seen ON room_meetings AS RESTRICTIVE FOR SELECT TO palugada_app USING (
  app.reader() <> 'people'
  OR EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_meetings.company_id AND r.id = room_meetings.room_id));
-- Set by a person, as themselves, from their own words at the top of a room
-- they can see; never by the platform, and never by delivery.
CREATE POLICY room_meetings_set ON room_meetings AS RESTRICTIVE FOR INSERT TO palugada_app WITH CHECK (
  app.reader() = 'people' AND set_by = app.principal()
  AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_meetings.company_id AND r.id = room_meetings.room_id)
  AND EXISTS (SELECT 1 FROM room_messages m
               WHERE m.company_id = room_meetings.company_id AND m.id = room_meetings.message_id
                 AND m.room_id = room_meetings.room_id AND m.author = app.principal()));
-- Changed by a person who can see the room (the guard says which person),
-- and marked reminded by the platform.
CREATE POLICY room_meetings_changed ON room_meetings AS RESTRICTIVE FOR UPDATE TO palugada_app
  USING (app.reader() = 'platform' OR (app.reader() = 'people'
         AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_meetings.company_id AND r.id = room_meetings.room_id)))
  WITH CHECK (app.reader() = 'platform' OR (app.reader() = 'people'
              AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = room_meetings.company_id AND r.id = room_meetings.room_id)));
REVOKE UPDATE ON room_meetings FROM palugada_app;
GRANT UPDATE (starts_at, minutes, attendees, call_url, cancelled_at, cancelled_by, reminded_at) ON room_meetings TO palugada_app;

-- What may be set and changed, and by whom. A meeting is set from a person's
-- own words at the top of the room, words that became no work and no
-- meeting of agents, as theirs, now, unreminded and on. Its room, message
-- and setter never change. Its setter or the owner moves it, changes who is
-- asked, or cancels it, recorded as whoever did; whoever archived its room
-- cancels it and changes nothing else (below); a cancelled meeting stays
-- cancelled, and only its link may go, as it goes with its words. The
-- platform only marks it reminded, which the guard counts; a meeting moved
-- after one reminder is reminded again for its new time, and after a second
-- it is not. It starts in the future when it is set or moved, and everyone
-- asked can see the room when they are asked: someone outside a private room
-- is never asked to its meeting. An archive read in on the control plane
-- keeps its meetings as they were, and a transaction of no person and not
-- the platform's is left to row security to refuse.
CREATE FUNCTION app.room_meetings_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  reader text := app.reader();
  me text := app.principal();
  words room_messages%ROWTYPE;
  person text;
BEGIN
  IF reader NOT IN ('people', 'platform') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO words FROM room_messages WHERE company_id = NEW.company_id AND id = NEW.message_id;
    IF NOT FOUND OR words.room_id <> NEW.room_id OR words.kind <> 'text' OR words.thread_of IS NOT NULL
       OR words.deleted_at IS NOT NULL OR words.became IS NOT NULL THEN
      RAISE EXCEPTION 'a meeting is set from words at the top of its own room that became nothing else: its thread is the notes'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL THEN
      RAISE EXCEPTION 'a meeting is set on; it is cancelled afterwards, by whoever cancels it' USING ERRCODE = 'check_violation';
    END IF;
    NEW.set_by := me;
    NEW.created_at := clock_timestamp();
    NEW.reminded_at := NULL;
    NEW.reminders := 0;
  ELSE
    IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.room_id <> OLD.room_id
       OR NEW.message_id <> OLD.message_id OR NEW.set_by <> OLD.set_by OR NEW.created_at <> OLD.created_at THEN
      RAISE EXCEPTION 'a meeting''s room, message and setter never change' USING ERRCODE = 'check_violation';
    END IF;
    IF reader = 'platform' THEN
      IF NEW.starts_at <> OLD.starts_at OR NEW.minutes <> OLD.minutes OR NEW.attendees <> OLD.attendees
         OR NEW.call_url IS DISTINCT FROM OLD.call_url OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
         OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by THEN
        RAISE EXCEPTION 'the platform only marks a meeting reminded' USING ERRCODE = 'check_violation';
      END IF;
      IF NEW.reminded_at IS DISTINCT FROM OLD.reminded_at THEN
        IF OLD.reminded_at IS NOT NULL OR NEW.reminded_at IS NULL THEN
          RAISE EXCEPTION 'a meeting is marked reminded once for each time it is reminded of' USING ERRCODE = 'check_violation';
        END IF;
        NEW.reminders := OLD.reminders + 1;
      ELSE
        NEW.reminders := OLD.reminders;
      END IF;
      RETURN NEW;
    END IF;
    NEW.reminders := OLD.reminders;
    IF NEW.reminded_at IS DISTINCT FROM OLD.reminded_at THEN
      RAISE EXCEPTION 'a meeting is marked reminded by the platform' USING ERRCODE = 'check_violation';
    END IF;
    IF me IS DISTINCT FROM OLD.set_by AND me IS DISTINCT FROM 'owner'
       AND NOT (OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL
                AND NEW.starts_at = OLD.starts_at AND NEW.minutes = OLD.minutes AND NEW.attendees = OLD.attendees
                AND NEW.call_url IS NOT DISTINCT FROM OLD.call_url
                AND EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = NEW.company_id AND r.id = NEW.room_id AND r.archived_by = me)) THEN
      RAISE EXCEPTION 'a meeting is changed by whoever set it, or the owner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.cancelled_at IS NOT NULL THEN
      -- Its link may still go, as it goes when its words are removed; nothing
      -- else changes, not even who cancelled it.
      IF NEW.call_url IS NOT NULL OR NEW.starts_at <> OLD.starts_at OR NEW.minutes <> OLD.minutes
         OR NEW.attendees <> OLD.attendees OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
         OR NEW.cancelled_by IS DISTINCT FROM OLD.cancelled_by THEN
        RAISE EXCEPTION 'a cancelled meeting stays cancelled' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL THEN
      NEW.cancelled_at := clock_timestamp();
      NEW.cancelled_by := me;
    END IF;
    -- Moved after one reminder, it is reminded again for its new time; after
    -- a second, it stays reminded, so moving it tells nobody anything more.
    IF NEW.starts_at <> OLD.starts_at AND OLD.reminders < 2 THEN
      NEW.reminded_at := NULL;
    END IF;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.starts_at <> OLD.starts_at) AND NEW.starts_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'a meeting starts in the future' USING ERRCODE = 'check_violation', CONSTRAINT = 'room_meetings_starts_ahead';
  END IF;
  FOREACH person IN ARRAY NEW.attendees LOOP
    IF (TG_OP = 'INSERT' OR NOT person = ANY (OLD.attendees))
       AND NOT app.room_visible_to(NEW.company_id, NEW.room_id, person) THEN
      RAISE EXCEPTION 'everyone asked to a meeting must be able to see the room: % cannot', person
        USING ERRCODE = 'check_violation', CONSTRAINT = 'room_meetings_attendees_see';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER room_meetings_guard BEFORE INSERT OR UPDATE ON room_meetings
  FOR EACH ROW EXECUTE FUNCTION app.room_meetings_guard();

-- A meeting set, moved, cancelled or reminded: the rooms that show its
-- message draw it again, as a card that moved is drawn again (0150).
CREATE FUNCTION app.room_meetings_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF app.room_feed_on() THEN
    PERFORM app.room_feed_write(NEW.company_id, NEW.room_id, 'card', NEW.message_id);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_meetings_after AFTER INSERT OR UPDATE ON room_meetings
  FOR EACH ROW EXECUTE FUNCTION app.room_meetings_after();

-- A meeting's words removed are the meeting cancelled, and take its pasted
-- link with them, as a removal takes everything said (0150): a link often
-- carries the call's password. Cancelled by whoever removed them -- its
-- setter, whose words they were, or the owner -- or, when their time was up
-- under the owner's window, by nobody; one cancelled already keeps who
-- cancelled it. Either way the sweep reminds nobody of it.
CREATE FUNCTION app.room_messages_meeting_gone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE room_meetings
     SET call_url = NULL, cancelled_at = coalesce(cancelled_at, clock_timestamp()), cancelled_by = coalesce(cancelled_by, NEW.deleted_by)
   WHERE company_id = NEW.company_id AND message_id = NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER room_messages_meeting_gone AFTER UPDATE OF deleted_at ON room_messages
  FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
  EXECUTE FUNCTION app.room_messages_meeting_gone();

-- A meeting's room archived is the meeting cancelled, unless it has begun:
-- an archived room takes no words and no change, so a meeting left on there
-- could be neither moved nor cancelled, and its people would be reminded of
-- it all the same. Cancelled by whoever archived the room -- its creator or
-- the owner, who may not have set it -- in the same transaction; one under
-- way is left to end, and one cancelled before keeps who cancelled it.
CREATE FUNCTION app.rooms_archived_meetings_gone() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE room_meetings SET cancelled_at = clock_timestamp(), cancelled_by = NEW.archived_by
   WHERE company_id = NEW.company_id AND room_id = NEW.id AND cancelled_at IS NULL AND starts_at > clock_timestamp();
  RETURN NULL;
END $$;
CREATE TRIGGER rooms_archived_meetings_gone AFTER UPDATE OF archived_at ON rooms
  FOR EACH ROW WHEN (OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL)
  EXECUTE FUNCTION app.rooms_archived_meetings_gone();

-- The people asked are told outside PALUGADA too: a reminder is a people's
-- notice of its own reason, about the meeting, naming its room.
ALTER TABLE people_notices
  DROP CONSTRAINT people_notices_reason_check,
  ADD CONSTRAINT people_notices_reason_check CHECK (reason IN
    ('direct', 'mention', 'reply', 'question', 'approval', 'work_done', 'meeting')),
  DROP CONSTRAINT people_notices_subject_check,
  ADD CONSTRAINT people_notices_subject_check CHECK (
    subject ~ '^(message|item|task|meeting):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  ADD CONSTRAINT people_notices_meeting_names_its_room CHECK (
    (reason = 'meeting') = (subject LIKE 'meeting:%') AND (reason <> 'meeting' OR room_id IS NOT NULL));

-- A reminder that carried a meeting's title is retracted with its words, as
-- a notice of words is (STATUS section 2.213): found by company as those are.
CREATE INDEX relay_outbox_meeting_soon ON relay_outbox (company_id) WHERE type = 'meeting_soon';
