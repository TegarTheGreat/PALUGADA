-- What a seat answers for (F18.3; docs/STATUS.md 2.192).
--
-- A role is a seat with one occupant, and the CEO routed work by the first
-- sentence of each charter: nothing said which seat a result belonged to, so
-- two seats could both believe the renewals were theirs, or neither. Now a
-- role carries a short list of accountabilities, each one line, that every
-- run of it is told and that the CEO reads when it hands work on.
--
-- Five at most: a seat with more answers for nothing in particular, and the
-- operating methods this follows put the same bound on a seat. Each is one
-- line of 1 to 200 characters, a result rather than a procedure. Empty is
-- allowed and is how every role starts: the console names a seat with none
-- rather than the database refusing it, since an owner drawing the chart is
-- halfway through it for a while.
--
-- The count is a CHECK. The shape of each entry is a trigger, because a CHECK
-- cannot iterate over an array's elements. The owner's route trims and
-- bounds the same way first (governance/structure.ts), so this is what holds
-- a write from anywhere else: a bundle, an import, a hand-written statement.
ALTER TABLE roles
  ADD COLUMN accountabilities text[] NOT NULL DEFAULT '{}'
    CONSTRAINT roles_accountabilities_at_most_five CHECK (cardinality(accountabilities) <= 5);

CREATE FUNCTION app.role_accountabilities_are_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  entry text;
BEGIN
  FOREACH entry IN ARRAY NEW.accountabilities LOOP
    IF entry IS NULL OR btrim(entry) = '' THEN
      RAISE EXCEPTION 'an accountability is one line of text; role % was given an empty one', NEW.slug
        USING ERRCODE = '23514', CONSTRAINT = 'roles_accountabilities_shape';
    END IF;
    IF position(E'\n' IN entry) > 0 OR position(E'\r' IN entry) > 0 THEN
      RAISE EXCEPTION 'an accountability is one line; role % was given one over several lines: give each line its own entry', NEW.slug
        USING ERRCODE = '23514', CONSTRAINT = 'roles_accountabilities_shape';
    END IF;
    IF length(entry) > 200 THEN
      RAISE EXCEPTION 'an accountability is one line of at most 200 characters; role % was given one of % characters',
        NEW.slug, length(entry)
        USING ERRCODE = '23514', CONSTRAINT = 'roles_accountabilities_shape';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER roles_accountabilities_shape
  BEFORE INSERT OR UPDATE OF accountabilities ON roles
  FOR EACH ROW EXECUTE FUNCTION app.role_accountabilities_are_lines();
