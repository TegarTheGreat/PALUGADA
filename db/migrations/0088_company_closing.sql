-- Closing a company, and erasing it (UU 27/2022 on personal data; the
-- competitive analysis of 2026-09-30, item 11).
--
-- Every table cascades from `companies` except the history, which refuses
-- deletion (0004, 0005, 0007), so the one delete that would have erased a
-- company failed on its first event and a company could never go. Closing
-- freezes it and names a day; on that day every row of it goes, the history
-- included, and one line says it went.
--
-- The database decides whether the history may go, not the caller: a delete
-- of an append-only row is let through only inside an erasure of that very
-- company (a session setting naming it), and only once the company's line
-- in `company_erasures` exists, which it cannot until the company was closed
-- and its grace is over. So a caller who sets the flag early still cannot
-- delete anything, and one who deletes a company that was never closed still
-- fails on its first event.

ALTER TABLE companies
  ADD COLUMN closing_at  timestamptz,
  ADD COLUMN erase_after timestamptz,
  ADD CONSTRAINT companies_closing_whole CHECK ((closing_at IS NULL) = (erase_after IS NULL)),
  -- The least the owner may choose. A mistaken close is found in days, not
  -- minutes, and nothing that erases can be taken back.
  ADD CONSTRAINT companies_closing_grace CHECK (erase_after IS NULL OR erase_after >= closing_at + interval '7 days');

CREATE INDEX companies_erase_after_idx ON companies (erase_after) WHERE erase_after IS NOT NULL;

-- One line per erased company, kept after it: that it was, when it was
-- closed and erased, and how many rows of what went. No row of its own
-- content: its name is the owner's name for their business, kept so the
-- owner can recognise the line.
CREATE TABLE company_erasures (
  company_id  uuid PRIMARY KEY,
  slug        text NOT NULL,
  name        text NOT NULL,
  closed_at   timestamptz NOT NULL,
  erased_at   timestamptz NOT NULL DEFAULT now(),
  counts      jsonb NOT NULL
);
GRANT SELECT, INSERT ON company_erasures TO palugada_admin;

CREATE FUNCTION app.erasure_is_due() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM companies
     WHERE id = NEW.company_id AND erase_after IS NOT NULL AND erase_after <= now()
  ) THEN
    RAISE EXCEPTION 'company % was not closed, or its grace period is not over; it cannot be erased yet',
      NEW.company_id USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER company_erasures_only_when_due
  BEFORE INSERT ON company_erasures
  FOR EACH ROW EXECUTE FUNCTION app.erasure_is_due();
CREATE TRIGGER company_erasures_append_only
  BEFORE UPDATE OR DELETE ON company_erasures
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER company_erasures_refuse_truncate
  BEFORE TRUNCATE ON company_erasures
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_truncate();

-- Whether this session is erasing this company, and may.
CREATE FUNCTION app.erasing(target uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT target IS NOT NULL
     AND coalesce(current_setting('app.erase_company', true), '') = target::text
     AND EXISTS (SELECT 1 FROM company_erasures WHERE company_id = target)
$$;

-- The history's own guards, with the one exception. `reject_mutation` itself
-- is left as it was, for `company_erasures`, which no erasure removes.
CREATE FUNCTION app.reject_mutation_except_erasure() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND app.erasing(OLD.company_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only; correct it by writing a new row', TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;

DROP TRIGGER governance_log_append_only ON governance_log;
CREATE TRIGGER governance_log_append_only
  BEFORE UPDATE OR DELETE ON governance_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation_except_erasure();

DROP TRIGGER retention_log_append_only ON retention_log;
CREATE TRIGGER retention_log_append_only
  BEFORE UPDATE OR DELETE ON retention_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation_except_erasure();

CREATE OR REPLACE FUNCTION app.reject_mutation_except_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE window_days integer;
BEGIN
  IF TG_OP = 'DELETE' AND app.erasing(OLD.company_id) THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only; correct it by writing a new row', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(current_setting('app.retention_purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION '% is append-only; deletion is only possible during a retention purge',
      TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  window_days := app.retention_window_days(OLD.company_id, 'event');

  -- Fail closed: see 0007.
  IF window_days IS NULL THEN
    RAISE EXCEPTION
      'no retention policy is configured; refusing to purge events'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.occurred_at > now() - make_interval(days => window_days) THEN
    RAISE EXCEPTION
      'refusing to purge an event from % which is inside the % day retention window',
      OLD.occurred_at, window_days
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END $$;
