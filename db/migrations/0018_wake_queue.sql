-- Phase 4 (PRD v2): dormancy, the wake queue and coalescing (F9.7–F9.10).

-- ---------------------------------------------------------------------------
-- Principle 13: dormant is the normal state. An agent wakes because of a
-- schedule, an event or an assignment, and never because it is "waiting" --
-- waiting is what costs money for nothing.
--
-- G8 puts a number on it: zero tokens when there is no task. That is F9.10,
-- and it is the requirement this table exists to make checkable. A wake is a
-- reason to look, not a reason to run.
-- ---------------------------------------------------------------------------
ALTER TABLE roles
  -- F9.7: conservative by default. v2 section 2.3 traces surprise bills to an
  -- aggressive heartbeat meeting vague instructions, so the default errs
  -- towards a role that is asleep, and a company that needs faster turnaround
  -- says so per role rather than everywhere at once.
  ADD COLUMN heartbeat_minutes integer NOT NULL DEFAULT 240,
  -- When this role is next due to be looked at. NULL means "never scheduled",
  -- which is where every role starts.
  ADD COLUMN dormant_until     timestamptz,
  ADD CONSTRAINT roles_heartbeat_positive CHECK (heartbeat_minutes > 0);

CREATE TABLE wake_queue (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id        uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  -- Why this role is being woken. Kept because "the schedule fired" and "the
  -- owner asked for this" deserve different urgency and different answers when
  -- there turns out to be nothing to do.
  reason         text NOT NULL,
  detail         text NOT NULL DEFAULT '',
  -- F5.10's priority scale, reused: 0 is most urgent.
  priority       smallint NOT NULL DEFAULT 2,
  wake_at        timestamptz NOT NULL DEFAULT now(),
  -- F9.9: entries for the same role inside a short window become one run. The
  -- absorbed entry is kept rather than dropped, because "the queue asked four
  -- times and we looked once" is a fact about the system's rhythm that the
  -- owner may need and that a delete would erase.
  coalesced_into uuid REFERENCES wake_queue(id) ON DELETE SET NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wake_reason_known
    CHECK (reason IN ('heartbeat', 'schedule', 'event', 'assignment')),
  CONSTRAINT wake_priority_range CHECK (priority BETWEEN 0 AND 3),
  -- An entry cannot be both absorbed into another and consumed on its own.
  CONSTRAINT wake_absorbed_is_not_consumed
    CHECK (coalesced_into IS NULL OR consumed_at IS NULL)
);
SELECT app.enable_tenant_rls('wake_queue');

-- The two queries this table exists for: what is due, and is there an open
-- entry for this role to coalesce into.
CREATE INDEX wake_queue_due
  ON wake_queue (company_id, wake_at)
  WHERE consumed_at IS NULL AND coalesced_into IS NULL;
CREATE INDEX wake_queue_open_for_role
  ON wake_queue (role_id, wake_at)
  WHERE consumed_at IS NULL AND coalesced_into IS NULL;
