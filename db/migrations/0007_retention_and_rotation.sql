-- Phase 3: retention (F11.5), secret rotation (F12.3), audit export (F11.6).

-- ---------------------------------------------------------------------------
-- Retention (F11.5)
--
-- Events and traces are kept at least 12 months, full prompts at least 90
-- days, both configurable. The two windows differ because they hold different
-- risk: a trace row says a call happened and what it cost, while the prompt
-- inside it may hold a customer's message. Prompts are therefore scrubbed
-- long before the trace itself is removed, which keeps the cost and audit
-- history intact while shrinking the sensitive surface.
-- ---------------------------------------------------------------------------
CREATE TABLE retention_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,
  event_days    integer NOT NULL DEFAULT 400,
  trace_days    integer NOT NULL DEFAULT 400,
  prompt_days   integer NOT NULL DEFAULT 90,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_one_per_scope UNIQUE (company_id),
  -- The PRD states these as floors, so a configuration below them is a
  -- misconfiguration rather than a preference.
  CONSTRAINT retention_events_at_least_twelve_months CHECK (event_days >= 365),
  CONSTRAINT retention_traces_at_least_twelve_months CHECK (trace_days >= 365),
  CONSTRAINT retention_prompts_at_least_ninety_days CHECK (prompt_days >= 90),
  -- Scrubbing a prompt after its trace is gone would be a no-op.
  CONSTRAINT retention_prompts_expire_first CHECK (prompt_days <= trace_days)
);
-- As with alert_thresholds: UNIQUE does not constrain NULLs, so "at most one
-- platform default" needs a partial unique index to actually hold.
CREATE UNIQUE INDEX retention_policies_single_platform_row
  ON retention_policies ((company_id IS NULL)) WHERE company_id IS NULL;

INSERT INTO retention_policies (company_id) VALUES (NULL);
SELECT app.enable_shared_scope_rls('retention_policies');

-- Append-only record of what retention removed.
--
-- Deleting history is the one operation that can make the event log lie by
-- omission, so the deletion itself is history. Without this, "there are no
-- events from March" and "March was quiet" are indistinguishable.
CREATE TABLE retention_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action      text NOT NULL,
  rows_affected integer NOT NULL,
  through_at  timestamptz NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT retention_action_known
    CHECK (action IN ('events_purged', 'traces_purged', 'prompts_scrubbed'))
);
ALTER TABLE retention_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retention_log
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT ON retention_log TO palugada_app;
GRANT SELECT, INSERT ON retention_log TO palugada_admin;

CREATE TRIGGER retention_log_append_only
  BEFORE UPDATE OR DELETE ON retention_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------
-- The one sanctioned way to delete an event
--
-- The append-only rule stands: corrections are new events, and nothing in the
-- application can remove one. Retention is the single exception the PRD
-- requires, and it is narrowed until it cannot be repurposed:
--
--   - it only applies inside an explicit purge, marked by a session setting
--     that the control plane sets and clears around the operation;
--   - it only applies to rows already past the configured retention window,
--     checked here against the row rather than trusted from the caller.
--
-- So a caller who sets the flag still cannot delete this morning's events, and
-- a caller who wants to delete last year's still has to say so explicitly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.retention_window_days(
  target_company uuid, which text
) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT CASE which
           WHEN 'event' THEN event_days
           WHEN 'trace' THEN trace_days
           WHEN 'prompt' THEN prompt_days
         END
    FROM retention_policies
   WHERE company_id = target_company OR company_id IS NULL
   ORDER BY company_id NULLS LAST
   LIMIT 1
$$;

CREATE OR REPLACE FUNCTION app.reject_mutation_except_retention() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE window_days integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION '% is append-only; correct it by writing a new row', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;

  IF coalesce(current_setting('app.retention_purge', true), 'off') <> 'on' THEN
    RAISE EXCEPTION '% is append-only; deletion is only possible during a retention purge',
      TG_TABLE_NAME USING ERRCODE = '42501';
  END IF;

  window_days := app.retention_window_days(OLD.company_id, 'event');

  -- Fail closed. With no policy configured the window is NULL, and comparing
  -- against NULL yields NULL rather than true -- so the guard below would
  -- simply not fire and every event would be deletable. A missing
  -- configuration must forbid deletion, not permit it.
  IF window_days IS NULL THEN
    RAISE EXCEPTION
      'no retention policy is configured; refusing to purge events'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.occurred_at > now() - make_interval(days => window_days) THEN
    RAISE EXCEPTION
      'refusing to purge an event from % which is inside the % day retention window',
      OLD.occurred_at, window_days
      USING ERRCODE = '42501';
  END IF;

  RETURN OLD;
END $$;

DROP TRIGGER events_append_only ON events;
CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation_except_retention();

-- The control plane needs DELETE for retention to be possible at all; the
-- trigger above is what makes it safe. The application role is deliberately
-- still not granted it, so an agent cannot even attempt to remove history --
-- two independent barriers rather than one.
GRANT DELETE ON events TO palugada_admin;

-- ---------------------------------------------------------------------------
-- Secret rotation (F12.3)
--
-- The application stores a reference, so rotating the value behind it is the
-- secret manager's business -- but a process that cached the old value would
-- keep using it, which is a restart in all but name. The version column is the
-- invalidation signal: it is part of the cache key, so bumping it makes the
-- next resolution a miss without any process needing to be told.
-- ---------------------------------------------------------------------------
ALTER TABLE credentials
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN rotated_at timestamptz,
  ADD CONSTRAINT credentials_version_positive CHECK (version >= 1);
