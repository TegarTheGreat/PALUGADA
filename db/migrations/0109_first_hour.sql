-- The owner's first hour with a new company (the analysis of 3 October, §9
-- P1 item 10).
--
-- A new company's Overview lists four steps -- tell the CEO what the company
-- does, set what it may spend in a month, give it its first piece of work,
-- see its first result -- each ticked off by what the owner has actually
-- done, until all are done or the owner closes the list.
--
-- `first_hour_closed_at` is the owner closing it. Every company that exists
-- before this migration is past its first hour, so it is closed for them:
-- the list is for a company started from here on.
--
-- `spend_limits.set_at` is when a ceiling was last set by somebody, which is
-- the step "set what it may spend". Without it a company's row could only
-- say a ceiling exists, and a row is also made when the default ceiling is
-- reached and the company paused (M6), which nobody chose.

ALTER TABLE companies ADD COLUMN first_hour_closed_at timestamptz;
ALTER TABLE spend_limits ADD COLUMN set_at timestamptz;

-- Row security is lifted for the update and restored, as 0072 does, because
-- a migration runs as the table's owner and `companies` forces it.
CREATE TEMPORARY TABLE forced_row_security ON COMMIT DROP AS
  SELECT oid::regclass AS target FROM pg_class
   WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace AND relname = 'companies';

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

UPDATE companies SET first_hour_closed_at = now() WHERE first_hour_closed_at IS NULL;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;
