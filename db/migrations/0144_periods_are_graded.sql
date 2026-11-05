-- A period is graded when it ends, and quarters follow the company's fiscal
-- year (F18.8, F18.9; docs/STATUS.md 2.196).
--
-- A goal had a period (0136), a seat and a commitment, and nothing said at
-- its end how it went. The operating methods 2.189 adopts all close a period
-- the same way: each objective and key result is scored (Doerr and Grove's
-- OKRs, 0.0 to 1.0), each quarterly priority is done or not done (Wickman's
-- 80%), and a test's prediction is read against what happened (Deming's
-- study step). That is one row per goal and period.
--
--   goal_id            the goal graded, a goal of the same company.
--   period_starts_on,  the period as it stood when it ended: a goal whose
--   period_due_on      due date is moved later is graded again at its new
--                      end, which is why the date is part of the key.
--   commitment         as it stood then: committed (pass or fail, so 1 or 0),
--                      aspirational (0.0 to 1.0, 0.6 to 0.7 is a good result)
--                      or learning (a test; predicted against actual).
--   score              0 to 1.
--   basis              measured (its numbers, from their last verified
--                      reading by the period's end) or declared (no number:
--                      1 if the owner marked it met, else 0).
--   predicted, actual  a learning goal's prediction (its measure's target,
--                      set before the work) and the reading at the end.
--   note               the platform's word on how the score was reached
--                      (src/domain/grades.ts), never an agent's.
--
-- The platform writes a grade on the control plane once a period's due date
-- has passed in the company's time zone (src/engine/quarter.ts), and nobody
-- changes it after. The application role reads grades and writes none:
-- an agent that could write one could grade its own work, and both OKR
-- sources warn that a grade anyone is rewarded by is a grade that is gamed.
-- That is also why no budget, trust tier or freeze reads this table.

CREATE TABLE goal_grades (
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id           uuid NOT NULL,
  period_starts_on  date NOT NULL,
  period_due_on     date NOT NULL,
  commitment        text,
  score             numeric NOT NULL,
  basis             text NOT NULL,
  predicted         numeric,
  actual            numeric,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT goal_grades_once UNIQUE (company_id, goal_id, period_due_on),
  -- The goal is the same company's (0048). A grade of a goal that is gone
  -- is a grade of nothing.
  CONSTRAINT goal_grades_goal_fkey FOREIGN KEY (company_id, goal_id)
    REFERENCES goals (company_id, id) ON DELETE CASCADE,
  CONSTRAINT goal_grades_period_order CHECK (period_due_on > period_starts_on),
  CONSTRAINT goal_grades_commitment_known CHECK (commitment IN ('committed', 'aspirational', 'learning')),
  CONSTRAINT goal_grades_score_range CHECK (score >= 0 AND score <= 1),
  CONSTRAINT goal_grades_basis_known CHECK (basis IN ('measured', 'declared')),
  -- A committed goal is done or it is not.
  CONSTRAINT goal_grades_committed_pass_or_fail CHECK (commitment IS DISTINCT FROM 'committed' OR score IN (0, 1)),
  -- Only a test has a prediction to read against.
  CONSTRAINT goal_grades_prediction_is_a_test
    CHECK ((predicted IS NULL AND actual IS NULL) OR commitment = 'learning'),
  CONSTRAINT goal_grades_note_short CHECK (note IS NULL OR length(note) BETWEEN 1 AND 200)
);

SELECT app.enable_tenant_rls('goal_grades');
-- Read by every run's planning and by the owner; written only by the
-- platform, on the control plane.
REVOKE INSERT, UPDATE, DELETE ON goal_grades FROM palugada_app;

COMMENT ON TABLE goal_grades IS
  'F18.8: one grade per goal and period, written by the platform when the period ends; never read by budgets, trust tiers or freezing.';

-- Quarters are cut by the company's fiscal year. January unless the owner
-- says otherwise, so a calendar quarter is the default. The fiscal year is
-- named by the calendar year it starts in. The application role reads it and
-- cannot write it (0047 took UPDATE on companies away).
ALTER TABLE companies
  ADD COLUMN fiscal_year_start_month smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT companies_fiscal_year_start_month_known CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

COMMENT ON COLUMN companies.fiscal_year_start_month IS
  'F18.9: the month, 1 to 12, the company''s fiscal year starts in; quarters and quarterly planning follow it.';
