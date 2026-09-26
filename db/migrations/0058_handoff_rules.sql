-- ---------------------------------------------------------------------------
-- A task works in its role's division, and the owner chains roles
--
-- A task names its division and its role separately, and nothing said they
-- agree. The broker judges a call by the task's division -- its grants, its
-- policies -- so a task for a reviewer filed under the content division would
-- act with the content division's grants, and F7.3's reviewer, whose division
-- holds nothing on purpose, could publish. The handoff engine did exactly
-- that: it filed each successor under the predecessor's division.
--
-- tasks_role_in_its_division: the pair must be a role and the division it is
-- in. NOT VALID, so a deployment whose history holds a mismatched row still
-- migrates; every row written from here on is checked.
--
-- handoff_rules: "when this role finishes, that role takes over, with this
-- brief". Handoffs were rules in code that a deployment had to compose, and
-- the one a deployment starts has none, so no work followed on from other
-- work unless an agent delegated it. The owner's, like triggers and
-- schedules: the application role reads them and cannot write them.
-- ---------------------------------------------------------------------------

ALTER TABLE roles ADD CONSTRAINT roles_division_scoped_key UNIQUE (company_id, division_id, id);

ALTER TABLE tasks ADD CONSTRAINT tasks_role_in_its_division
  FOREIGN KEY (company_id, division_id, role_id) REFERENCES roles (company_id, division_id, id)
  NOT VALID;

CREATE TABLE handoff_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_role_id  uuid NOT NULL,
  to_role_id    uuid NOT NULL,
  -- What the successor is to do with what it is handed, as its brief.
  brief         text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, from_role_id, to_role_id),
  CONSTRAINT handoff_rules_company_scoped_key UNIQUE (company_id, id),
  CONSTRAINT handoff_rules_from_fkey
    FOREIGN KEY (company_id, from_role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  CONSTRAINT handoff_rules_to_fkey
    FOREIGN KEY (company_id, to_role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  CONSTRAINT handoff_rules_not_to_itself CHECK (from_role_id <> to_role_id),
  CONSTRAINT handoff_rules_brief_sane CHECK (length(btrim(brief)) BETWEEN 1 AND 2000)
);

SELECT app.enable_tenant_rls('handoff_rules');
REVOKE INSERT, UPDATE, DELETE ON handoff_rules FROM palugada_app;
