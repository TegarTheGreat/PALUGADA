-- A weekly scorecard line is not a quarterly priority's finish line
-- (F18.1, F18.2, F18.8; docs/STATUS.md 2.190, 2.191, 2.196).
--
-- 0136 holds a quarterly priority to saying when it is done: in words, or by
-- a live measure. Any live measure counted, a weekly scorecard line too. But
-- everything that reads a finish line leaves a weekly line out -- the grade
-- at the period's end, the meeting's pace and the off-pace sweep, and the
-- check on a proposal to mark the goal met -- because a weekly line is
-- reviewed against a weekly goal and is not a target (2.191). So a priority
-- could pass 0136 on a number none of them read, and be graded "declared" 0
-- and filed as missed with a reading on track.
--
-- The rule now counts only a live measure aimed at a target (review_every
-- IS NULL), and the measure's side is checked when it is put on the
-- scorecard as when it is retired, so the last target measure of a priority
-- with no words cannot become a weekly line either. Only the function and
-- the measure-side trigger change; 0136's text stays as it ran.

CREATE OR REPLACE FUNCTION app.goals_say_when_done() RETURNS trigger
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
                      WHERE m.company_id = goal.company_id AND m.goal_id = goal.id
                        AND m.retired_at IS NULL AND m.review_every IS NULL) THEN
    IF measure IS NOT NULL THEN
      RAISE EXCEPTION 'the measure "%" is the last one the quarterly priority "%" is measured by, and the priority does not say in words when it is done: write what is true once it is done, or define another measure, before retiring this one or putting it on the weekly scorecard', measure, goal.slug
        USING ERRCODE = '23514', CONSTRAINT = 'goals_say_when_done';
    END IF;
    RAISE EXCEPTION 'the quarterly priority "%" says when it is done: write what is true once it is done, or measure it by a number aimed at a target (a weekly scorecard line is not one)', goal.slug
      USING ERRCODE = '23514', CONSTRAINT = 'goals_say_when_done';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER goal_metrics_leave_a_finish_line ON goal_metrics;
CREATE CONSTRAINT TRIGGER goal_metrics_leave_a_finish_line
  AFTER UPDATE OF retired_at, review_every OR DELETE ON goal_metrics
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.goals_say_when_done();
