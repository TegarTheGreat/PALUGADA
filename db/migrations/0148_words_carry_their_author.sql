-- Words carry their author (F19.9; the workspace plan, set S0a).
--
-- The owner seats staff beside them, and a seat's words are never the
-- owner's: work a member of staff asked for, or steered, must say so wherever
-- it goes, so that it never uses what the owner allowed for the owner's own
-- work and never comes back to the same person to decide. Today a task's
-- `created_by` can only say that the owner, the scheduler, an event, a run or
-- a webhook began it, so work a seat asked for would have to borrow the
-- owner's name. This gives the database the words to say otherwise; the code
-- that records them and the code that reads them follow in their own sets.

-- Who began a task may be a member of staff: their words are not the owner's.
ALTER TABLE tasks DROP CONSTRAINT tasks_created_by_known,
  ADD CONSTRAINT tasks_created_by_known CHECK (created_by IN
    ('scheduler', 'event', 'agent_run', 'owner', 'webhook', 'staff'));

-- The seat that pressed for the work: a bare uuid, as decided_by_seat (0110),
-- so the record outlives the seat. One way only: staff work the owner pressed
-- has no seat here (its authors are content.staff_said events), and a
-- restored archive keeps created_by = 'staff' without the seat.
ALTER TABLE tasks ADD COLUMN requested_by_seat uuid,
  ADD CONSTRAINT tasks_seat_means_staff CHECK (requested_by_seat IS NULL OR created_by = 'staff');
-- A seat's asks in the last day are counted from here (its daily limit).
CREATE INDEX tasks_requested_by_seat ON tasks (company_id, requested_by_seat, created_at)
  WHERE requested_by_seat IS NOT NULL;

-- The seats whose words began or steered the work a card asks about: none of
-- them may decide it, and the card goes to another approver before the
-- owner.
ALTER TABLE inbox_items ADD COLUMN instigators uuid[] NOT NULL DEFAULT '{}';
-- The team's open cards that have not gone to the owner yet, by when they do.
CREATE INDEX inbox_team_items ON inbox_items (company_id, escalate_at)
  WHERE status = 'open' AND cardinality(instigators) > 0 AND escalated_at IS NULL;

-- A ticket a run filed while staff words were in its work carries their mark
-- into the work it becomes. Written at insert, which the application role
-- may do; never updated: the role's UPDATE on tickets is a column list
-- (0134) that leaves this column out, as it leaves `outside` out.
ALTER TABLE tickets ADD COLUMN instigators uuid[] NOT NULL DEFAULT '{}';
