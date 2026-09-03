-- ---------------------------------------------------------------------------
-- Writing a config version from tenant scope (PRD v2 F3.9)
--
-- 0027 revoked the application role's access to `config_versions`, reasoning
-- that an agent which could write a version could manufacture one to roll back
-- to. That was right about the danger and wrong about the remedy: the two paths
-- that apply an owner-approved change to a grant or a role run in tenant scope,
-- and the version has to be written in the *same transaction* as the change —
-- otherwise a rolled-back change can leave a version behind, and the history
-- claims something happened that did not.
--
-- So the grant comes back as SELECT and INSERT, and no more. That is the same
-- shape `events` has, for the same reason: append-only is the property that
-- matters. An agent can add to the history and cannot rewrite it, cannot remove
-- from it, and — through the WITH CHECK below — cannot write a platform-scoped
-- version at all, which is the one that would let it forge something outranking
-- its own company.
-- ---------------------------------------------------------------------------

CREATE POLICY tenant_insert ON config_versions FOR INSERT
  WITH CHECK (company_id = app.current_company_id());

GRANT SELECT, INSERT ON config_versions TO palugada_app;
