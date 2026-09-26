-- ---------------------------------------------------------------------------
-- A reference stays inside its company
--
-- Row security keeps a tenant from reading another tenant's rows. It does not
-- keep a row from *pointing* at one: a foreign key is checked by the table's
-- owner, past row security, so `tasks.role_id` accepted any role in the
-- database. An id sent in a request body -- the owner console takes several
-- -- could name another company's role, division, budget account or goal,
-- and the row was stored. The worker then could never run the task (it
-- cannot see the role), so it was claimed, failed, reclaimed and claimed
-- again for as long as anyone let it; and a budget account in another company
-- would have been charged for this one's work.
--
-- Every foreign key between two tenant tables is now on (company_id, id),
-- against a key on the same pair in the table referenced, so a reference to
-- another company's row is refused by the database whatever the code did.
-- The delete behaviour of each is unchanged; a SET NULL clears only the
-- reference, never the company.
--
-- Left as they are: references to `events`, whose size makes a second key on
-- every row the wrong trade for two columns that record where a memory or a
-- decision came from and are never supplied by a request.
--
-- If this migration fails to validate, a row already points into another
-- company, and the error names the constraint.
-- ---------------------------------------------------------------------------

-- Adding a key or a foreign key reads every existing row as the table's
-- owner, and these tables force row security on their owner as well, which
-- refuses the read without a tenant. Lifted for this transaction on exactly
-- the tables that force it, and put back on exactly those before it ends.
CREATE TEMPORARY TABLE forced_row_security ON COMMIT DROP AS
  SELECT oid::regclass AS target FROM pg_class
   WHERE relforcerowsecurity AND relnamespace = 'public'::regnamespace;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s NO FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;

-- Each table another tenant table points at gets a key on (company_id, id),
-- which is what a composite foreign key references.
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE budget_accounts ADD CONSTRAINT budget_accounts_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE divisions ADD CONSTRAINT divisions_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE gateway_devices ADD CONSTRAINT gateway_devices_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE goals ADD CONSTRAINT goals_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE inbox_items ADD CONSTRAINT inbox_items_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE memories ADD CONSTRAINT memories_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE projects ADD CONSTRAINT projects_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE review_requests ADD CONSTRAINT review_requests_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE roles ADD CONSTRAINT roles_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE skills ADD CONSTRAINT skills_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE tasks ADD CONSTRAINT tasks_company_scoped_key UNIQUE (company_id, id);
ALTER TABLE wake_queue ADD CONSTRAINT wake_queue_company_scoped_key UNIQUE (company_id, id);

ALTER TABLE agent_runs
  DROP CONSTRAINT agent_runs_role_id_fkey,
  ADD CONSTRAINT agent_runs_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT agent_runs_task_id_fkey,
  ADD CONSTRAINT agent_runs_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE budget_accounts
  DROP CONSTRAINT budget_accounts_parent_account_id_fkey,
  ADD CONSTRAINT budget_accounts_parent_account_id_fkey
    FOREIGN KEY (company_id, parent_account_id) REFERENCES budget_accounts (company_id, id) ON DELETE CASCADE;

ALTER TABLE capability_grants
  DROP CONSTRAINT capability_grants_division_id_fkey,
  ADD CONSTRAINT capability_grants_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE capability_health
  DROP CONSTRAINT capability_health_division_id_fkey,
  ADD CONSTRAINT capability_health_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE capability_windows
  DROP CONSTRAINT capability_windows_division_id_fkey,
  ADD CONSTRAINT capability_windows_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE credentials
  DROP CONSTRAINT credentials_division_id_fkey,
  ADD CONSTRAINT credentials_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE decision_records
  DROP CONSTRAINT decision_records_project_id_fkey,
  ADD CONSTRAINT decision_records_project_id_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT decision_records_proposer_role_id_fkey,
  ADD CONSTRAINT decision_records_proposer_role_id_fkey
    FOREIGN KEY (company_id, proposer_role_id) REFERENCES roles (company_id, id) ON DELETE SET NULL (proposer_role_id),
  DROP CONSTRAINT decision_records_review_request_id_fkey,
  ADD CONSTRAINT decision_records_review_request_id_fkey
    FOREIGN KEY (company_id, review_request_id) REFERENCES review_requests (company_id, id) ON DELETE SET NULL (review_request_id),
  DROP CONSTRAINT decision_records_reviewer_role_id_fkey,
  ADD CONSTRAINT decision_records_reviewer_role_id_fkey
    FOREIGN KEY (company_id, reviewer_role_id) REFERENCES roles (company_id, id) ON DELETE SET NULL (reviewer_role_id),
  DROP CONSTRAINT decision_records_task_id_fkey,
  ADD CONSTRAINT decision_records_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE divisions
  DROP CONSTRAINT divisions_parent_division_id_fkey,
  ADD CONSTRAINT divisions_parent_division_id_fkey
    FOREIGN KEY (company_id, parent_division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE events
  DROP CONSTRAINT events_project_id_fkey,
  ADD CONSTRAINT events_project_id_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT events_task_id_fkey,
  ADD CONSTRAINT events_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE gateway_challenges
  DROP CONSTRAINT gateway_challenges_device_id_fkey,
  ADD CONSTRAINT gateway_challenges_device_id_fkey
    FOREIGN KEY (company_id, device_id) REFERENCES gateway_devices (company_id, id) ON DELETE CASCADE;

ALTER TABLE gateway_dedupe
  DROP CONSTRAINT gateway_dedupe_device_id_fkey,
  ADD CONSTRAINT gateway_dedupe_device_id_fkey
    FOREIGN KEY (company_id, device_id) REFERENCES gateway_devices (company_id, id) ON DELETE CASCADE;

ALTER TABLE goals
  DROP CONSTRAINT goals_parent_goal_id_fkey,
  ADD CONSTRAINT goals_parent_goal_id_fkey
    FOREIGN KEY (company_id, parent_goal_id) REFERENCES goals (company_id, id) ON DELETE CASCADE;

ALTER TABLE governance_log
  DROP CONSTRAINT governance_log_division_id_fkey,
  ADD CONSTRAINT governance_log_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE inbox_items
  DROP CONSTRAINT inbox_items_task_id_fkey,
  ADD CONSTRAINT inbox_items_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE llm_traces
  DROP CONSTRAINT llm_traces_agent_run_id_fkey,
  ADD CONSTRAINT llm_traces_agent_run_id_fkey
    FOREIGN KEY (company_id, agent_run_id) REFERENCES agent_runs (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT llm_traces_task_id_fkey,
  ADD CONSTRAINT llm_traces_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE memories
  DROP CONSTRAINT memories_superseded_by_fkey,
  ADD CONSTRAINT memories_superseded_by_fkey
    FOREIGN KEY (company_id, superseded_by) REFERENCES memories (company_id, id) ON DELETE SET NULL (superseded_by) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE owner_notifications
  DROP CONSTRAINT owner_notifications_inbox_item_id_fkey,
  ADD CONSTRAINT owner_notifications_inbox_item_id_fkey
    FOREIGN KEY (company_id, inbox_item_id) REFERENCES inbox_items (company_id, id) ON DELETE CASCADE;

ALTER TABLE policies
  DROP CONSTRAINT policies_division_id_fkey,
  ADD CONSTRAINT policies_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE review_requests
  DROP CONSTRAINT review_requests_project_id_fkey,
  ADD CONSTRAINT review_requests_project_id_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT review_requests_proposer_role_id_fkey,
  ADD CONSTRAINT review_requests_proposer_role_id_fkey
    FOREIGN KEY (company_id, proposer_role_id) REFERENCES roles (company_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT review_requests_proposer_task_id_fkey,
  ADD CONSTRAINT review_requests_proposer_task_id_fkey
    FOREIGN KEY (company_id, proposer_task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT review_requests_review_task_id_fkey,
  ADD CONSTRAINT review_requests_review_task_id_fkey
    FOREIGN KEY (company_id, review_task_id) REFERENCES tasks (company_id, id) ON DELETE SET NULL (review_task_id),
  DROP CONSTRAINT review_requests_reviewer_role_id_fkey,
  ADD CONSTRAINT review_requests_reviewer_role_id_fkey
    FOREIGN KEY (company_id, reviewer_role_id) REFERENCES roles (company_id, id) ON DELETE RESTRICT;

ALTER TABLE role_eval_cases
  DROP CONSTRAINT role_eval_cases_role_id_fkey,
  ADD CONSTRAINT role_eval_cases_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT role_eval_cases_source_agent_run_id_fkey,
  ADD CONSTRAINT role_eval_cases_source_agent_run_id_fkey
    FOREIGN KEY (company_id, source_agent_run_id) REFERENCES agent_runs (company_id, id) ON DELETE SET NULL (source_agent_run_id);

ALTER TABLE role_eval_runs
  DROP CONSTRAINT role_eval_runs_role_id_fkey,
  ADD CONSTRAINT role_eval_runs_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE;

ALTER TABLE roles
  DROP CONSTRAINT roles_division_id_fkey,
  ADD CONSTRAINT roles_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE schedules
  DROP CONSTRAINT schedules_budget_account_id_fkey,
  ADD CONSTRAINT schedules_budget_account_id_fkey
    FOREIGN KEY (company_id, budget_account_id) REFERENCES budget_accounts (company_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT schedules_division_id_fkey,
  ADD CONSTRAINT schedules_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT schedules_goal_id_fkey,
  ADD CONSTRAINT schedules_goal_id_fkey
    FOREIGN KEY (company_id, goal_id) REFERENCES goals (company_id, id) ON DELETE SET NULL (goal_id),
  DROP CONSTRAINT schedules_project_id_fkey,
  ADD CONSTRAINT schedules_project_id_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT schedules_role_id_fkey,
  ADD CONSTRAINT schedules_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE;

ALTER TABLE skill_evals
  DROP CONSTRAINT skill_evals_skill_id_fkey,
  ADD CONSTRAINT skill_evals_skill_id_fkey
    FOREIGN KEY (company_id, skill_id) REFERENCES skills (company_id, id) ON DELETE CASCADE;

ALTER TABLE skill_versions
  DROP CONSTRAINT skill_versions_review_request_id_fkey,
  ADD CONSTRAINT skill_versions_review_request_id_fkey
    FOREIGN KEY (company_id, review_request_id) REFERENCES review_requests (company_id, id) ON DELETE SET NULL (review_request_id),
  DROP CONSTRAINT skill_versions_skill_id_fkey,
  ADD CONSTRAINT skill_versions_skill_id_fkey
    FOREIGN KEY (company_id, skill_id) REFERENCES skills (company_id, id) ON DELETE CASCADE;

ALTER TABLE skills
  DROP CONSTRAINT skills_scope_id_fkey,
  ADD CONSTRAINT skills_scope_id_fkey
    FOREIGN KEY (company_id, scope_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE;

ALTER TABLE task_handoffs
  DROP CONSTRAINT task_handoffs_from_task_id_fkey,
  ADD CONSTRAINT task_handoffs_from_task_id_fkey
    FOREIGN KEY (company_id, from_task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT task_handoffs_to_task_id_fkey,
  ADD CONSTRAINT task_handoffs_to_task_id_fkey
    FOREIGN KEY (company_id, to_task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE task_steps
  DROP CONSTRAINT task_steps_task_id_fkey,
  ADD CONSTRAINT task_steps_task_id_fkey
    FOREIGN KEY (company_id, task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE;

ALTER TABLE tasks
  DROP CONSTRAINT tasks_budget_account_id_fkey,
  ADD CONSTRAINT tasks_budget_account_id_fkey
    FOREIGN KEY (company_id, budget_account_id) REFERENCES budget_accounts (company_id, id) ON DELETE RESTRICT,
  DROP CONSTRAINT tasks_division_id_fkey,
  ADD CONSTRAINT tasks_division_id_fkey
    FOREIGN KEY (company_id, division_id) REFERENCES divisions (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT tasks_goal_id_fkey,
  ADD CONSTRAINT tasks_goal_id_fkey
    FOREIGN KEY (company_id, goal_id) REFERENCES goals (company_id, id) ON DELETE SET NULL (goal_id),
  DROP CONSTRAINT tasks_parent_task_id_fkey,
  ADD CONSTRAINT tasks_parent_task_id_fkey
    FOREIGN KEY (company_id, parent_task_id) REFERENCES tasks (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT tasks_project_id_fkey,
  ADD CONSTRAINT tasks_project_id_fkey
    FOREIGN KEY (company_id, project_id) REFERENCES projects (company_id, id) ON DELETE CASCADE,
  DROP CONSTRAINT tasks_role_id_fkey,
  ADD CONSTRAINT tasks_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE RESTRICT;

ALTER TABLE wake_queue
  DROP CONSTRAINT wake_queue_coalesced_into_fkey,
  ADD CONSTRAINT wake_queue_coalesced_into_fkey
    FOREIGN KEY (company_id, coalesced_into) REFERENCES wake_queue (company_id, id) ON DELETE SET NULL (coalesced_into),
  DROP CONSTRAINT wake_queue_role_id_fkey,
  ADD CONSTRAINT wake_queue_role_id_fkey
    FOREIGN KEY (company_id, role_id) REFERENCES roles (company_id, id) ON DELETE CASCADE;

DO $$
DECLARE target regclass;
BEGIN
  FOR target IN SELECT forced_row_security.target FROM forced_row_security LOOP
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
  END LOOP;
END $$;
