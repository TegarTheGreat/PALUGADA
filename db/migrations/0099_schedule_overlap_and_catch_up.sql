-- ---------------------------------------------------------------------------
-- What a schedule does while its last run is live, and when it is too late
-- (F9.1)
--
-- `runDueSchedules` fired an occurrence whether or not the task the previous
-- one created was still live. An hourly job whose work takes seventy
-- minutes, or a daily one whose task waits two days for the owner's
-- approval, got a second task beside the first: twice the spend, and two runs
-- doing the same work. `overlap` says what a due occurrence does instead:
--
--   skip   it does not run; the schedule moves to its next occurrence and the
--          skipped one is recorded, naming the live task. The default, for
--          the schedules that exist as much as for new ones: a second run
--          beside a live one is the surprise, not the rule.
--   queue  the schedule waits, and fires once when the live task has ended.
--   allow  it runs beside the live one, which is how every schedule ran
--          before this.
--
-- And after downtime one catch-up run happened however late it was, so a
-- 07:00 briefing came back at 19:00. `catch_up_minutes` is how late an
-- occurrence may be and still run; past it the occurrence is dropped and
-- recorded with how many were. Null keeps the one catch-up run. The floor of
-- fifteen minutes is `MIN_CATCH_UP_MINUTES` in src/scheduler/scheduler.ts,
-- where the reason for it is written; a year is the ceiling, since a window
-- longer than the longest gap a cron expression can have means nothing more.
--
-- The rest is what the schedule remembers so each of these is written once,
-- not on every pass (the pass runs every few seconds; 0038 is why that
-- matters), and so the owner sees why an occurrence did not run:
--
--   held_by_task_id  the live task a queued occurrence waits for; cleared
--                    whenever the schedule moves on.
--   skipped_*        the last occurrence that did not run: when, why
--                    ('overlap' or 'late'), how many occurrences that pass
--                    dropped, and the live task it gave way to.
--
-- Both task references carry the company, like every reference between
-- tenant tables (0048), and let go of a task that is deleted rather than
-- refuse its deletion.
--
-- The application role already writes every column of `schedules` (0047's
-- grants are per table), so nothing is granted here.
-- ---------------------------------------------------------------------------

ALTER TABLE schedules
  ADD COLUMN overlap text NOT NULL DEFAULT 'skip'
    CONSTRAINT schedules_overlap_known CHECK (overlap IN ('skip', 'queue', 'allow')),
  ADD COLUMN catch_up_minutes integer
    CONSTRAINT schedules_catch_up_range CHECK (catch_up_minutes BETWEEN 15 AND 525600),
  ADD COLUMN held_by_task_id uuid,
  ADD COLUMN skipped_for timestamptz,
  ADD COLUMN skipped_because text
    CONSTRAINT schedules_skipped_because_known CHECK (skipped_because IN ('overlap', 'late')),
  ADD COLUMN skipped_count integer
    CONSTRAINT schedules_skipped_count_positive CHECK (skipped_count >= 1),
  ADD COLUMN skipped_task_id uuid,
  -- A skip is recorded whole or not at all: an occurrence without its reason
  -- is a schedule the owner cannot explain.
  ADD CONSTRAINT schedules_skipped_whole CHECK (
    (skipped_for IS NULL) = (skipped_because IS NULL)
    AND (skipped_for IS NULL) = (skipped_count IS NULL)
  );

-- Adding a foreign key reads every existing row as the table's owner, and
-- these tables force row security on their owner as well, which refuses the
-- read without a tenant. Lifted for this transaction on exactly the tables
-- that force it, and put back on exactly those before it ends (as in 0048).
CREATE TEMPORARY TABLE forced_row_security ON COMMIT DROP AS
  SELECT oid::regclass AS target FROM pg_class
   WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

ALTER TABLE schedules
  ADD CONSTRAINT schedules_held_by_task_fkey
    FOREIGN KEY (company_id, held_by_task_id) REFERENCES tasks (company_id, id)
    ON DELETE SET NULL (held_by_task_id),
  ADD CONSTRAINT schedules_skipped_task_fkey
    FOREIGN KEY (company_id, skipped_task_id) REFERENCES tasks (company_id, id)
    ON DELETE SET NULL (skipped_task_id);

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

-- A due schedule asks whether a task it made is still live, and a queued one
-- asks on every pass until it is not. The runs index (0049) would read every
-- task a schedule ever made to find the one or two that are live; this one
-- holds only those, so it stays the size of the work in flight. The
-- predicate is spelled as `liveTaskOf` spells it, so the planner can match
-- them. A plain CREATE INDEX, for the reason 0098 gives.
CREATE INDEX tasks_schedule_live_idx ON tasks (schedule_id)
  WHERE schedule_id IS NOT NULL
    AND status NOT IN ('completed', 'failed', 'halted', 'cancelled');
