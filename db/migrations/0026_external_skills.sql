-- ---------------------------------------------------------------------------
-- External skills and quarantine (PRD v2 F15.8, F12.10)
--
-- F15.8: a skill from an external Skills Hub may enter only through quarantine.
-- The requirement names F12.10, whose answer for a device or a bundle is "tier
-- 0 only". A skill has no tier — it is a document — so quarantine has to mean
-- something else here, and what it means is scope.
--
-- A quarantined skill may apply to one division and no wider. That is the
-- honest analogue: F12.10's rule is "an unvouched-for thing may not reach past
-- a read", and for knowledge the equivalent of reaching too far is being put
-- in front of every agent in the company. So a quarantined skill is
-- constrained by a trigger rather than by a code path, for the same reason
-- F15.4's eval rule is: a rule that lives in one function stops being a rule
-- the day somebody writes a second one.
--
-- `provenance` is deliberately not derivable from `author`. A skill written by
-- an agent inside this company is `agent`/`internal`; one that arrived from a
-- hub and happens to name an agent as its author is `agent`/`external`, and
-- the second is the one that must not be trusted on its own say-so.
-- ---------------------------------------------------------------------------

ALTER TABLE skills
  ADD COLUMN provenance text NOT NULL DEFAULT 'internal',
  -- Where it came from, when it came from outside. A URL, a hub name, a
  -- catalogue id -- whatever the importer knew, kept so "who wrote this" is
  -- answerable later.
  ADD COLUMN origin text,
  ADD COLUMN quarantined boolean NOT NULL DEFAULT false;

ALTER TABLE skills
  ADD CONSTRAINT skills_provenance_known
    CHECK (provenance IN ('internal', 'external')),
  ADD CONSTRAINT skills_origin_only_when_external
    CHECK (provenance = 'external' OR origin IS NULL);

CREATE OR REPLACE FUNCTION app.quarantined_skills_stay_narrow() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.quarantined AND NEW.scope_type <> 'division' THEN
    RAISE EXCEPTION
      'skill % is quarantined and may apply to one division only, not %; lift the quarantine first (PRD F15.8, F12.10)',
      NEW.slug, NEW.scope_type;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER skills_quarantine_limits_scope
  BEFORE INSERT OR UPDATE ON skills
  FOR EACH ROW EXECUTE FUNCTION app.quarantined_skills_stay_narrow();
