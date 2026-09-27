-- A measure the owner no longer uses is retired, not deleted (0053).
--
-- A metric with a wrong target or one that stopped mattering could not be
-- changed or taken away: its slug is unique, so it could not be made again
-- either, and the wrong number stayed in every run's context and on the
-- portfolio. The owner now corrects a measure in place (its name, target,
-- baseline, direction, due date and source) and retires one that is done
-- with. A retired measure keeps its history for the record and the export,
-- leaves the runs and the headline, and takes no further values -- the
-- database refuses them, so no path that forgets to ask can add one. A value
-- observed before the retirement is still history: a company restored from
-- an archive brings those back.

ALTER TABLE goal_metrics ADD COLUMN retired_at timestamptz;

CREATE FUNCTION app.metric_observations_need_a_live_metric() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM goal_metrics
              WHERE id = NEW.metric_id AND retired_at IS NOT NULL AND NEW.observed_at >= retired_at) THEN
    RAISE EXCEPTION 'metric % is retired and takes no further values', NEW.metric_id
      USING ERRCODE = '23514', CONSTRAINT = 'metric_observations_metric_live';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER metric_observations_metric_live
  BEFORE INSERT ON metric_observations
  FOR EACH ROW EXECUTE FUNCTION app.metric_observations_need_a_live_metric();
