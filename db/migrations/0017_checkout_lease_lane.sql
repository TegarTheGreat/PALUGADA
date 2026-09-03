-- Phase 4 (PRD v2): atomic checkout, leases, lanes and orphan recovery
-- (F5.11–F5.14), and the `checked_out` status v2 adds to section 8.5.

-- ---------------------------------------------------------------------------
-- v2 redraws the state machine as pending → checked_out → running. The new
-- status is not bookkeeping: it is the difference between "nobody has this"
-- and "a worker has claimed it and has not started yet". Without it a crash
-- between claiming and starting is indistinguishable from a task nobody ever
-- picked up, and the recovery for those two is different.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks DROP CONSTRAINT tasks_status_known;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_known CHECK (status IN (
  'pending', 'checked_out', 'running', 'completed', 'waiting_approval',
  'waiting_review', 'waiting_window', 'failed', 'halted', 'cancelled'));

-- F5.12: a lease is a claim with an expiry. The holder is a worker identity
-- rather than a foreign key, because the worker may be a process on another
-- machine that this database has never heard of and should not have to model.
ALTER TABLE tasks
  ADD COLUMN lease_holder     text,
  ADD COLUMN lease_expires_at timestamptz,
  -- F5.13: one running task per lane. NULL means the task touches nothing
  -- shared and needs no serialisation, which is the common case; a lane key is
  -- the exception you opt into for a repo, a domain or an account.
  ADD COLUMN lane_key         text,
  ADD CONSTRAINT tasks_lease_is_whole
    CHECK ((lease_holder IS NULL) = (lease_expires_at IS NULL));

-- The claim query looks for a pending task whose lane is free. Both halves of
-- that are this index.
CREATE INDEX tasks_claimable
  ON tasks (company_id, created_at) WHERE status = 'pending';
CREATE INDEX tasks_lane_occupied
  ON tasks (company_id, lane_key) WHERE status IN ('checked_out', 'running');
-- Reclaiming an expired lease scans exactly this.
CREATE INDEX tasks_leased
  ON tasks (lease_expires_at) WHERE lease_expires_at IS NOT NULL;

-- F5.14: a run that stops sending heartbeats is an orphan. Recorded on the
-- run rather than the task because the task may be perfectly healthy and the
-- worker holding it may not be, and telling those apart is the whole point.
ALTER TABLE agent_runs ADD COLUMN last_heartbeat_at timestamptz;

COMMENT ON COLUMN tasks.lane_key IS
  'F5.13: serialisation key, conventionally "<resource-kind>:<identifier>". At '
  'most one task per lane is checked out or running at a time.';

-- F5.14: an orphaned run is neither a success nor a failure. It is a run
-- nobody heard from again, and calling it "failed" would put a bad deploy's
-- restart storm into the failure rate the alerts watch (F11.4).
ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_status_known;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_known
  CHECK (status IN ('running', 'succeeded', 'failed', 'aborted', 'orphaned'));
