-- TRUNCATE is not a way around append-only.
--
-- `events`, `governance_log` and `retention_log` refuse UPDATE and DELETE
-- through a row trigger, and TRUNCATE fires no row trigger: it empties a
-- table without visiting a row. Neither role the platform runs as holds
-- TRUNCATE; the schema owner does, and a TRUNCATE it ran -- typed by mistake,
-- or by a script handed its URL -- emptied the history without a word, where
-- the same rows deleted one by one would have been refused. OpenBot found the
-- same hole in its own audit log.
--
-- The owner could drop the trigger first, so this does not stop an owner who
-- means it. It makes emptying the history something a session has to say it
-- means, with `SET app.allow_truncate = 'on'`, which the test suite's reset
-- does and nothing in the platform does.
CREATE FUNCTION app.reject_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('app.allow_truncate', true), 'off') <> 'on' THEN
    RAISE EXCEPTION '% is append-only; TRUNCATE is refused like DELETE', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER events_refuse_truncate
  BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION app.reject_truncate();
CREATE TRIGGER governance_log_refuse_truncate
  BEFORE TRUNCATE ON governance_log FOR EACH STATEMENT EXECUTE FUNCTION app.reject_truncate();
CREATE TRIGGER retention_log_refuse_truncate
  BEFORE TRUNCATE ON retention_log FOR EACH STATEMENT EXECUTE FUNCTION app.reject_truncate();
