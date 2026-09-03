-- Phase 4 (PRD v2): a scheduled task needs a goal like any other (F2.7).

-- A schedule creates root tasks, and a root task names the goal it serves. The
-- schedule is where that answer belongs: the goal is the same on every
-- occurrence, and asking the scheduler to invent one each time it fires would
-- produce a different answer at 03:00 than at 09:00.
ALTER TABLE schedules ADD COLUMN goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;
