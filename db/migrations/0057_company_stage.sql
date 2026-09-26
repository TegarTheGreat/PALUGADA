-- ---------------------------------------------------------------------------
-- Where a company is in its life
--
-- auto-company runs every idea through the same gates -- explore, validate
-- (a GO or NO-GO on evidence), build, launch, grow, and wind down when it is
-- not working -- and nothing here said which of those a company was in. So no
-- policy could hold a company that had proved nothing back from buying reach,
-- and no run was told that this month's job is finding out whether anyone
-- will pay rather than shipping features.
--
-- stage: NULL until the owner sets one, which is what every company made
-- before this migration has; a stage policy compares against it and a NULL
-- matches no `in` list, so nothing a stage policy allows is allowed to a
-- company with no stage. The application role cannot write companies (0047),
-- so a run cannot move it: a run proposes, and the owner decides.
-- ---------------------------------------------------------------------------

ALTER TABLE companies
  ADD COLUMN stage text,
  ADD CONSTRAINT companies_stage_known
    CHECK (stage IS NULL OR stage IN ('explore', 'validate', 'build', 'launch', 'grow', 'wind_down'));
