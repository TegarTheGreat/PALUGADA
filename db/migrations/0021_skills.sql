-- ---------------------------------------------------------------------------
-- Skills and the curated learning loop (PRD v2 F15, F10.1, F4.5)
--
-- Principle 12 splits what an agent is given in two: enforcement lives in
-- hooks, knowledge lives in skills. This is the second half. A skill is an SOP
-- in the open SKILL.md format -- front matter plus a body -- so that the same
-- document is readable by PALUGADA, by Claude Code, and by anything else that
-- has adopted the format (F15.1). Portability is the point: a company's
-- accumulated knowledge should not be hostage to the orchestrator that
-- happened to collect it.
--
-- Three properties the schema, rather than the application, is responsible for.
--
-- **A candidate is not a skill.** Versions carry a state, and only one version
-- of a skill may be active at a time. A distillation job proposing a new
-- version cannot make it live: F15.3 requires adversarial review *and* owner
-- approval, and both are recorded on the version itself.
--
-- **A version cannot be activated without an eval case (F15.4).** A trigger
-- enforces it rather than a code path, because a skill with no eval is a claim
-- nobody has ever checked, and the day someone adds a second activation path
-- is the day a code-level check stops being one.
--
-- **Scope only narrows on its own.** A skill scoped to a division is the
-- division's; widening it to the company or the platform is a structural
-- change, which F15.6 makes a tier 3 action -- the owner's, through the
-- broker, like every other tier 3.
-- ---------------------------------------------------------------------------

CREATE TABLE skills (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  -- F15.6. `scope_id` names the division for a division-scoped skill and is
  -- NULL for the wider two.
  scope_type  text NOT NULL,
  scope_id    uuid REFERENCES divisions(id) ON DELETE CASCADE,
  -- The one-line summary that travels in every context pack (F15.7). Held on
  -- the skill rather than the version so that a run's context does not change
  -- shape when a candidate is proposed.
  summary     text NOT NULL,
  active_version integer,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT skills_scope_known
    CHECK (scope_type IN ('division', 'company', 'platform')),
  CONSTRAINT skills_division_scope_names_one
    CHECK ((scope_type = 'division') = (scope_id IS NOT NULL)),
  CONSTRAINT skills_summary_is_short CHECK (length(summary) BETWEEN 1 AND 400)
);
SELECT app.enable_tenant_rls('skills');

CREATE TABLE skill_versions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  -- F15.1: the document as it would be written to disk, front matter and all.
  -- Stored whole rather than shredded into columns so that exporting a skill
  -- is a copy rather than a rendering, and so that a field the format gains
  -- next year does not need a migration to survive a round trip.
  body        text NOT NULL,
  -- F15.2: who wrote it and what changed.
  author      text NOT NULL,
  changelog   text NOT NULL,
  state       text NOT NULL DEFAULT 'candidate',
  -- F15.3: both gates, recorded where the version is, so "why is this live"
  -- is answerable from one row.
  review_request_id uuid REFERENCES review_requests(id) ON DELETE SET NULL,
  reviewed_at   timestamptz,
  approved_at   timestamptz,
  activated_at  timestamptz,
  rejected_reason text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version),
  CONSTRAINT skill_versions_state_known
    CHECK (state IN ('candidate', 'rejected', 'approved', 'active', 'superseded')),
  CONSTRAINT skill_versions_author_known
    CHECK (author IN ('owner', 'distillation', 'agent', 'bundle')),
  -- F15.3 in the schema: an active version has passed both gates. A code path
  -- that sets `state = 'active'` without them is refused here rather than
  -- discovered later.
  CONSTRAINT skill_versions_active_passed_both_gates
    CHECK (state <> 'active' OR (reviewed_at IS NOT NULL AND approved_at IS NOT NULL))
);
SELECT app.enable_tenant_rls('skill_versions');
CREATE UNIQUE INDEX skill_versions_one_active_idx
  ON skill_versions (skill_id) WHERE state = 'active';

-- F15.4, F15.5. An eval case is an input and the expectation it is judged
-- against. `expect_contains` is deliberately crude: the point of F15.4 is that
-- somebody wrote down what the skill is supposed to achieve, and a check that
-- can be read by a person is worth more here than one that cannot.
CREATE TABLE skill_evals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_id    uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  name        text NOT NULL,
  input       jsonb NOT NULL,
  expect_contains text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, name)
);
SELECT app.enable_tenant_rls('skill_evals');

-- F15.4 as a trigger rather than a code path: a version cannot become active
-- for a skill that has no eval case. Written as a trigger because "cannot be
-- activated" has to hold for every writer, including the one somebody adds
-- next year without reading this file.
CREATE OR REPLACE FUNCTION app.skill_activation_requires_an_eval() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state = 'active'
     AND NOT EXISTS (SELECT 1 FROM skill_evals WHERE skill_id = NEW.skill_id) THEN
    RAISE EXCEPTION
      'skill % cannot be activated: it has no eval case, so nothing has ever checked what it claims (PRD F15.4)',
      NEW.skill_id;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skill_versions_require_an_eval
  BEFORE INSERT OR UPDATE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION app.skill_activation_requires_an_eval();

-- F10.1 names two inbox kinds this repository did not have. `sop_candidate`
-- was v1's name for the first; it is kept as an accepted value so that items
-- already in an owner's queue do not become unreadable, and the new name is
-- what everything writes from here.
ALTER TABLE inbox_items DROP CONSTRAINT inbox_kind_known;
ALTER TABLE inbox_items ADD CONSTRAINT inbox_kind_known CHECK (kind IN (
  'approval', 'escalation', 'incident', 'sop_candidate', 'budget_alert',
  'skill_candidate', 'fact_candidate'));
