-- The owner's headline metric, and funnel steps on measures (F18.13).
--
-- The portfolio judges each company by one number, and that number was
-- always inferred: the first measure on the highest active goal. A company
-- run by the methods STATUS 2.189 adopts names the one number it is judged by
-- (after Ellis's north star), and the owner is who names it. So a company
-- records the owner's choice, and the inference is what is shown only while
-- there is none.
--
-- headline_metric_id: the measure the owner chose. A composite key to
-- goal_metrics on (company_id, id), so a company cannot be judged by another
-- company's number, which lets go when the measure is deleted -- and with it,
-- when its goal is. The application role cannot write companies (0047): an
-- agent that could choose the number its company is judged by could choose
-- one it is already meeting.
--
-- The headline is progress from a baseline to a target. A retired measure is
-- history (0069), and a line on the weekly scorecard (0137) has a weekly goal
-- rather than a target, so neither may be chosen; a chosen measure that is
-- retired or put on the scorecard lets go of the headline in the same
-- statement, and the portfolio goes back to inferring it.
--
-- funnel_step: the step of McClure's funnel a measure counts, in his order --
-- acquisition, activation, retention, referral, revenue -- or NULL for a
-- measure that is not a funnel number. A check rather than an enum, as
-- review_every is. The application role still only reads goal_metrics (0053).
--
-- Adding a foreign key reads every row of both tables to check it, which
-- forced row security refuses the tables' owner without a tenant: lifted for
-- this transaction and put back before it ends (as 0048, 0135 and 0137).
ALTER TABLE companies NO FORCE ROW LEVEL SECURITY;
ALTER TABLE goal_metrics NO FORCE ROW LEVEL SECURITY;

ALTER TABLE companies
  ADD COLUMN headline_metric_id uuid,
  ADD CONSTRAINT companies_headline_metric_fkey
    FOREIGN KEY (id, headline_metric_id) REFERENCES goal_metrics (company_id, id) ON DELETE SET NULL (headline_metric_id);

ALTER TABLE goal_metrics
  ADD COLUMN funnel_step text,
  ADD CONSTRAINT goal_metrics_funnel_step_known
    CHECK (funnel_step IN ('acquisition', 'activation', 'retention', 'referral', 'revenue'));

ALTER TABLE goal_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;

-- The key is checked on every delete of a measure; without an index on the
-- referencing side that is a scan of every company.
CREATE INDEX companies_headline_metric_idx ON companies (headline_metric_id) WHERE headline_metric_id IS NOT NULL;

CREATE FUNCTION app.headline_is_a_target() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chosen record;
BEGIN
  SELECT slug, retired_at IS NOT NULL AS retired, review_every IS NOT NULL AS weekly INTO chosen
    FROM goal_metrics WHERE company_id = NEW.id AND id = NEW.headline_metric_id;
  -- Not found is the key's to refuse, with its own name.
  IF FOUND AND chosen.retired THEN
    RAISE EXCEPTION 'the measure % is retired; the headline is a measure that is still measured', chosen.slug
      USING ERRCODE = '23514', CONSTRAINT = 'companies_headline_is_a_target';
  END IF;
  IF FOUND AND chosen.weekly THEN
    RAISE EXCEPTION 'the measure % is a line on the weekly scorecard, whose goal is weekly; the headline is a measure aimed at a target', chosen.slug
      USING ERRCODE = '23514', CONSTRAINT = 'companies_headline_is_a_target';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER companies_headline_is_a_target
  BEFORE INSERT OR UPDATE OF headline_metric_id ON companies
  FOR EACH ROW WHEN (NEW.headline_metric_id IS NOT NULL)
  EXECUTE FUNCTION app.headline_is_a_target();

CREATE FUNCTION app.headline_lets_go() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE companies SET headline_metric_id = NULL WHERE id = NEW.company_id AND headline_metric_id = NEW.id;
  RETURN NULL;
END $$;

CREATE TRIGGER goal_metrics_headline_lets_go
  AFTER UPDATE OF retired_at, review_every ON goal_metrics
  FOR EACH ROW WHEN (NEW.retired_at IS NOT NULL OR NEW.review_every IS NOT NULL)
  EXECUTE FUNCTION app.headline_lets_go();
