-- ---------------------------------------------------------------------------
-- The application role may write what the platform's own code writes
--
-- `enable_tenant_rls` granted the application role SELECT, INSERT, UPDATE and
-- DELETE on every tenant table, and row security narrowed that to one
-- company. Within the company, though, it could do anything to anything:
-- clear its own company's freeze, raise its own budget ceilings, rewrite or
-- delete the model traces its monthly spend is summed from, delete history.
-- None of that is something the code does -- freezing, ceilings and
-- retention all go through the control plane -- so the grants said more
-- than the platform means.
--
-- Established from what the code actually writes, by logging every statement
-- the application role ran across the whole suite and reading each write path
-- in the source, then narrowed to that:
--
--   - `companies`: read only. A company is created, frozen and unfrozen on
--     the control plane.
--   - `llm_traces`, `decision_records`: written once, never changed. A trace
--     is what a call cost and a decision record is what a reviewer said; the
--     retention purge that ages them out runs on the control plane.
--   - `budget_accounts`: the running totals only -- what was spent, what is
--     reserved -- which is what the budget functions move. The ceilings are
--     the owner's.
--   - DELETE: on `capability_grants` alone, which is how a grant is revoked.
--     Nothing else the application writes is ever deleted by it.
--
-- And `enable_tenant_rls` stops granting DELETE, so a table added later does
-- not inherit a privilege nobody decided it needed.
-- ---------------------------------------------------------------------------

REVOKE INSERT, UPDATE, DELETE ON companies FROM palugada_app;

REVOKE UPDATE, DELETE ON llm_traces, decision_records FROM palugada_app;

REVOKE UPDATE ON budget_accounts FROM palugada_app;
GRANT UPDATE (tokens_spent, tokens_reserved, money_spent_cents) ON budget_accounts TO palugada_app;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN
    SELECT (quote_ident(table_schema) || '.' || quote_ident(table_name))::regclass
      FROM information_schema.role_table_grants
     WHERE grantee = 'palugada_app' AND privilege_type = 'DELETE'
       AND table_schema = 'public' AND table_name <> 'capability_grants'
  LOOP
    EXECUTE format('REVOKE DELETE ON %s FROM palugada_app', target);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION app.enable_tenant_rls(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s'
    ' USING (company_id = app.current_company_id())'
    ' WITH CHECK (company_id = app.current_company_id())', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO palugada_app', target);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %s TO palugada_admin', target);
END $$;
