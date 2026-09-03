-- Phase 4 (PRD v2): the monthly ceiling and the spending circuit breaker
-- (F1.7, F1.8, F1.9).

-- ---------------------------------------------------------------------------
-- F1.9 asks for two separate ceilings that must both hold: a periodic one and
-- a per-task one. `budget_accounts` is the per-task ceiling -- a lifetime
-- counter shared down a delegation tree (F5.4) -- and this table is the other
-- one: how much a company may spend in a calendar month, regardless of how
-- many trees of work it starts.
--
-- They are genuinely different instruments and neither substitutes for the
-- other. A single runaway task is caught by its account; a hundred
-- well-behaved tasks that together cost more than the company can afford are
-- caught only here.
--
-- Spend itself is not stored. It is derived from the model traces and the
-- tool.cost events that already record every cent, because a second counter
-- maintained alongside them is a second thing that can be wrong, and the one
-- that is wrong is always the one being enforced.
-- ---------------------------------------------------------------------------
CREATE TABLE spend_limits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid REFERENCES companies(id) ON DELETE CASCADE,
  -- The owner's answer to PRD section 14.3: USD 200 per company per month.
  money_max_cents  bigint NOT NULL DEFAULT 20000,
  -- F1.7: set when the period ceiling is reached. Distinct from
  -- companies.frozen_at on purpose -- a company stopped because it ran out of
  -- money and one an owner stopped by hand need different answers to "why is
  -- this stopped", and one column could not give both.
  paused_at        timestamptz,
  pause_reason     text,
  -- F1.7: "owner bisa override". An override with no end would quietly become
  -- the new ceiling, so it carries one.
  override_until   timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_limits_one_per_scope UNIQUE (company_id),
  CONSTRAINT spend_limits_ceiling_non_negative CHECK (money_max_cents >= 0)
);
-- UNIQUE does not constrain the platform row: NULLs are distinct in a unique
-- index, so "at most one default" needs this to actually hold.
CREATE UNIQUE INDEX spend_limits_single_platform_row
  ON spend_limits ((company_id IS NULL)) WHERE company_id IS NULL;

INSERT INTO spend_limits (company_id) VALUES (NULL);
SELECT app.enable_shared_scope_rls('spend_limits');

-- F1.8: the breaker compares an hour against a seven-day baseline. Both
-- numbers are configuration rather than constants, and they live beside the
-- other thresholds so there is one place to look.
--
-- The floor exists for the same reason the alert module demands a minimum
-- sample before reporting a failure rate: three times almost nothing is still
-- almost nothing, and a breaker that trips on it teaches the owner to ignore
-- breakers.
ALTER TABLE alert_thresholds
  ADD COLUMN spend_rate_multiple    real NOT NULL DEFAULT 3,
  ADD COLUMN spend_rate_floor_cents integer NOT NULL DEFAULT 100,
  ADD CONSTRAINT alert_spend_rate_multiple_above_one CHECK (spend_rate_multiple > 1),
  ADD CONSTRAINT alert_spend_rate_floor_non_negative CHECK (spend_rate_floor_cents >= 0);
