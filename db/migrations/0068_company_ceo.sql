-- Every company has a CEO, and only one: the role the owner talks to.
--
-- Titles came with 0067 as a label. The CEO is more than a label. The owner
-- talks to a company through its CEO -- the conversation on the company's
-- pages is with it, work the owner gives without saying whose goes to it,
-- and a division's trouble reaches it before the owner -- so a company without
-- one has nobody to talk to, and a company with two has an argument about
-- which. The database holds both halves: the unique index refuses a second,
-- and the trigger refuses a company with roles and none, checked when the
-- transaction commits so the title can move from one role to another inside
-- it.
--
-- A company made before titles existed has its coordinator appointed, the
-- role the standard company routes work through; a company without one has
-- its oldest role appointed, which the owner can change in a click.

CREATE TEMPORARY TABLE forced_row_security ON COMMIT DROP AS
  SELECT oid::regclass AS target FROM pg_class
   WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

-- The spelling is the one the console offers; `ceo` and `Ceo` are the same title.
UPDATE roles SET title = 'CEO' WHERE lower(btrim(title)) = 'ceo' AND title <> 'CEO';

UPDATE roles role SET title = 'CEO'
 WHERE role.id IN (
   SELECT DISTINCT ON (candidate.company_id) candidate.id
     FROM roles candidate
    WHERE NOT EXISTS (SELECT 1 FROM roles ceo WHERE ceo.company_id = candidate.company_id AND ceo.title = 'CEO')
    ORDER BY candidate.company_id, (candidate.slug = 'coordinator') DESC, candidate.created_at, candidate.id);

-- A company that already had two roles titled CEO keeps the older.
UPDATE roles role SET title = NULL
 WHERE role.title = 'CEO'
   AND EXISTS (SELECT 1 FROM roles older
                WHERE older.company_id = role.company_id AND older.title = 'CEO'
                  AND (older.created_at, older.id) < (role.created_at, role.id));

CREATE UNIQUE INDEX roles_one_ceo ON roles (company_id) WHERE title = 'CEO';

ALTER TABLE roles ADD CONSTRAINT roles_ceo_spelling
  CHECK (title IS NULL OR lower(btrim(title)) <> 'ceo' OR title = 'CEO');

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

-- Checked at commit, for the company whose role changed. Row security lets
-- a tenant transaction see only its own company's roles, which are the ones
-- this asks about.
CREATE FUNCTION app.company_keeps_its_ceo() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_company uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target_company := OLD.company_id;
  ELSE
    target_company := NEW.company_id;
  END IF;
  IF EXISTS (SELECT 1 FROM roles WHERE company_id = target_company)
     AND NOT EXISTS (SELECT 1 FROM roles WHERE company_id = target_company AND title = 'CEO') THEN
    RAISE EXCEPTION 'a company always has a CEO, and this change leaves company % without one: appoint another role CEO first', target_company
      USING ERRCODE = '23514', CONSTRAINT = 'roles_company_has_a_ceo';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER roles_company_has_a_ceo
  AFTER INSERT OR UPDATE OF title, company_id OR DELETE ON roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.company_keeps_its_ceo();

-- The owner's conversation on a company's pages is with its CEO; the one on
-- every other page is with PALUGADA's assistant, as before (0066).
ALTER TABLE assistant_messages ADD COLUMN company_id uuid REFERENCES companies (id) ON DELETE CASCADE;
CREATE INDEX assistant_messages_company_at ON assistant_messages (company_id, at);
