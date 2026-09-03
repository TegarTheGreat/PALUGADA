-- ---------------------------------------------------------------------------
-- Config versions for platform-scoped configuration (PRD v2 F3.9)
--
-- 0023 made `config_versions` tenant-scoped, which was right for a grant and
-- wrong for the two things that outrank a company: the platform charter (F3.1)
-- and a platform-scoped policy (F3.5). Both already live in tables that mix a
-- NULL company_id with tenant rows, and F3.9's "rollback to any version" is
-- only a single operation if the table it reads from covers every kind of
-- configuration — a rollback that knew six table shapes would be six
-- operations sharing a name.
--
-- So this table joins the same pattern: NULL means platform, every tenant may
-- read it, and only the control plane writes. The application role loses its
-- write grant in the process, which is correct and was an oversight before:
-- a config version is a record of what an owner decided, and an agent that
-- could write one could manufacture a version to roll back to.
-- ---------------------------------------------------------------------------

ALTER TABLE config_versions ALTER COLUMN company_id DROP NOT NULL;

DROP POLICY tenant_isolation ON config_versions;
REVOKE ALL ON config_versions FROM palugada_app;

CREATE POLICY platform_or_tenant_read ON config_versions FOR SELECT
  USING (company_id IS NULL OR company_id = app.current_company_id());
GRANT SELECT ON config_versions TO palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON config_versions TO palugada_admin;

-- The uniqueness the versioning depends on. `UNIQUE (company_id, kind,
-- subject_id, version)` stops distinguishing rows once company_id may be NULL,
-- because NULLs are never equal to each other in a unique index -- so two
-- platform charters could both claim version 1 and the history would silently
-- fork.
-- Dropped as a constraint, not as an index: PostgreSQL owns the index on
-- behalf of the UNIQUE constraint and refuses to let go of it directly.
ALTER TABLE config_versions
  DROP CONSTRAINT IF EXISTS config_versions_company_id_kind_subject_id_version_key;
CREATE UNIQUE INDEX config_versions_identity_idx
  ON config_versions (
    coalesce(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    coalesce(subject_id, '00000000-0000-0000-0000-000000000000'::uuid),
    version
  );
