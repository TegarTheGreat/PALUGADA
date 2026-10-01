-- A project may have its own work language.
--
-- One company often sells in more than one market: a project for Malaysia
-- writes its customers' copy in Malay and a project for Brazil in Brazilian
-- Portuguese, while the company's agents still talk to its owner in one
-- language. So the work language -- what is produced for customers -- may be
-- set per project, and overrides the company's (0052) for work done in that
-- project. Talk stays the company's: there is one owner to talk to.
--
-- NULL is the common case and means the company's work language, and the
-- deployment's default under that. The check is the one `companies` has, on
-- the shape of a tag rather than a list, for the same reason: the languages
-- offered live in src/domain/language.ts and grow without a migration.
--
-- No grant: the application role writes projects with the table's own
-- SELECT, INSERT and UPDATE (enable_tenant_rls, narrowed by 0047 only for
-- other tables), and those cover a new column.

ALTER TABLE projects
  ADD COLUMN work_language text,
  ADD CONSTRAINT projects_work_language_tag
    CHECK (work_language IS NULL OR work_language ~ '^[a-z]{2,3}(-[A-Z]{2})?$');
