-- Phase 4: automatic role freeze on repeated denials (F3.7).

-- ---------------------------------------------------------------------------
-- F3.7 asks for denials to be counted per role and for a role past the
-- threshold to be frozen automatically.
--
-- Freezing the role rather than the task or the company is the whole point. A
-- task that keeps being denied is one task going wrong; a role that keeps
-- being denied is a configuration or a prompt that is wrong, and it will keep
-- being wrong for every task that runs it. Stopping the role stops the
-- repetition without stopping the company, which is the smallest cut that
-- actually holds.
--
-- The reason is stored beside the timestamp because an owner reading the inbox
-- tomorrow needs to know which capability the role kept reaching for, and
-- reconstructing that from the event log is work nobody does at the moment
-- they need the answer.
-- ---------------------------------------------------------------------------
ALTER TABLE roles
  ADD COLUMN frozen_at     timestamptz,
  ADD COLUMN frozen_reason text;

-- The per-role limit sits below the company-wide alert threshold on purpose.
-- One role misbehaving should be stopped before the company's total is high
-- enough to be worth waking the owner for; if the two were equal, the alert
-- and the freeze would always arrive together and the freeze would never be
-- the early signal it is meant to be.
ALTER TABLE alert_thresholds
  ADD COLUMN role_freeze_denials_per_day integer NOT NULL DEFAULT 10,
  ADD CONSTRAINT alert_role_freeze_positive CHECK (role_freeze_denials_per_day >= 1);

-- Denials are counted by role and by day, which is exactly this index.
CREATE INDEX events_denials_by_role
  ON events ((payload->>'roleId'), occurred_at)
  WHERE type = 'policy.denied';
