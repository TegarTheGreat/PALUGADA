-- Event log, LLM traces, owner inbox and governance (PRD F3, F7, F10, F11).


-- ---------------------------------------------------------------------------
-- Event log (PRD section 7.4, F11.1)
--
-- "Event tidak pernah diubah atau dihapus" -- corrections are made by writing
-- a new event. That is enforced twice: the application role is never granted
-- UPDATE or DELETE, and a trigger rejects them even if a grant is added by
-- mistake later. Defence in depth, because an append-only log that can be
-- quietly rewritten is worth very little during an incident review.
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES tasks(id) ON DELETE CASCADE,
  type        text NOT NULL,
  actor       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  trace_id    text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_type_not_blank CHECK (length(type) > 0)
);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON events
  USING (company_id = app.current_company_id())
  WITH CHECK (company_id = app.current_company_id());
GRANT SELECT, INSERT ON events TO palugada_app;
GRANT SELECT, INSERT ON events TO palugada_admin;

CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; correct it by writing a new row', TG_TABLE_NAME
    USING ERRCODE = '42501';
END $$;

CREATE TRIGGER events_append_only
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

CREATE INDEX events_task_idx ON events (task_id, occurred_at);
CREATE INDEX events_type_idx ON events (company_id, type, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- LLM traces (F11.1)
--
-- Prompt and response are stored separately from the event log because they
-- have a shorter retention (F11.5: >= 90 days versus >= 12 months) and are the
-- most sensitive rows in the system.
-- ---------------------------------------------------------------------------
CREATE TABLE llm_traces (
  id              text PRIMARY KEY,
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id         uuid REFERENCES tasks(id) ON DELETE CASCADE,
  agent_run_id    uuid REFERENCES agent_runs(id) ON DELETE CASCADE,
  model           text NOT NULL,
  prompt          jsonb NOT NULL,
  response        jsonb,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  cost_cents      integer NOT NULL DEFAULT 0,
  latency_ms      integer,
  occurred_at     timestamptz NOT NULL DEFAULT now()
);
SELECT app.enable_tenant_rls('llm_traces');
CREATE INDEX llm_traces_task_idx ON llm_traces (task_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Owner inbox (F10.1, F10.2, F10.4)
-- ---------------------------------------------------------------------------
CREATE TABLE inbox_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  status        text NOT NULL DEFAULT 'open',

  -- F10.2: what will happen, why, at which tier, at what cost, and what
  -- follows from a refusal. Stored as columns rather than free text so the
  -- mobile inbox can render a decision without an LLM in the loop.
  title             text NOT NULL,
  action_summary    text NOT NULL,
  rationale         text NOT NULL,
  tier              smallint,
  estimated_cost_cents integer NOT NULL DEFAULT 0,
  consequence_if_denied text NOT NULL DEFAULT '',
  capability_name   text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- F10.4: an unanswered approval expires into a cancellation, never into an
  -- execution. Silence must be the safe outcome.
  expires_at    timestamptz,
  decision      text,
  decided_at    timestamptz,
  owner_note    text,
  created_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inbox_kind_known CHECK (kind IN (
    'approval', 'escalation', 'incident', 'sop_candidate', 'budget_alert')),
  CONSTRAINT inbox_status_known CHECK (status IN ('open', 'decided', 'expired')),
  CONSTRAINT inbox_decision_known
    CHECK (decision IS NULL OR decision IN ('approve', 'deny', 'ask')),
  CONSTRAINT inbox_tier_range CHECK (tier IS NULL OR tier BETWEEN 0 AND 3),
  CONSTRAINT inbox_decided_has_decision
    CHECK (status <> 'decided' OR (decision IS NOT NULL AND decided_at IS NOT NULL))
);
SELECT app.enable_tenant_rls('inbox_items');
CREATE INDEX inbox_open_idx ON inbox_items (company_id, status, created_at);

-- ---------------------------------------------------------------------------
-- Governance: charter, policy, decision records (F3, F7)
-- ---------------------------------------------------------------------------
CREATE TABLE charters (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- NULL company_id marks the platform charter, which a company cannot
  -- override (F3.1). It is therefore not tenant-scoped and carries no RLS.
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  version     integer NOT NULL,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, version)
);
SELECT app.enable_shared_scope_rls('charters');

CREATE TABLE policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Scope precedence is platform > company > division (F3.5). NULL company_id
  -- means platform scope; NULL division_id with a company means company scope.
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,
  division_id   uuid REFERENCES divisions(id) ON DELETE CASCADE,
  slug          text NOT NULL,
  -- allow | deny | require_approval | require_review (F3.3)
  effect        text NOT NULL,
  condition     jsonb NOT NULL,
  -- F3.8: evaluate without blocking, to test a new rule against live traffic.
  mode          text NOT NULL DEFAULT 'enforce',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, division_id, slug),
  CONSTRAINT policies_effect_known
    CHECK (effect IN ('allow', 'deny', 'require_approval', 'require_review')),
  CONSTRAINT policies_mode_known CHECK (mode IN ('enforce', 'log_only')),
  CONSTRAINT policies_division_implies_company
    CHECK (division_id IS NULL OR company_id IS NOT NULL)
);
SELECT app.enable_shared_scope_rls('policies');

CREATE TABLE decision_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
  task_id       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  proposal      jsonb NOT NULL,
  critique      jsonb,
  decision      text NOT NULL,
  criteria      text NOT NULL DEFAULT '',
  source_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT decision_records_decision_known
    CHECK (decision IN ('approve', 'revise', 'reject'))
);
SELECT app.enable_tenant_rls('decision_records');

-- ---------------------------------------------------------------------------
-- Memory (PRD section 8.4)
--
-- The metadata required by F4.1 is created here so the execution engine can
-- reference it from the start. Semantic retrieval (F4.2) needs pgvector and an
-- embedding column, which arrive in Phase 1 together with distillation.
-- ---------------------------------------------------------------------------
CREATE TABLE memories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  memory_type     text NOT NULL,
  scope_type      text NOT NULL,
  scope_id        uuid,
  body            text NOT NULL,
  confidence      real NOT NULL DEFAULT 1.0,
  source          text NOT NULL DEFAULT 'unspecified',
  source_event_id uuid REFERENCES events(id) ON DELETE SET NULL,
  shared          boolean NOT NULL DEFAULT false,
  valid_from      timestamptz NOT NULL DEFAULT now(),
  -- F4.3: facts are superseded, never deleted, so "what was true then" stays
  -- answerable alongside "what is true now".
  superseded_by   uuid REFERENCES memories(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT memories_type_known
    CHECK (memory_type IN ('working', 'episodic', 'semantic', 'procedural')),
  CONSTRAINT memories_scope_known
    CHECK (scope_type IN ('agent_run', 'task', 'project', 'division', 'company', 'platform')),
  CONSTRAINT memories_confidence_range CHECK (confidence >= 0 AND confidence <= 1)
);
SELECT app.enable_tenant_rls('memories');
CREATE INDEX memories_live_idx ON memories (company_id, memory_type, scope_type, scope_id)
  WHERE superseded_by IS NULL;

-- ---------------------------------------------------------------------------
-- Platform control (F5.8, F10.7)
--
-- A single row holding the global stop signal. Workers consult it before
-- committing any step, which is what makes "stop everything" bounded by the
-- polling interval rather than by how long a task happens to run.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_control (
  id                    boolean PRIMARY KEY DEFAULT true,
  stop_all_requested_at timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT platform_control_single_row CHECK (id)
);
INSERT INTO platform_control (id) VALUES (true);
GRANT SELECT ON platform_control TO palugada_app;
GRANT SELECT, INSERT, UPDATE ON platform_control TO palugada_admin;
