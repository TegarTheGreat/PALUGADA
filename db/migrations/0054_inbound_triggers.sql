-- ---------------------------------------------------------------------------
-- Work that starts from outside: inbound triggers
--
-- Only the clock started work. A company that has to answer a customer -- a
-- payment that arrived, a form filled in, a support message relayed -- polled
-- for it on a schedule, which costs a run per poll and hours of latency.
-- Paperclip and Buzz both take a signed webhook; this is that.
--
-- triggers: a URL the owner hands to another service, the role it wakes, the
-- goal the work serves and what to do with each event. The URL's id is public
-- and says nothing; what lets a caller in is a token, stored only as its
-- SHA-256 and shown to the owner once. The owner's to set, like a schedule:
-- the application role reads a trigger and cannot create or change one.
--
-- trigger_deliveries: every event that came in and what became of it --
-- started a task, was a duplicate of one already started, or was over the
-- trigger's hourly limit. A delivery key (the sender's delivery id when it
-- sends one, the body's hash when it does not) makes a retried delivery the
-- same delivery.
--
-- tasks.created_by gains 'webhook', because the content of such a task came
-- from outside the company, and F8.9 holds what it may do to that: no tier 2
-- or higher action without the owner, however the run was persuaded.
-- ---------------------------------------------------------------------------

CREATE TABLE triggers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug           text NOT NULL,
  -- What goes in the URL. Random, and made again on a restore: a company
  -- moved to another instance is reached at a new address.
  public_id      text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '') UNIQUE,
  -- SHA-256 of the token, hex. Empty on a restored trigger until the owner
  -- rotates it, and no token hashes to empty.
  token_hash     text NOT NULL DEFAULT '',
  project_id     uuid NOT NULL,
  division_id    uuid NOT NULL,
  role_id        uuid NOT NULL,
  goal_id        uuid NOT NULL,
  instruction    text NOT NULL,
  max_per_hour   integer NOT NULL DEFAULT 30,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT triggers_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT triggers_project_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  CONSTRAINT triggers_division_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  CONSTRAINT triggers_role_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  CONSTRAINT triggers_goal_fkey
    FOREIGN KEY (company_id, goal_id) REFERENCES goals (company_id, id) ON DELETE CASCADE,
  CONSTRAINT triggers_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  CONSTRAINT triggers_instruction_not_blank CHECK (length(btrim(instruction)) > 0),
  CONSTRAINT triggers_rate_sane CHECK (max_per_hour BETWEEN 1 AND 3600)
);

CREATE TABLE trigger_deliveries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trigger_id    uuid NOT NULL,
  delivery_key  text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  outcome       text NOT NULL,
  task_id       uuid,
  UNIQUE (trigger_id, delivery_key),
  CONSTRAINT trigger_deliveries_trigger_fkey
    FOREIGN KEY (company_id, trigger_id) REFERENCES triggers (company_id, id) ON DELETE CASCADE,
  CONSTRAINT trigger_deliveries_task_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (task_id),
  CONSTRAINT trigger_deliveries_outcome_known CHECK (outcome IN ('started', 'rate_limited'))
);

CREATE INDEX trigger_deliveries_recent ON trigger_deliveries (trigger_id, received_at DESC);

SELECT app.enable_tenant_rls('triggers');
SELECT app.enable_tenant_rls('trigger_deliveries');

-- Deliveries are written by the receiving route on the control plane; the
-- application role only reads, as it does the triggers themselves.
REVOKE INSERT, UPDATE, DELETE ON triggers FROM palugada_app;
REVOKE INSERT, UPDATE, DELETE ON trigger_deliveries FROM palugada_app;

ALTER TABLE tasks
  DROP CONSTRAINT tasks_created_by_known,
  ADD CONSTRAINT tasks_created_by_known CHECK (created_by IN (
    'scheduler', 'event', 'agent_run', 'owner', 'webhook'));
