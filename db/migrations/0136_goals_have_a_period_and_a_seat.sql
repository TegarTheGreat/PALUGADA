-- ---------------------------------------------------------------------------
-- A goal has a period, one owning seat, a commitment and a definition of done
-- (F18.1), and may name the acquisition channel it tests (F18.11).
--
-- The ladder said what the company wanted and nothing about by when, who
-- answers for it, or how anyone would know it was done. Every operating
-- method a small company uses has those four: this year's goals, and the
-- quarterly priorities under them, each with one owner and a finish line.
-- They go on `goals` rather than on a new table, because a quarterly
-- priority is a key result with a quarter's period and a year's goal is an
-- objective with a year's; the kinds and their ladder are unchanged.
--
--   starts_on, due_on  the period: both or neither, due after it starts. The
--                      due date is the last day of the period.
--   owner_role_id      the one seat that answers for it (the single
--                      accountable owner of RACI and DACI), a role of the
--                      same company.
--   commitment         committed (it is done, or it is a miss), aspirational
--                      (graded 0.0-1.0; 0.6-0.7 is a good result) or learning
--                      (a test whose prediction is set before the work starts).
--   done_when          what is true once it is done, in a sentence.
--   channel            the traction channel a goal tests, one of the nineteen
--                      in src/domain/channels.ts.
--
-- A period of 92 days or less is a quarter's (a calendar quarter is 90 to 92
-- days, last day included); there is no fiscal year in the schema, so a
-- quarter is read from the period's length rather than from the calendar.
-- A key result with such a period is a quarterly priority, and has a seat
-- and a way to tell it is done. The soft limits -- how many goals a year or a
-- quarter holds -- are warnings the platform gives, never refusals, and live
-- in src/domain/goals.ts.
-- ---------------------------------------------------------------------------

ALTER TABLE goals
  ADD COLUMN starts_on date,
  ADD COLUMN due_on date,
  ADD COLUMN owner_role_id uuid,
  ADD COLUMN commitment text,
  ADD COLUMN done_when text,
  ADD COLUMN channel text,
  ADD CONSTRAINT goals_commitment_known
    CHECK (commitment IN ('committed', 'aspirational', 'learning')),
  -- A sentence the owner reads on a card and every run under it carries.
  ADD CONSTRAINT goals_done_when_short
    CHECK (length(btrim(done_when)) BETWEEN 1 AND 500),
  -- The 2015 edition's nineteen, in its order (src/domain/channels.ts).
  ADD CONSTRAINT goals_channel_known
    CHECK (channel IN (
      'targeting_blogs', 'publicity', 'unconventional_pr', 'search_engine_marketing',
      'social_and_display_ads', 'offline_ads', 'search_engine_optimization', 'content_marketing',
      'email_marketing', 'engineering_as_marketing', 'viral_marketing', 'business_development',
      'sales', 'affiliate_programs', 'existing_platforms', 'trade_shows', 'offline_events',
      'speaking_engagements', 'community_building'));

-- The seat is a role of the same company (0048's rule for every reference
-- between tenant tables). No delete action: roles are not deleted, only
-- frozen, and a company's delete takes both rows in one statement. Adding
-- the key reads the tables as their owner, which their forced row security
-- refuses without a tenant: lifted for this transaction and put back (as
-- 0048 and 0134).
ALTER TABLE goals NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE goals
  ADD CONSTRAINT goals_owner_role_fkey
    FOREIGN KEY (company_id, owner_role_id) REFERENCES roles (company_id, id);
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

CREATE INDEX goals_owner_role ON goals (company_id, owner_role_id) WHERE owner_role_id IS NOT NULL;

-- The ladder's rules, and the period's and the seat's with them. Written
-- whole again rather than as a second trigger, so one function says what a
-- goal may be and the order its refusals come in is the order a person would
-- fix them.
CREATE OR REPLACE FUNCTION app.goals_respect_the_ladder() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_kind text; parent_company uuid;
BEGIN
  IF NEW.kind = 'mission' THEN
    IF NEW.parent_goal_id IS NOT NULL THEN
      RAISE EXCEPTION 'a mission is the top of the ladder and has no parent'
        USING ERRCODE = '23514';
    END IF;
    -- A mission is a direction, not a piece of work: nothing about it ends.
    IF NEW.starts_on IS NOT NULL OR NEW.due_on IS NOT NULL OR NEW.owner_role_id IS NOT NULL
       OR NEW.commitment IS NOT NULL OR NEW.done_when IS NOT NULL OR NEW.channel IS NOT NULL THEN
      RAISE EXCEPTION 'a mission is the company''s direction and has no period, seat, commitment, definition of done or channel; give those to an objective or a key result under it'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.parent_goal_id IS NULL THEN
    -- Phrased to avoid an article, because "a objective" is what the obvious
    -- wording produces and an error message is read by a person.
    RAISE EXCEPTION 'a goal of kind % must hang from the level above it', NEW.kind
      USING ERRCODE = '23514';
  END IF;

  SELECT kind, company_id INTO parent_kind, parent_company
    FROM goals WHERE id = NEW.parent_goal_id;

  -- Crossing companies here would be a tenancy hole that row-level security
  -- cannot see, because both rows are visible to whoever holds both scopes.
  IF parent_company <> NEW.company_id THEN
    RAISE EXCEPTION 'a goal cannot hang from another company''s goal'
      USING ERRCODE = '42501';
  END IF;

  IF (NEW.kind = 'objective' AND parent_kind <> 'mission')
     OR (NEW.kind = 'key_result' AND parent_kind <> 'objective') THEN
    RAISE EXCEPTION 'a % cannot hang from a %', NEW.kind, parent_kind
      USING ERRCODE = '23514';
  END IF;

  IF (NEW.starts_on IS NULL) <> (NEW.due_on IS NULL) THEN
    RAISE EXCEPTION 'a period has a start and a due date, or neither: give the goal both, or clear both'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.due_on IS NOT NULL AND NEW.due_on <= NEW.starts_on THEN
    RAISE EXCEPTION 'a goal is due after it starts: % is not after %', NEW.due_on, NEW.starts_on
      USING ERRCODE = '23514';
  END IF;

  -- Committed, aspirational and learning say how the end of a period is
  -- read, and a goal without one has no end to read.
  IF NEW.commitment IS NOT NULL AND NEW.starts_on IS NULL THEN
    RAISE EXCEPTION 'a % goal has a period: give it a start and a due date', NEW.commitment
      USING ERRCODE = '23514';
  END IF;

  -- A quarterly priority is one seat's to deliver: a priority two roles
  -- share is one neither answers for.
  IF NEW.kind = 'key_result' AND NEW.starts_on IS NOT NULL
     AND NEW.due_on - NEW.starts_on <= 92 AND NEW.owner_role_id IS NULL THEN
    RAISE EXCEPTION 'a key result of a quarter or less is a quarterly priority, and has one owning seat: name the role that answers for it'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

-- And it says how anyone will know it is done: in words, or by a number the
-- goal is measured by. Checked at commit, because a measure hangs from its
-- goal and so can only be written after it: a goal and its measure written
-- in one transaction (an archive's import, a plan approved at once) are
-- checked together. The row is read again, as it stands at commit.
--
-- Checked from both sides. A goal written with no words is checked against
-- its live measures; a measure retired (or removed) is checked against its
-- goal, so the words cannot be cleared on the strength of a measure that is
-- then retired. Without the second side a company reached a state that the
-- first refuses on replay, and could not be restored from its own archive.
--
-- Only an active goal is held to it: the rule is about work still to be
-- done, and a met or abandoned priority is history that can be reworded,
-- exported and restored as it stands. Reopening one is checked again, which
-- is why the trigger watches status too.
CREATE FUNCTION app.goals_say_when_done() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE goal record; target uuid; measure text;
BEGIN
  IF TG_TABLE_NAME = 'goals' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.goal_id; measure := OLD.slug;
  ELSE
    target := NEW.goal_id; measure := NEW.slug;
  END IF;
  SELECT id, company_id, slug, kind, status, starts_on, due_on, done_when INTO goal FROM goals WHERE id = target;
  IF goal.id IS NULL OR goal.status <> 'active' THEN
    RETURN NULL;
  END IF;
  IF goal.kind = 'key_result' AND goal.starts_on IS NOT NULL
     AND goal.due_on - goal.starts_on <= 92 AND goal.done_when IS NULL
     AND NOT EXISTS (SELECT 1 FROM goal_metrics m
                      WHERE m.company_id = goal.company_id AND m.goal_id = goal.id AND m.retired_at IS NULL) THEN
    IF measure IS NOT NULL THEN
      RAISE EXCEPTION 'the measure "%" is the last one the quarterly priority "%" is measured by, and the priority does not say in words when it is done: write what is true once it is done, or define another measure, before retiring this one', measure, goal.slug
        USING ERRCODE = '23514', CONSTRAINT = 'goals_say_when_done';
    END IF;
    RAISE EXCEPTION 'the quarterly priority "%" says when it is done: write what is true once it is done, or measure it by a number', goal.slug
      USING ERRCODE = '23514', CONSTRAINT = 'goals_say_when_done';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER goals_say_when_done
  AFTER INSERT OR UPDATE OF kind, status, starts_on, due_on, done_when ON goals
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.goals_say_when_done();

CREATE CONSTRAINT TRIGGER goal_metrics_leave_a_finish_line
  AFTER UPDATE OF retired_at OR DELETE ON goal_metrics
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.goals_say_when_done();

COMMENT ON COLUMN goals.due_on IS
  'F18.1: the last day of the goal''s period. 92 days or fewer after starts_on is a quarter: a key result with one is a quarterly priority.';
COMMENT ON COLUMN goals.owner_role_id IS
  'F18.1: the one seat that answers for the goal.';
COMMENT ON COLUMN goals.commitment IS
  'F18.1: committed, aspirational or learning: how the end of the period is read (F18.8).';
COMMENT ON COLUMN goals.channel IS
  'F18.11: the traction channel the goal tests (src/domain/channels.ts).';
