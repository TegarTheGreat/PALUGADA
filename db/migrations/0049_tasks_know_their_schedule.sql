-- ---------------------------------------------------------------------------
-- A task knows which schedule made it
--
-- The only link was the idempotency key's text, `schedule:<id>:<occurrence>`,
-- so "this schedule's recent runs" was `idempotency_key LIKE 'schedule:..%'`.
-- LIKE is not leakproof, so under row security it cannot be an index
-- condition, and the database is not in the C collation that would let a
-- prefix match use one anyway: every schedule that fired sorted all of its
-- company's tasks to find its own five. A column, keyed to the schedule and
-- inside the company like every other reference (0048), and an index on it.
--
-- Existing scheduled tasks are linked from their keys.
-- ---------------------------------------------------------------------------

-- Adding a key or a foreign key reads every existing row as the table's
-- owner, and these tables force row security on their owner as well, which
-- refuses the read without a tenant. Lifted for this transaction on exactly
-- the tables that force it, and put back on exactly those before it ends.
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

ALTER TABLE schedules ADD CONSTRAINT schedules_company_scoped_key UNIQUE (company_id, id);

ALTER TABLE tasks
  ADD COLUMN schedule_id uuid,
  ADD CONSTRAINT tasks_schedule_id_fkey
    FOREIGN KEY (company_id, schedule_id) REFERENCES schedules (company_id, id)
    ON DELETE SET NULL (schedule_id);

CREATE INDEX tasks_schedule_runs_idx
  ON tasks (schedule_id, created_at DESC) WHERE schedule_id IS NOT NULL;

UPDATE tasks task
   SET schedule_id = schedule.id
  FROM schedules schedule
 WHERE task.idempotency_key LIKE 'schedule:%'
   AND schedule.id::text = split_part(task.idempotency_key, ':', 2)
   AND schedule.company_id = task.company_id;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;
