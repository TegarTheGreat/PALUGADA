-- A project is more than a label.
--
-- A project could be started and nothing else: not renamed, not described,
-- not closed when its work was done, and nothing a run was given said which
-- project its work was for. `description` is what the project is for, told
-- to every run in it; `archived_at` closes it to new work while what is
-- already under way finishes, and keeps its history.

ALTER TABLE projects ADD COLUMN description text;
ALTER TABLE projects ADD COLUMN archived_at timestamptz;
ALTER TABLE projects ADD CONSTRAINT projects_name_size CHECK (length(name) BETWEEN 1 AND 120) NOT VALID;
ALTER TABLE projects ADD CONSTRAINT projects_description_size CHECK (description IS NULL OR length(description) <= 2000);
