-- The weekly scorecard is measures reviewed every week (F18.2).
--
-- A measure had a target and a date, and nothing that said how often anyone
-- looks at it, who answers for it, or what it must not be bought with. A
-- company run by the methods it now adopts (STATUS 2.189) reads a handful of
-- numbers every week, each owned by one seat, and pairs a number that can be
-- pushed with the one that would suffer if it were (Grove's paired
-- indicators). So the scorecard is not a table of its own: it is the measures
-- the owner marks as reviewed weekly, which keeps the rule that every number
-- hangs from a goal and keeps one history of readings.
--
-- review_every: 'week' for a line on the weekly scorecard, whose target is
-- then the weekly goal; NULL for a measure aimed at a target by a date, as
-- before. A check rather than an enum so a later cadence is one more word.
--
-- owner_role_id: the seat that answers for the number. Optional, because the
-- owner may put a number on the scorecard before deciding who holds it, and
-- the scorecard says when nobody does. Gone with the role, not the measure.
--
-- paired_metric_id: the measure this one is watched with. A pair is mutual
-- and has two members: each names the other, which a deferred trigger checks
-- when the transaction ends, so the owner's change (and a restore, which
-- inserts the two in either order) writes both before it is judged.
--
-- The application role still cannot write any of it (0053): an agent that
-- could put itself on the scorecard, own a line, or unpair the number that
-- watches its own could choose what it is judged by.
--
-- Adding a foreign key reads every row of both tables to check it, which
-- forced row security refuses the tables' owner without a tenant: lifted for
-- this transaction and put back before it ends (as 0048 and 0135).
ALTER TABLE goal_metrics NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;

ALTER TABLE goal_metrics
  ADD COLUMN review_every text,
  ADD COLUMN owner_role_id uuid,
  ADD COLUMN paired_metric_id uuid,
  ADD CONSTRAINT goal_metrics_review_every_known CHECK (review_every IN ('week')),
  ADD CONSTRAINT goal_metrics_owner_role_fkey
    FOREIGN KEY (company_id, owner_role_id) REFERENCES roles (company_id, id) ON DELETE SET NULL (owner_role_id),
  ADD CONSTRAINT goal_metrics_pair_fkey
    FOREIGN KEY (company_id, paired_metric_id) REFERENCES goal_metrics (company_id, id)
    ON DELETE SET NULL (paired_metric_id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT goal_metrics_not_paired_with_itself CHECK (paired_metric_id <> id);

ALTER TABLE roles FORCE ROW LEVEL SECURITY;
ALTER TABLE goal_metrics FORCE ROW LEVEL SECURITY;

-- One partner each: two measures naming the same third would be a pair of
-- three, and "shown together" would not say with which.
CREATE UNIQUE INDEX goal_metrics_one_partner ON goal_metrics (company_id, paired_metric_id)
  WHERE paired_metric_id IS NOT NULL;

CREATE FUNCTION app.goal_metrics_pair_is_mutual() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  partner uuid;
BEGIN
  -- Read again: by the end of the transaction the row may have changed since
  -- the statement that queued this check.
  SELECT paired_metric_id INTO partner FROM goal_metrics WHERE id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF partner IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM goal_metrics WHERE id = partner AND paired_metric_id = NEW.id) THEN
    RAISE EXCEPTION 'a pair is mutual: measure % names % as its pair, which does not name it back', NEW.id, partner
      USING ERRCODE = '23514', CONSTRAINT = 'goal_metrics_pair_mutual';
  END IF;
  IF EXISTS (SELECT 1 FROM goal_metrics
              WHERE paired_metric_id = NEW.id AND id IS DISTINCT FROM partner) THEN
    RAISE EXCEPTION 'a pair is mutual: another measure names % as its pair, and % does not name it back', NEW.id, NEW.id
      USING ERRCODE = '23514', CONSTRAINT = 'goal_metrics_pair_mutual';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER goal_metrics_pair_mutual
  AFTER INSERT OR UPDATE OF paired_metric_id ON goal_metrics
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.goal_metrics_pair_is_mutual();
