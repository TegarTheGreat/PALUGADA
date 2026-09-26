-- ---------------------------------------------------------------------------
-- Telling the owner that work they gave has finished
--
-- Nothing did. The owner gave a role something to do and learned it was done
-- by opening the console and looking, which is the opposite of a company that
-- runs while its owner is elsewhere. Buzz calls it the callback mention.
--
-- A notice is the third thing a notification row can be about, beside an
-- inbox item and a day's digest: a task the owner assigned that has ended.
-- Its row is the no-repeat rule, as the others' are.
-- ---------------------------------------------------------------------------

-- Checking the new constraints reads the existing rows as the tables' owner,
-- and both tables force row security on their owner too; lifted for this
-- transaction on exactly these two, as 0048 does, and put back below.
ALTER TABLE owner_notifications NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks NO FORCE ROW LEVEL SECURITY;

ALTER TABLE owner_notifications
  ADD COLUMN task_id uuid,
  ADD CONSTRAINT owner_notifications_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT owner_notifications_item_or_digest,
  ADD CONSTRAINT owner_notifications_one_subject
    CHECK (num_nonnulls(inbox_item_id, digest_day, task_id) = 1);

CREATE UNIQUE INDEX owner_notifications_task_once
  ON owner_notifications (company_id, channel, task_id)
  WHERE task_id IS NOT NULL;

ALTER TABLE owner_notifications FORCE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
