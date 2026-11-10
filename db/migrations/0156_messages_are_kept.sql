-- How long a company keeps what its people said (F19.15; STATUS section 2.212).
--
-- Messages are kept unless the owner sets a window, which is a month at the
-- least: a shorter one would take a conversation away while people are still
-- having it. NULL keeps them, which is the default and is said as such, never
-- as a number of days nobody chose. Ten years is the most, as for a company's
-- other history.
ALTER TABLE retention_policies ADD COLUMN message_days integer
  CONSTRAINT retention_messages_bounded CHECK (message_days IS NULL OR message_days BETWEEN 30 AND 3650);

-- A purge of messages is recorded like every other purge (0007): removing
-- what was said is the one change that can make a room's history lie by
-- omission.
ALTER TABLE retention_log
  DROP CONSTRAINT retention_action_known,
  ADD CONSTRAINT retention_action_known
    CHECK (action IN ('events_purged', 'traces_purged', 'prompts_scrubbed',
                      'journal_scrubbed', 'bookkeeping_purged', 'work_purged', 'messages_purged'));

-- A message removed outright -- a reply past the window, a card whose work
-- retention took -- takes itself off its thread's count, and tells whoever
-- has the room open. A reply's count was only ever raised (0150), so a thread
-- that lost its old replies went on saying it had them. The thread's count
-- and its last reply are counted again from what is left, once a statement,
-- whatever it removed; an update from inside a trigger may change those and
-- nothing else (0150's guard). A company's erasure names no company and no
-- reader, and every row of the company goes with it: there is nothing left
-- to count or tell, and nothing here is asked.
CREATE FUNCTION app.room_messages_after_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF nullif(current_setting('app.company_id', true), '') IS NULL THEN RETURN NULL; END IF;
  UPDATE room_messages m
     SET reply_count = counted.n, last_reply_position = counted.last
    FROM (SELECT g.company_id, g.thread_of AS root,
                 (SELECT count(*)::int FROM room_messages r
                   WHERE r.company_id = g.company_id AND r.thread_of = g.thread_of) AS n,
                 (SELECT max(r.position) FROM room_messages r
                   WHERE r.company_id = g.company_id AND r.thread_of = g.thread_of) AS last
            FROM (SELECT DISTINCT company_id, thread_of FROM gone WHERE thread_of IS NOT NULL) g) counted
   WHERE m.company_id = counted.company_id AND m.id = counted.root
     AND (m.reply_count <> counted.n OR m.last_reply_position IS DISTINCT FROM counted.last);
  IF app.room_feed_on() THEN
    -- Its room may have gone in the same statement; only a room still there is told.
    PERFORM app.room_feed_write(g.company_id, g.room_id, 'delete', g.id)
       FROM gone g
      WHERE EXISTS (SELECT 1 FROM rooms r WHERE r.company_id = g.company_id AND r.id = g.room_id)
      ORDER BY g.position;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER room_messages_after_delete AFTER DELETE ON room_messages
  REFERENCING OLD TABLE AS gone
  FOR EACH STATEMENT EXECUTE FUNCTION app.room_messages_after_delete();
