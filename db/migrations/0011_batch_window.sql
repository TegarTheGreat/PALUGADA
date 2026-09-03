-- Phase 4: running non-urgent read-only work in cheap hours (F9.5).

-- ---------------------------------------------------------------------------
-- F9.5 asks for tier 0, non-urgent tasks to run in cheap hours where the
-- provider charges by time of day. Three constraints shape it.
--
-- Non-urgent is opt-in. Defaulting work to "wait until tonight" would make a
-- forgotten flag the difference between a company that answers and one that
-- does not, so the default is to run now and deferral is asked for.
--
-- Tier 0 is not taken on trust. A task is eligible only if its role holds no
-- capability above tier 0 -- checked against the registry, not against a claim
-- in the request. Work that can write should not be sitting in a queue until
-- 02:00, because by then the world it was going to write to has moved.
--
-- The window is per company and reuses the same shape as capability and owner
-- windows: a named IANA zone, half-open hours, and a start after the end means
-- it wraps past midnight. Cheap hours are usually overnight, so wrapping is
-- the normal case here rather than the exception.
-- ---------------------------------------------------------------------------
CREATE TABLE batch_windows (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  timezone      text NOT NULL,
  start_hour    smallint NOT NULL,
  end_hour      smallint NOT NULL,
  days_of_week  smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT batch_hours_in_range
    CHECK (start_hour BETWEEN 0 AND 23 AND end_hour BETWEEN 0 AND 24),
  CONSTRAINT batch_hours_differ CHECK (start_hour <> end_hour)
);
SELECT app.enable_tenant_rls('batch_windows');

-- On the task rather than only on the schedule that produced it: a task
-- deferred by a schedule and one deferred by the owner are the same thing to
-- the engine, and the engine is what reads this.
ALTER TABLE tasks ADD COLUMN batchable boolean NOT NULL DEFAULT false;

-- And on the schedule, because a recurring job is where most non-urgent work
-- comes from. A nightly digest has no reason to run at the most expensive
-- minute of the day.
ALTER TABLE schedules ADD COLUMN batchable boolean NOT NULL DEFAULT false;

-- The sweep that wakes parked tasks reads status and wait_until together.
CREATE INDEX tasks_waiting_window_ready
  ON tasks (company_id, wait_until) WHERE status = 'waiting_window';
