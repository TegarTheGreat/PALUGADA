-- ---------------------------------------------------------------------------
-- Indexes for what the worker asks every tick, and a ledger for handoffs
--
-- The worker ticks every few seconds for every company, and several of the
-- questions it asks had no index to answer them with:
--
--   - Spend in a window -- the monthly pause, the daily alert, the circuit
--     breaker -- summed `llm_traces` by time, whose only index was per task.
--     Every tick read every trace the company had ever produced.
--   - The orphan sweep looked for running agent runs, and the daily metrics
--     counted orphaned ones, with no index on status at all.
--   - The daily metrics counted tasks by `finished_at`, the per-role spend
--     joined tasks on `role_id`, and the stranded sweep looked for waiting
--     tasks; none of the three was indexed.
--   - The event purge sets `source_event_id` to NULL in memories and decision
--     records, and each purged event scanned both tables to find its rows.
--
-- `memories_scope_lookup_idx` (0005) duplicates `memories_live_idx` (0004)
-- column for column and predicate for predicate, and is dropped: every write
-- to memories paid for it twice.
--
-- The indexes are built plainly rather than CONCURRENTLY because a migration
-- runs in one transaction; at the scale section 9 states the tables are small
-- enough that the brief write lock is the cheaper trade.
-- ---------------------------------------------------------------------------

CREATE INDEX llm_traces_company_time_idx
  ON llm_traces (company_id, occurred_at) INCLUDE (cost_cents, task_id);

CREATE INDEX agent_runs_running_idx
  ON agent_runs (company_id, coalesce(last_heartbeat_at, started_at))
  WHERE status = 'running';

CREATE INDEX agent_runs_orphaned_idx
  ON agent_runs (company_id, finished_at)
  WHERE status = 'orphaned';

CREATE INDEX tasks_finished_idx
  ON tasks (company_id, finished_at)
  WHERE finished_at IS NOT NULL;

CREATE INDEX tasks_role_idx ON tasks (role_id);

CREATE INDEX tasks_waiting_idx
  ON tasks (company_id, status)
  WHERE status IN ('waiting_approval', 'waiting_review', 'waiting_window');

CREATE INDEX memories_source_event_idx
  ON memories (source_event_id) WHERE source_event_id IS NOT NULL;

CREATE INDEX decision_records_source_event_idx
  ON decision_records (source_event_id) WHERE source_event_id IS NOT NULL;

DROP INDEX memories_scope_lookup_idx;

-- ---------------------------------------------------------------------------
-- What each completed task's handoffs came to (F6.1)
--
-- `processHandoffs` re-read every completed task of every source role on
-- every tick, output included, and asked two more questions per task per
-- rule -- work that grew with the company's whole history. A handoff refused
-- for good, by the hop limit or the fan-out bound, wrote `handoff.refused`
-- again on every tick: the same seventeen thousand events a day that 0038
-- removed for schedules.
--
-- One row per completed task and successor role, written when the handoff is
-- decided. A task with a row is not looked at again, except a refusal that
-- may lift -- a budget that the owner raises -- which is retried and says so
-- only when its reason changes.
-- ---------------------------------------------------------------------------

CREATE TABLE task_handoffs (
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_task_id  uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_role_slug  text NOT NULL,
  outcome       text NOT NULL,
  to_task_id    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  -- Why a handoff was refused, in the platform's own error codes. A
  -- refusal whose code can lift is retried; the rest are final.
  reason_code   text,
  reason        text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_task_id, to_role_slug),
  CONSTRAINT task_handoffs_outcome_known
    CHECK (outcome IN ('created', 'declined', 'refused')),
  CONSTRAINT task_handoffs_created_names_successor
    CHECK ((outcome = 'created') = (to_task_id IS NOT NULL)),
  CONSTRAINT task_handoffs_refused_says_why
    CHECK (outcome <> 'refused' OR reason_code IS NOT NULL)
);

SELECT app.enable_tenant_rls('task_handoffs');
