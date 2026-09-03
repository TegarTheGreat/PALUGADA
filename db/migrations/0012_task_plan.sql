-- Phase 4 (PRD v2): the plan a task must record before it acts (F8.11, F8.13).

-- ---------------------------------------------------------------------------
-- v2 section 2.3 lists an observed failure: an outreach agent contacted 23
-- leads when it should have contacted 3. Nothing in the system knew what "3"
-- was, so nothing could notice.
--
-- A plan is that missing number, written down before the first tier 2 action
-- rather than inferred afterwards. It is deliberately not free text: each step
-- names the capability it intends to use, what it expects to be true
-- afterwards, and -- where the call is a batch -- how many items it covers.
-- Free text would be readable and uncheckable, which is the state that
-- produced the 23.
--
-- Nullable, because most tasks never reach tier 2 and demanding a plan from
-- them would make the plan a formality. The requirement is that a plan exists
-- by the time it matters, not that every task writes one.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks ADD COLUMN plan jsonb;

ALTER TABLE tasks ADD CONSTRAINT tasks_plan_has_steps
  CHECK (plan IS NULL OR jsonb_typeof(plan -> 'steps') = 'array');

COMMENT ON COLUMN tasks.plan IS
  'F8.11: { steps: [{capability, intent, expectedEffect, batchSize?}], recordedAt }. '
  'Required before the first tier >= 2 action; the batch guard (F8.13) compares '
  'a call''s batch size against the step that named the capability.';
