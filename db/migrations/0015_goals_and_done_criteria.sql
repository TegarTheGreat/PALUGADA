-- Phase 4 (PRD v2): goal ancestry (F2.7), testable completion (F2.8), and
-- strategy as the owner's alone (F3.10).

-- ---------------------------------------------------------------------------
-- F2.7 asks every task to carry the chain that explains it: mission →
-- objective → key result. The chain is the answer to "why is this happening",
-- and F10.2 wants that answer inside the approval item rather than a query
-- away, because an owner deciding on a phone at 07:00 will not go and look.
--
-- The three levels are one table rather than three, because they are the same
-- shape and differ only in what they may hang from. A trigger enforces that:
-- a mission has no parent, an objective hangs from a mission, a key result
-- hangs from an objective. Three tables would have meant three sets of the
-- same constraint and a join to walk two links.
-- ---------------------------------------------------------------------------
CREATE TABLE goals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_goal_id uuid REFERENCES goals(id) ON DELETE CASCADE,
  kind           text NOT NULL,
  slug           text NOT NULL,
  statement      text NOT NULL,
  status         text NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT goals_kind_known CHECK (kind IN ('mission', 'objective', 'key_result')),
  CONSTRAINT goals_status_known CHECK (status IN ('active', 'met', 'abandoned')),
  CONSTRAINT goals_statement_not_blank CHECK (length(btrim(statement)) > 0)
);

CREATE OR REPLACE FUNCTION app.goals_respect_the_ladder() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE parent_kind text; parent_company uuid;
BEGIN
  IF NEW.kind = 'mission' THEN
    IF NEW.parent_goal_id IS NOT NULL THEN
      RAISE EXCEPTION 'a mission is the top of the ladder and has no parent'
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

  RETURN NEW;
END $$;

CREATE TRIGGER goals_respect_the_ladder
  BEFORE INSERT OR UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION app.goals_respect_the_ladder();

-- F3.10: changing strategy is the owner's, so the application role reads goals
-- and never writes them. This is the same shape as the charter: an agent can
-- see what it is working towards and cannot decide it. Enforced by the grant
-- rather than by a rule an agent is asked to follow.
ALTER TABLE goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON goals
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT ON goals TO palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON goals TO palugada_admin;

-- Every task carries one. Nullable in the schema because a sub-task inherits
-- its parent's rather than being given one, and because history written before
-- this column existed cannot be invented; required at admission instead, which
-- is where the caller actually knows the answer.
ALTER TABLE tasks ADD COLUMN goal_id uuid REFERENCES goals(id) ON DELETE SET NULL;
CREATE INDEX tasks_goal ON tasks (goal_id) WHERE goal_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- F2.8: a role cannot be activated without an output schema and at least one
-- completion criterion that can be tested.
--
-- v2 section 2.3 traces a real failure to the absence of exactly this: vague
-- instructions plus an aggressive heartbeat produced a surprise bill, because
-- nothing could tell whether the work was finished. A role that cannot say
-- what "done" looks like will be asked again and again.
-- ---------------------------------------------------------------------------
ALTER TABLE roles ADD COLUMN done_criteria text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN roles.done_criteria IS
  'F2.8: at least one testable statement of what finished looks like. Checked '
  'at admission rather than by a NOT NULL default, so existing rows stay '
  'readable and the failure names the role instead of the column.';
