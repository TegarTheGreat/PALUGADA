-- Core processes are owned skills (F18.14; docs/STATUS.md 2.201).
--
-- A company had skills, each reviewed, checked and switched on by the owner,
-- and nothing that said which handful of them are the way the company
-- works, which seat answers for each, or whether anybody follows them. The
-- operating method 2.189 adopts calls them core processes: a few, each kept
-- short, each owned by one seat that keeps it current, and each measured by
-- whether the work follows it.
--
--   core           the owner has named this skill one of the company's core
--                  processes.
--   owner_role_id  the one seat that answers for it, a role of the same
--                  company. A core process has one, and a skill that is not
--                  core has none: a seat on a skill nobody named core would
--                  be an owner of nothing in particular.
--
-- The rest of what makes a skill a core process is the owner's route's
-- (src/skills/core.ts): it is switched on, and its owning seat's division can
-- read it. Neither is a constraint here, because an import replays skills
-- before their versions, and a skill's scope is changed by a path that asks
-- about the core process itself. How many a company has (five to twelve) is
-- a warning, never a refusal.

-- Adding the key reads the tables as their owner, which their forced row
-- security refuses without a tenant: lifted for this transaction and put
-- back (as 0136 and 0139).
ALTER TABLE skills NO FORCE ROW LEVEL SECURITY;
ALTER TABLE roles NO FORCE ROW LEVEL SECURITY;

-- No delete action on the seat: roles are not deleted, only frozen, and a
-- company's delete takes both rows in one statement (as 0136).
ALTER TABLE skills
  ADD COLUMN core boolean NOT NULL DEFAULT false,
  ADD COLUMN owner_role_id uuid,
  ADD CONSTRAINT skills_owner_role_fkey FOREIGN KEY (company_id, owner_role_id)
    REFERENCES roles (company_id, id),
  ADD CONSTRAINT skills_core_has_one_seat CHECK (core = (owner_role_id IS NOT NULL));

ALTER TABLE skills FORCE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;

-- The chart and the quarterly facts list a company's core processes.
CREATE INDEX skills_core ON skills (company_id) WHERE core;

-- Naming a core process and its seat is the owner's, on the control plane.
-- An agent that could mark a skill core, or take one from its seat, could
-- choose which procedures its own division is measured by. The application
-- role held INSERT and UPDATE on the whole table from enable_tenant_rls, so
-- both are narrowed to the columns the skill loop writes: a new skill's
-- name, scope and summary; the active version and the summary it carries;
-- a change of scope; and where an imported skill came from and whether it
-- is quarantined (src/skills/skills.ts, src/bundles/bundle.ts).
REVOKE INSERT, UPDATE ON skills FROM palugada_app;
GRANT INSERT (company_id, slug, scope_type, scope_id, summary) ON skills TO palugada_app;
GRANT UPDATE (summary, active_version, scope_type, scope_id, provenance, origin, quarantined) ON skills TO palugada_app;
