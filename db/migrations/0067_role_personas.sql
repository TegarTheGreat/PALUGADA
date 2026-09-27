-- Who a role is, not only what it does: a name the owner calls it by, a
-- title (CEO, CTO, Head of Support...), and a persona -- a way of thinking
-- taken from src/domain/personas.ts, with the owner's own notes.
--
-- All three are optional: a role without them is its slug, as before. The
-- persona is a style the run is told to work in, never an identity it may
-- claim; context/builder.ts says so in every run that has one.

ALTER TABLE roles ADD COLUMN display_name text;
ALTER TABLE roles ADD COLUMN title text;
ALTER TABLE roles ADD COLUMN persona jsonb;

ALTER TABLE roles ADD CONSTRAINT roles_display_name_shape
  CHECK (display_name IS NULL OR (length(btrim(display_name)) BETWEEN 1 AND 60));
ALTER TABLE roles ADD CONSTRAINT roles_title_shape
  CHECK (title IS NULL OR (length(btrim(title)) BETWEEN 1 AND 60));
ALTER TABLE roles ADD CONSTRAINT roles_persona_object
  CHECK (persona IS NULL OR jsonb_typeof(persona) = 'object');
