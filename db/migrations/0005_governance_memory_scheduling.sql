-- Phase 1: charter and policy engine (F3), memory scopes (F4), external and
-- owner windows (F9), durable scheduling (F9.1).

-- pgvector is not a trusted extension, so it is installed by provisioning
-- (scripts/setup-database.sh) under a superuser. Asserting it here turns a
-- missing extension into a message that names the fix, rather than a syntax
-- error on the first `vector` column.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION
      'pgvector is not installed in this database. Run: npm run db:setup';
  END IF;
END $$;

-- A company's own zone, used for the hour_local fact in policy conditions
-- (F3.4) and as the default for its capability windows. The owner's zone is
-- separate and lives on platform_control: a company's business hours and the
-- hours its owner is awake are different questions.
ALTER TABLE companies ADD COLUMN timezone text NOT NULL DEFAULT 'UTC';

-- ---------------------------------------------------------------------------
-- Policy precedence (F3.5)
--
-- "Lapis bawah hanya bisa memperketat, tidak melonggarkan." That needs a total
-- order over effects, so strictness is a function rather than a convention
-- scattered across the code.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.policy_strictness(effect text) RETURNS smallint
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE effect
    WHEN 'allow'            THEN 0
    WHEN 'require_review'   THEN 1
    WHEN 'require_approval' THEN 2
    WHEN 'deny'             THEN 3
  END::smallint
$$;

COMMENT ON FUNCTION app.policy_strictness(text) IS
  'Total order over policy effects; higher is stricter (PRD F3.5).';

-- Refuses a lower-scope policy that would loosen a rule of the same name
-- defined above it.
--
-- F3.5 is checked twice on purpose. Here, at write time, so a bad
-- configuration is rejected when it is saved rather than when it is first
-- relied upon; and again at evaluation time, where the strictest matching
-- effect wins. A single check would be enough only if no policy could ever be
-- inserted by another path.
CREATE OR REPLACE FUNCTION app.policies_forbid_loosening() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE stricter record;
BEGIN
  -- Platform scope has nothing above it.
  IF NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT p.effect, p.company_id, p.division_id INTO stricter
    FROM policies p
   WHERE p.slug = NEW.slug
     AND p.id IS DISTINCT FROM NEW.id
     -- Only scopes strictly above this one.
     AND (p.company_id IS NULL
          OR (p.company_id = NEW.company_id
              AND p.division_id IS NULL
              AND NEW.division_id IS NOT NULL))
     AND app.policy_strictness(p.effect) > app.policy_strictness(NEW.effect)
   ORDER BY app.policy_strictness(p.effect) DESC
   LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'policy % cannot be loosened to % here: a broader scope already sets % (PRD F3.5)',
      NEW.slug, NEW.effect, stricter.effect
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER policies_forbid_loosening
  BEFORE INSERT OR UPDATE ON policies
  FOR EACH ROW EXECUTE FUNCTION app.policies_forbid_loosening();

-- ---------------------------------------------------------------------------
-- Governance audit (F3.6)
--
-- Charter and policy edits are owner-only and must be recorded with a diff.
-- They live in their own append-only table rather than in `events` because a
-- platform-scope edit belongs to no company, and `events.company_id` is
-- deliberately NOT NULL. Company-scope edits are additionally mirrored into
-- that company's event stream so they appear on its timeline.
-- ---------------------------------------------------------------------------
CREATE TABLE governance_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject     text NOT NULL,
  subject_id  uuid,
  company_id  uuid REFERENCES companies(id) ON DELETE CASCADE,
  division_id uuid REFERENCES divisions(id) ON DELETE CASCADE,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  actor       text NOT NULL DEFAULT 'owner',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_subject_known CHECK (subject IN ('charter', 'policy')),
  CONSTRAINT governance_action_known CHECK (action IN ('created', 'updated', 'deleted'))
);
-- Protected twice over. The row-level policy keeps one tenant's charter and
-- policy diffs away from another even if a grant is added later; withholding
-- the grant means no agent code path can read the audit trail today. A log of
-- who changed the rules is an owner artifact, not working material for the
-- agents those rules constrain.
ALTER TABLE governance_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE governance_log FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_or_tenant_read ON governance_log FOR SELECT
  USING (company_id IS NULL OR company_id = app.current_company_id());
GRANT SELECT, INSERT ON governance_log TO palugada_admin;

CREATE TRIGGER governance_log_append_only
  BEFORE UPDATE OR DELETE ON governance_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------
-- Semantic memory (F4.1, F4.2, F4.3)
-- ---------------------------------------------------------------------------

-- The dimension is a deployment decision tied to the embedding model, and
-- changing it is a migration. `embedding_model` is stored alongside because
-- vectors from different models are not comparable: mixing them in one column
-- produces confident nonsense rather than an error, so retrieval filters on it.
ALTER TABLE memories
  ADD COLUMN embedding vector(1536),
  ADD COLUMN embedding_model text;

ALTER TABLE memories
  ADD CONSTRAINT memories_embedding_needs_model
    CHECK (embedding IS NULL OR embedding_model IS NOT NULL);

-- Deliberately no ANN index yet.
--
-- F4.2 requires the scope filter to run BEFORE the similarity search. An
-- ivfflat or hnsw index inverts that: the planner walks the index for the
-- nearest K and filters afterwards, which silently drops results that were in
-- scope. Exact search keeps the predicate in the WHERE clause where the
-- requirement puts it. This index is the right trade at Phase 1 volumes; at
-- the scale in section 9 it should be revisited with pgvector's iterative
-- scans or per-scope partial indexes, not by bolting on an ANN index and
-- hoping.
CREATE INDEX memories_scope_lookup_idx
  ON memories (company_id, memory_type, scope_type, scope_id)
  WHERE superseded_by IS NULL;

-- ---------------------------------------------------------------------------
-- Waiting on an external window (F9.2)
--
-- The PRD's state diagram in section 8.5 does not list `waiting_window`, but
-- F9.2 names it explicitly: an action outside its permitted hours waits rather
-- than failing. Recorded here as a deliberate extension of the diagram.
-- ---------------------------------------------------------------------------
ALTER TABLE tasks DROP CONSTRAINT tasks_status_known;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_known CHECK (status IN (
  'pending', 'running', 'completed', 'waiting_approval',
  'waiting_review', 'waiting_window', 'failed', 'halted', 'cancelled'));

ALTER TABLE tasks ADD COLUMN wait_until timestamptz;

-- Hours are half-open [start, end) in the stated IANA zone, so a window can
-- cross midnight by having start > end.
CREATE TABLE capability_windows (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  division_id     uuid REFERENCES divisions(id) ON DELETE CASCADE,
  capability_name text NOT NULL REFERENCES capabilities(name) ON DELETE CASCADE,
  timezone        text NOT NULL,
  start_hour      smallint NOT NULL,
  end_hour        smallint NOT NULL,
  days_of_week    smallint[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, division_id, capability_name),
  CONSTRAINT windows_hours_in_range
    CHECK (start_hour BETWEEN 0 AND 23 AND end_hour BETWEEN 0 AND 24),
  CONSTRAINT windows_hours_differ CHECK (start_hour <> end_hour)
);
SELECT app.enable_tenant_rls('capability_windows');

-- ---------------------------------------------------------------------------
-- Owner window (F9.3)
--
-- Non-emergency escalations wait for the owner's waking hours; incidents pass
-- through. The window lives on platform_control because there is exactly one
-- owner (NG3).
-- ---------------------------------------------------------------------------
ALTER TABLE platform_control
  ADD COLUMN owner_timezone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN owner_window_start_hour smallint NOT NULL DEFAULT 8,
  ADD COLUMN owner_window_end_hour smallint NOT NULL DEFAULT 22;

-- When the owner may be notified. Set to now() for anything that may break the
-- window; set to the next opening for everything else.
ALTER TABLE inbox_items ADD COLUMN notify_after timestamptz NOT NULL DEFAULT now();

-- ---------------------------------------------------------------------------
-- Durable scheduling (F9.1)
--
-- Schedules live in the database, not in a process, so a restart loses
-- nothing. `next_run_at` is claimed with a conditional UPDATE, which is what
-- keeps two workers from firing the same schedule twice.
-- ---------------------------------------------------------------------------
CREATE TABLE schedules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id        uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  division_id       uuid NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  role_id           uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  budget_account_id uuid NOT NULL REFERENCES budget_accounts(id) ON DELETE RESTRICT,
  slug              text NOT NULL,
  cron_expression   text NOT NULL,
  timezone          text NOT NULL DEFAULT 'UTC',
  input             jsonb NOT NULL DEFAULT '{}'::jsonb,
  reserve_tokens    bigint NOT NULL DEFAULT 1000,
  enabled           boolean NOT NULL DEFAULT true,
  last_run_at       timestamptz,
  next_run_at       timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, slug),
  CONSTRAINT schedules_reserve_positive CHECK (reserve_tokens > 0)
);
SELECT app.enable_tenant_rls('schedules');
CREATE INDEX schedules_due_idx ON schedules (next_run_at) WHERE enabled;
