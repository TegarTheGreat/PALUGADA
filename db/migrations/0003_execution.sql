-- Durable execution: budgets, tasks, step journal, agent runs (PRD F5).


-- ---------------------------------------------------------------------------
-- Budgets
--
-- F5.4 requires a parent and its sub-tasks to share ONE counter rather than
-- receiving fresh allowances. That is modelled by giving the parent a budget
-- account and having every descendant point at the same account row, so a
-- sub-task cannot mint budget by existing.
--
-- tokens_reserved is admission control: creating a sub-task reserves its
-- minimum before it runs, which is what lets the fourth sub-task be refused
-- while three are still in flight. tokens_spent is the hard ceiling.
-- ---------------------------------------------------------------------------
CREATE TABLE budget_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label             text NOT NULL,
  tokens_max        bigint NOT NULL,
  tokens_spent      bigint NOT NULL DEFAULT 0,
  tokens_reserved   bigint NOT NULL DEFAULT 0,
  money_max_cents   bigint NOT NULL DEFAULT 0,
  money_spent_cents bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT budget_tokens_max_positive CHECK (tokens_max > 0),
  CONSTRAINT budget_tokens_spent_within_max CHECK (tokens_spent <= tokens_max),
  CONSTRAINT budget_tokens_spent_non_negative CHECK (tokens_spent >= 0),
  CONSTRAINT budget_tokens_reserved_non_negative CHECK (tokens_reserved >= 0),
  CONSTRAINT budget_money_within_max CHECK (money_spent_cents <= money_max_cents),
  CONSTRAINT budget_money_non_negative CHECK (money_spent_cents >= 0)
);
SELECT app.enable_tenant_rls('budget_accounts');

-- ---------------------------------------------------------------------------
-- Tasks (state machine in PRD section 8.5)
-- ---------------------------------------------------------------------------
CREATE TABLE tasks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  division_id       uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  role_id           uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  parent_task_id    uuid REFERENCES tasks(id) ON DELETE CASCADE,
  budget_account_id uuid NOT NULL REFERENCES budget_accounts(id) ON DELETE RESTRICT,

  status            text NOT NULL DEFAULT 'pending',
  halt_reason       text,

  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  output            jsonb,

  -- F5.5: delegation depth, bounded so a runaway tree cannot grow forever.
  hop_depth         smallint NOT NULL DEFAULT 0,
  hop_max           smallint NOT NULL DEFAULT 3,

  -- F5.6: an absolute wall-clock deadline. Passing it halts the task rather
  -- than letting it continue.
  deadline_at       timestamptz,

  -- F5.2: stable across retries, so a replayed write is recognised downstream.
  idempotency_key   text NOT NULL,

  -- F6.6 support: identifies (role, input) pairs when walking the ancestor
  -- chain to detect a cycle.
  input_hash        text NOT NULL,

  created_by        text NOT NULL,
  attempt           smallint NOT NULL DEFAULT 0,
  attempt_max       smallint NOT NULL DEFAULT 3,

  tokens_reserved   bigint NOT NULL DEFAULT 0,

  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,

  CONSTRAINT tasks_status_known CHECK (status IN (
    'pending', 'running', 'completed', 'waiting_approval',
    'waiting_review', 'failed', 'halted', 'cancelled')),
  CONSTRAINT tasks_created_by_known CHECK (created_by IN (
    'scheduler', 'event', 'agent_run', 'owner')),
  CONSTRAINT tasks_hop_within_max CHECK (hop_depth <= hop_max),
  CONSTRAINT tasks_hop_non_negative CHECK (hop_depth >= 0),
  CONSTRAINT tasks_attempt_within_max CHECK (attempt <= attempt_max),
  CONSTRAINT tasks_halt_reason_only_when_halted
    CHECK (halt_reason IS NULL OR status IN ('halted', 'failed', 'cancelled')),
  CONSTRAINT tasks_reserved_non_negative CHECK (tokens_reserved >= 0),
  UNIQUE (company_id, idempotency_key)
);
SELECT app.enable_tenant_rls('tasks');

CREATE INDEX tasks_runnable_idx ON tasks (company_id, status, created_at)
  WHERE status IN ('pending', 'running');
CREATE INDEX tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX tasks_budget_idx ON tasks (budget_account_id);

-- ---------------------------------------------------------------------------
-- Step journal (F5.1)
--
-- Durability lives here, not in the agent framework (PRD principle 5). Each
-- LLM call and each tool call is journalled; a restart replays committed
-- steps from this table instead of re-invoking the model, which is what makes
-- a half-finished task resumable rather than restartable.
-- ---------------------------------------------------------------------------
CREATE TABLE task_steps (
  task_id         uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_index      integer NOT NULL,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            text NOT NULL,
  kind            text NOT NULL,
  status          text NOT NULL DEFAULT 'started',
  input_hash      text NOT NULL,
  -- F5.2: task_id + step_index + input_hash, recorded so an external side
  -- effect can be recognised as already applied after a crash.
  idempotency_key text NOT NULL,
  output          jsonb,
  error           text,
  attempt         smallint NOT NULL DEFAULT 1,
  started_at      timestamptz NOT NULL DEFAULT now(),
  committed_at    timestamptz,
  PRIMARY KEY (task_id, step_index),
  CONSTRAINT steps_status_known CHECK (status IN ('started', 'committed', 'failed')),
  CONSTRAINT steps_kind_known CHECK (kind IN ('llm', 'tool', 'internal')),
  CONSTRAINT steps_committed_has_output
    CHECK (status <> 'committed' OR (output IS NOT NULL AND committed_at IS NOT NULL))
);
SELECT app.enable_tenant_rls('task_steps');

-- ---------------------------------------------------------------------------
-- Agent runs: one execution of a role for one task.
-- ---------------------------------------------------------------------------
CREATE TABLE agent_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id       uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role_id       uuid NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  attempt       smallint NOT NULL,
  status        text NOT NULL DEFAULT 'running',
  tokens_used   bigint NOT NULL DEFAULT 0,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  CONSTRAINT agent_runs_status_known
    CHECK (status IN ('running', 'succeeded', 'failed', 'aborted')),
  UNIQUE (task_id, attempt)
);
SELECT app.enable_tenant_rls('agent_runs');

-- ---------------------------------------------------------------------------
-- Budget operations
--
-- Both are single atomic statements whose guard lives in the WHERE clause, so
-- concurrent sub-tasks (permitted by F5.7) cannot interleave a read and a
-- write to overspend. A refusal is reported as "zero rows updated" rather
-- than an exception, leaving the caller to decide between halting and
-- queueing.
-- ---------------------------------------------------------------------------

-- Reserves an allowance for a task that is about to be admitted.
-- Returns true when the reservation was granted.
CREATE OR REPLACE FUNCTION app.budget_reserve(
  account_id uuid, tokens bigint
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE updated integer;
BEGIN
  UPDATE budget_accounts
     SET tokens_reserved = tokens_reserved + tokens
   WHERE id = account_id
     AND tokens_spent + tokens_reserved + tokens <= tokens_max;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END $$;

-- Releases an unused reservation when a task reaches a terminal state.
CREATE OR REPLACE FUNCTION app.budget_release(
  account_id uuid, tokens bigint
) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE budget_accounts
     SET tokens_reserved = GREATEST(0, tokens_reserved - tokens)
   WHERE id = account_id;
END $$;

-- Charges actual consumption. Draws down the caller's own reservation first
-- so that spending does not double-count against the admission allowance.
-- Returns false when the charge would breach the ceiling; the caller is
-- expected to halt the task (PRD section 6.3).
CREATE OR REPLACE FUNCTION app.budget_spend(
  account_id uuid, tokens bigint, money_cents bigint, from_reservation bigint
) RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE updated integer;
BEGIN
  UPDATE budget_accounts
     SET tokens_spent      = tokens_spent + tokens,
         money_spent_cents = money_spent_cents + money_cents,
         tokens_reserved   = GREATEST(0, tokens_reserved - LEAST(from_reservation, tokens))
   WHERE id = account_id
     AND tokens_spent + tokens <= tokens_max
     AND money_spent_cents + money_cents <= money_max_cents;
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated = 1;
END $$;
