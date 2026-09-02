-- Tenant isolation foundation (PRD F1.2, F1.3, section 7.2).
--
-- Isolation is enforced by PostgreSQL row-level security, not by application
-- code. Every tenant-scoped table carries company_id and is protected by an
-- identical policy installed through app.enable_tenant_rls(), so a table
-- cannot silently ship without protection.


CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO palugada_app, palugada_admin;

-- Returns the tenant the current transaction is scoped to.
--
-- PRD section 7.2 requires that a query without tenant context is *rejected*.
-- A bare current_setting() returns NULL when unset, and `company_id = NULL`
-- merely filters every row away -- that is silent truncation, not rejection,
-- and it hides bugs that later read as "the company has no data". Raising
-- here turns a missing context into a loud failure at the first query.
CREATE OR REPLACE FUNCTION app.current_company_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE raw text;
BEGIN
  raw := current_setting('app.company_id', true);
  IF raw IS NULL OR raw = '' THEN
    RAISE EXCEPTION 'tenant context is not set: app.company_id is required'
      USING ERRCODE = '42501';
  END IF;
  RETURN raw::uuid;
END $$;

COMMENT ON FUNCTION app.current_company_id() IS
  'Active tenant for this transaction; raises 42501 when unset (PRD 7.2).';

-- Installs the standard tenant policy on a table.
--
-- FORCE ROW LEVEL SECURITY matters: without it the table owner is exempt, and
-- since migrations run as the owner it would be easy to believe isolation is
-- working while the application quietly bypasses it. WITH CHECK closes the
-- write side, so a run cannot insert or move a row into another tenant.
CREATE OR REPLACE FUNCTION app.enable_tenant_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s'
    ' USING (company_id = app.current_company_id())'
    ' WITH CHECK (company_id = app.current_company_id())', target);
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO palugada_app', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO palugada_admin', target);
END $$;

-- Installs a policy for tables that mix platform-wide rows with tenant rows,
-- such as charters and policies. A NULL company_id marks a platform row that
-- every tenant must be able to read (F3.2 injects the platform charter into
-- every run; F3.5 applies platform policy everywhere), while a non-NULL
-- company_id is tenant data and stays behind the same boundary as everything
-- else. Writes are reserved for the control plane, so no WITH CHECK is
-- granted to the application role.
CREATE OR REPLACE FUNCTION app.enable_shared_scope_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY platform_or_tenant_read ON %s FOR SELECT'
    ' USING (company_id IS NULL OR company_id = app.current_company_id())', target);
  EXECUTE format('GRANT SELECT ON %s TO palugada_app', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO palugada_admin', target);
END $$;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        text NOT NULL UNIQUE,
  name        text NOT NULL,
  -- F1.4: a frozen company stops every task and every external action.
  frozen_at   timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT companies_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$')
);

-- companies keys on id rather than company_id, so it gets the policy directly
-- instead of through the helper.
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON companies
  USING (id = app.current_company_id())
  WITH CHECK (id = app.current_company_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO palugada_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON companies TO palugada_admin;

CREATE TABLE projects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug)
);
SELECT app.enable_tenant_rls('projects');
