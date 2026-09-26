-- ---------------------------------------------------------------------------
-- Goals that are measured, not only worked on
--
-- A key result's progress was the share of the tasks under it that had
-- finished. A company can finish every task it was given and earn nothing,
-- and an owner with ten companies can only decide what matters if each one's
-- goals can be read as numbers: revenue this month against a target, paying
-- customers, conversion. Spend already has a ledger; results had none.
--
-- goal_metrics: what a goal is measured by -- a unit, which way is better, a
-- baseline, a target and when -- and optionally the capability whose answer is
-- the number (`ledger.read`, `metrics.read`). The owner's to set, like the
-- goal itself (F3.10): the application role reads it and cannot change it, so
-- an agent cannot move its own target.
--
-- metric_observations: every value recorded, append-only. `verified` says
-- whether the number was read back from its source in the same task, which is
-- the difference between "the ledger says 4.2M" and "the agent says 4.2M";
-- what the owner and the agents are shown says which it is. The owner's own
-- entries are verified by being the owner's.
-- ---------------------------------------------------------------------------

CREATE TABLE goal_metrics (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id            uuid NOT NULL,
  slug               text NOT NULL,
  name               text NOT NULL,
  unit               text NOT NULL,
  direction          text NOT NULL DEFAULT 'up',
  baseline           numeric NOT NULL DEFAULT 0,
  target             numeric NOT NULL,
  due_on             date,
  source_capability  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT goal_metrics_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT goal_metrics_goal_fkey
    FOREIGN KEY (company_id, goal_id) REFERENCES goals (company_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_metrics_unit_known CHECK (unit IN ('currency', 'count', 'ratio', 'percent')),
  CONSTRAINT goal_metrics_direction_known CHECK (direction IN ('up', 'down')),
  -- A target equal to the baseline has no distance to cover, and a progress
  -- figure divides by that distance.
  CONSTRAINT goal_metrics_target_moves CHECK (target <> baseline),
  CONSTRAINT goal_metrics_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT goal_metrics_name_not_blank CHECK (length(btrim(name)) > 0)
);

CREATE TABLE metric_observations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  metric_id    uuid NOT NULL,
  value        numeric NOT NULL,
  -- The clock, not the transaction's start: two values recorded in one
  -- transaction would otherwise share a time, and "the latest" and the order
  -- of the line would be whichever the planner returned first.
  observed_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  task_id      uuid,
  verified     boolean NOT NULL DEFAULT false,
  recorded_by  text NOT NULL,
  note         text,
  CONSTRAINT metric_observations_metric_fkey
    FOREIGN KEY (company_id, metric_id) REFERENCES goal_metrics (company_id, id) ON DELETE CASCADE,
  CONSTRAINT metric_observations_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT metric_observations_recorded_by_known CHECK (recorded_by IN ('owner', 'agent')),
  -- An agent's number comes from a task; the owner's comes from the owner.
  CONSTRAINT metric_observations_agent_has_task CHECK (recorded_by = 'owner' OR task_id IS NOT NULL)
);

CREATE INDEX metric_observations_latest ON metric_observations (company_id, metric_id, observed_at DESC);

SELECT app.enable_tenant_rls('goal_metrics');
SELECT app.enable_tenant_rls('metric_observations');

-- The target is the owner's; the record of values only grows.
REVOKE INSERT, UPDATE, DELETE ON goal_metrics FROM palugada_app;
REVOKE UPDATE, DELETE ON metric_observations FROM palugada_app;
